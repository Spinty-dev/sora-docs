# Архитектура Rust Ядра (Core Layer)

Rust-слой проекта SORA — это вычислительный и сетевой «движок» (Packet Engine), спроектированный для достижения **максимальной производительности, минимальных `O(1)` аллокаций памяти и нулевых потерь (zero-drop)** при обработке 802.11 радио-кадров.

Пока Python-слой занимается логикой, FSM и красивым TUI, задача Rust-ядра — опуститься на уровень сокетов ядра Linux (`AF_PACKET`) и делать грязную работу.

---

## 1. Точка входа: `lib.rs`
Файл `/core/src/lib.rs` связывает Rust-код с Python через библиотеку **PyO3**.
Каждая экспортируемая функция помечена макросом `#[pyfunction]`, что позволяет вызывать Rust-код прямо из Python скрипта (например, `sora.cmd_start_deauth()`).

Здесь инициализируется `PacketEngineHandle` — потокобезопасная обертка `Arc<PacketEngine>`, позволяющая безопасно останавливать движок (`handle.stop()`) или проверять его статус из асинхронного Event Loop в Python.

---

## 2. Abstraction Layer: `core/src/adapter/`

Абстракция над физическим Wi-Fi интерфейсом:
*   **`handle.rs`**: Дескриптор адаптера. Хранит имя интерфейса (`wlan0mon`) и его возможности (Capabilities: `can_inject`, `can_monitor`).
*   **`channel_lock.rs`**: Менеджер атомарных блокировок. Если `AttackController` решает запустить `Deauth` или перехват `WPA3 SAE`, он вызывает `lock_channel(11)`. Rust дает команду `nl80211` остановить Channel Hopping и жестко зафиксироваться на 11-м канале, чтобы ни один кадр не был потерян.
*   **`error_recovery.rs`**: Конечный автомат для восстановления после сбоев. Если физический донгл перегревается или отваливается (`ENODEV`), этот модуль ловит ошибку из сокета и шлет в Python `AdapterError`.

---

## 3. Выжатое из Ядра: `core/src/engine/af_packet.rs`

Чтобы выжать максимальную производительность без `libpcap` оверхеда, мы стучимся напрямую в ядерный сокет Linux:

```rust
// AF_PACKET сокет для прямого доступа к OSI L2 (Data Link)
let fd = socket(
    AddressFamily::Packet,
    SockType::Raw,
    SockFlag::empty(),
    SockProtocol::EthAll, // ETH_P_ALL = 0x0003
);
```
**Разбор кода:**
1.  **`AddressFamily::Packet`**: Мы говорим ядру Linux: "Дай нам всё, что видит сетевая карта, включая не-IP трафик" (802.11 фреймы).
2.  **`libc::if_nametoindex`**: Ядру нужны цифры, а не строки. Конвертируем `wlan0mon` в `ifindex` (например, `4`).
3.  **`libc::bind`**: Привязываем сокет жестко к физической карте интерфейса.

В данном слое реализованы функции `recv()` и `send()`.
*   **Почему `recv` пока блокирующий:** В Phase 1-3 используется стандартный `recv`, так как выделенный тред `PacketEngine` может позволить себе висеть в ожидании блока кадров.
*   **Phase 4 `PACKET_RX_RING`**: Планируется mmap() разделяемой памяти (shared memory buffer) между ядром Linux и userspace SORA. Это уберет syscall на каждый пакет!

---

## 4. Межпроцессное Взаимодействие: `core/src/ipc/`

Разделен на два направления: **События (Rust -> Python)** и **Команды (Python -> Rust)**.

### `events.rs` (Из эфира в UI)
```rust
pub enum SoraEvent {
    EapolFrame { api_version: u8, bssid: String, client: String, step: u8, data: Vec<u8> },
    BeaconFrame { api_version: u8, bssid: String, ssid: String, channel: u8, rssi: i8 },
    AdapterError { api_version: u8, interface: String, error: String },
}
```
События отправляются через `crossbeam_channel` (MPSC). Обычные `PacketEvent` идут в Normal Queue (cap: 512). А вот `EapolFrame` идут в **High-Priority Queue**. Если Python начинает тормозить, Rust сбросит обычные пакеты (счетчик `ipc_drop_count`), но **никогда не дропнет хэндшейк**.

### `commands.rs` (Командирская рубка)
```rust
pub enum SoraCommand {
    Shutdown,
    LockChannel { channel: u8 },
    StartDeauth { bssid: String, client: Option<String>, count: u32, interval_ms: u64 },
}
```
Эти команды кладутся в канал из PyO3 функций. `PacketEngine` читает этот канал **non-blocking** (`try_recv()`) на каждой итерации захвата радиоэфира.

---

## 5. Вывод дампа: `core/src/pcap/writer.rs`
Rust не может позволить себе блокироваться на дисковых операциях ввода-вывода (HDD/SSD).
Поэтому используется паттерн **ArrayQueue Producer-Consumer**:
1. RT-тред ловит `[u8]` фрейм и делает `pcap_writer.enqueue(frame)`.
2. Очередь `crossbeam::ArrayQueue` ёмкостью 4096 фреймов держит кадры в RAM.
3. Отдельный низкоприоритетный `Writer` тред просыпается, забирает пачку из очереди и пишет её в файл `.pcapng` (Enhanced Packet Block).

Если запись на диск тормозит (флешка медленная) — буфер заполнится, и сработает событие `pcap_buffer_overflow`. Пакеты будут дропаться, чтобы предотвратить Out Of Memory (OOM), но Packet Engine **не остановится и не начнет лагать**.
