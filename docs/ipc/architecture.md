# Топология IPC (Inter-Process Communication)

В SORA архитектура взаимодействия между асинхронным Python-циклом (`asyncio`) и высокопроизводительными блокирующими потоками Rust (`std::thread`) построена на основе **Message Passing** (передача сообщений).

В качестве транспорта используются каналы памяти (in-memory MPSC queues) из библиотеки `crossbeam-channel`.

> [!CAUTION]  
> **Strict Compliance Statement**: Перехват и транспортировка сырых пакетов (EAPOL, Probe Requests) в Python-слой производится исключительно для анализа состояния беспроводных WIDS/WIPS сенсоров. Архитектура IPC гарантирует сохранность телеметрии (Zero-Drop policy для критических кадров) в рамках легального аудита.

## 1. Команды (Python ➔ Rust)

Управление движками атаки (Deauth, Channel Hopping, Stealth) происходит через **синхронный PyO3 Command API**. В отличие от асинхронных фреймворков, SORA не требует сложного колбэка: Python напрямую вызывает экспортированную Rust-функцию `#[pyfunction]`.

Чтобы этот вызов не блокировал Event Loop Python (если Rust-ядро занято), функция не выполняет работу сама, а кладет сериализованную команду в MPSC-канал (capacity: **32**):

```rust
// core/src/ipc/commands.rs
#[pyfunction]
#[pyo3(signature = (bssid, client=None, count=5, interval_ms=100))]
pub fn cmd_start_deauth(
    bssid: &str,
    client: Option<&str>,
    count: u32,
    interval_ms: u64,
) -> PyResult<()> {
    let bssid = parse_mac(bssid)?;
    let client = client.map(parse_mac).transpose()?;
    
    // send_command пытается сделать try_send() в Crossbeam MPSC
    send_command(SoraCommand::StartDeauth { bssid, client, count, interval_ms })
}
```

**Backpressure:** Если очередь переполнена, `send_command` мгновенно возвращает Python-ошибку `PyRuntimeError("command queue full")`. Python ловит исключение и повторяет попытку (Retry) позже.

## 2. События (Rust ➔ Python)

Передача сотен и тысяч кадров (`Beacon`, `EAPOL`, логи `AdapterError`) из Rust-ядра в Python требует агрессивной фильтрации.

В `core/src/ipc/events.rs` реализован двухканальный маршрутизатор: `EventChannel`.

### High Priority Channel (Емкость: 64)
Служит для маршрутизации событий, потеря которых разрушит логику аудита:
- **`EapolFrame`**: Все шаги WPA/WPA2 хэндшейка (M1-M4).
- **`AdapterError`**: Критические падения (например, Kernel panic `ath9k`).
- **`EvilTwinReady` / `SaeComplete`**: События перехода автомата состояний Phase 4.

> [!IMPORTANT]  
> **Backpressure:** В случае заполнения этого канала, Rust-поток PacketEngine осознанно **блокируется на 5 миллисекунд** (`send_timeout`), ожидая, пока Python заберет события. Если задержка превышена — событие безвозвратно дропается с логированием WARNING.

### Normal Priority Channel (Емкость: 512)
Трафик, потеря которого не критична:
- **`BeaconFrame`** и **`ProbeRequest`**: Десятки фреймов в секунду.
- **`PcapBufferOverflow`**: Статистика дропов записи PCAP.

**Backpressure:** При переполнении канала, Rust **не блокируется**. Событие уничтожается (`TrySendError::Full`), а атомарный счетчик `drop_count` инкрементируется. TUI интерфейс отображает этот счетчик: если он активно растет, значит Python-слой не успевает "переваривать" трафик (CPU Bottleneck).

## 3. Python Polling

В Python-слое реализована неблокирующая периодическая проверка событий:
```python
# Вызов из AsyncIO Loop каждые N миллисекунд
event_dict = event_receiver.poll_high()
if event_dict is None:
    event_dict = event_receiver.poll_normal()
```
Функции `poll_high()` и `poll_normal()` под капотом вызывают `try_recv()` на соответствующем crossbeam-канале. Это гарантирует отсутствие пауз и зависаний в `asyncio`.
