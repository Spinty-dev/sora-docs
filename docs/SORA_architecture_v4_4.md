# SORA — Signals Offensive Radio Auditor
## Architecture v4.4

> **Changelog vs v4.3:**
> — **TOML дублирование устранено:** `our_channel` и `beacon_interval_tu` — единственные источники истины; `[attack.evil_twin.hostapd]` больше не содержит `channel`/`beacon_int` — `config_manager.py` подставляет их автоматически.
> — **EvilTwinEngine + hostapd разделены по ответственности:** hostapd управляет ассоциацией и отправляет Beacon; `EvilTwinEngine` убран из пути Beacon-инъекции когда hostapd активен. `BeaconCloner` теперь кормит `config_manager.py`, а не `EvilTwinEngine` напрямую. Конфликт SeqNum устранён.
> — **Поведение до первого Beacon зафиксировано:** Evil Twin молчит до получения первого Beacon от цели; Python получает событие `evil_twin_waiting`; таймаут настраивается.
> — **TxDispatch fair drain:** priority очередь дренируется максимум N фреймов за итерацию (дефолт N=8), затем один Normal фрейм — `EvilTwinEngine` не голодает.
> — **Таблица `clients` добавлена в схему SQLite.**
> — **`pcapng_offset` семантика зафиксирована:** byte offset начала pcapng-блока от начала файла.
> — **Privilege drop и привилегированные плагины:** явно описано что `captive_portal` спавнится до drop и наследует root; альтернатива — `sudoers.d` фрагмент.
> — **iptables cleanup исправлен:** точечное удаление через `-D` вместо `-F PREROUTING`.
> — **KarmaEngine фильтрует собственные фреймы:** `src_mac == our_bssid` → drop.
> — **SAEFilter direction detection задокументирован:** определяется по Transmitter Address vs известный BSSID цели.

---

## 1. Цели

| Цель | Решение |
| :--- | :--- |
| Минимальный джиттер при инъекции | Rust RT-потоки, прямые сокеты |
| Нулевые потери хэндшейков | On-the-fly MIC/EAPOL валидация в Rust |
| Гибкость сценариев | Python-контроллер + TOML-профили |
| Изоляция плагинов | Только `process`-режим |
| Поддержка одного и нескольких адаптеров | Adapter Abstraction Layer + Channel Lock → AdapterRegistry (Phase 4) |
| Устойчивость к ошибкам адаптера | FSM Adapter Error state + авторестарт |
| MITM и перехват учётных данных | Evil Twin + Captive Portal (Phase 4) |
| Охота на клиентов без AP | Karma/Mana — ответ на Probe Requests (Phase 4) |
| Перехват WPA3 | SAEFilter: Commit/Confirm state machine (Phase 4) |
| Маскировка / confusion-атака | Beacon Flooding: тысячи AP в эфире (Phase 4) |
| Невидимость для IDS/WIDS | StealthEngine: TX burst limiting, интервальная рандомизация, OUI spoofing (Phase 4) |

---

## 2. Архитектура: слои и обязанности

### 2.1 Rust Core

#### Adapter Abstraction Layer (AAL)

Абстракция над физическим Wi-Fi интерфейсом.

- **AdapterHandle** — дескриптор одного адаптера с его capabilities (`inject`, `monitor`). Реестр с ролями появится в Phase 4 (multi-adapter).
- **Fallback** — один адаптер берёт обе роли с активным Channel Lock.
- **Adapter Error Recovery** — при потере интерфейса (`ENODEV`, `ENETDOWN`) AAL эмитит событие `adapter_error` и пытается переподнять интерфейс (3 попытки, backoff 1/2/5 сек). Если не удалось — FSM переходит в `Error`.

**Channel Lock (single-adapter режим):**
При старте атаки `PacketEngine` вызывает `AAL::lock_channel(channel)` — nl80211 controller приостанавливает hopping. После атаки или по таймауту — `AAL::unlock_channel()`. В multi-adapter режиме (Phase 4) lock не нужен — Sniffer и Injector работают на разных каналах независимо.

**AdapterRegistry (Phase 4):**
Заменяет AdapterHandle. Два адаптера с явными ролями: `Sniffer` (мониторинг, wlan0mon) и `Injector` (инъекция/AP, wlan1). Channel Lock убирается из кода.

#### nl80211 Interface Controller

Управление интерфейсом через `nl80211` (`libnl` / `neli`). `ioctl` — fallback только для устаревших драйверов, автодетект через попытку nl80211-команды.

- Переключение в monitor mode
- **Channel Hopping:** Round-Robin по заданному списку каналов. При обнаружении активности целевого BSSID — задержка `dwell_ms` на этом канале (настраивается в TOML, дефолт **500 мс**).
- Управление TX-мощностью
- Channel Lock API

> **Почему dwell_ms = 500 мс (не 3000):** Полный 4-way handshake занимает 50–200 мс. При 3000 мс и 3 каналах цикл = 9+ сек — клиент успевает завершить handshake и уйти до следующего прохода. 500 мс обеспечивает захват handshake при цикле < 2 сек на типичный набор каналов [1, 6, 11].

#### Packet Engine

- **Raw Socket Capture** — захват 802.11 фреймов с минимальными аллокациями.
- **RT-поток инъекции** — `SCHED_FIFO` / `SCHED_RR`.
- **On-the-fly Validation** — проверка полноты 4-way handshake и MIC прямо в потоке захвата.
- **Встроенные детекторы (пассивные):** Rogue AP, PMKID Sniffer.
- **Phase 4 движки** (активируются при наличии AdapterRegistry):
  - `BeaconCloner` — парсинг и слежение за изменениями Beacon IE целевой AP; кормит `config_manager.py` при изменениях
  - `KarmaEngine` — мгновенный ответ на Probe Requests (< 1 мс)
  - `SAEFilter` — захват WPA3 SAE Commit/Confirm с ACT handling
  - `BeaconFloodEngine` — генерация тысяч поддельных Beacon через `sendmmsg`
  - `StealthEngine` — TX rate limiting, интервальная рандомизация, MAC/OUI spoofing (см. раздел 2.6.5)

#### PCAP Writer

RT-поток кладёт фрейм в `crossbeam::ArrayQueue` фиксированного размера (**capacity: 4096 фреймов**, ~6 МБ при среднем фрейме 1500 байт). Отдельный низкоприоритетный Writer-поток дренирует очередь и пишет на диск (`O_DSYNC`).

При переполнении — событие `pcap_buffer_overflow`, фреймы дропаются (RT-потоки не блокируются). Graceful shutdown: Writer дописывает буфер и закрывает файл перед завершением.

---

### 2.2 IPC: Rust → Python (события)

PyO3 + `crossbeam_channel` bounded MPSC. Rust агрессивно фильтрует перед отправкой.

**Backpressure стратегия:**
Канал разделён на два приоритета:

| Канал | Ёмкость | Содержимое | При переполнении |
| :--- | :--- | :--- | :--- |
| `high_priority` | 64 | EAPOL-фреймы, `adapter_error`, `sae_complete`, `evil_twin_waiting`, `evil_twin_ready` | Блокировка Rust (не более 5 мс, затем drop с логом) |
| `normal` | 512 | Beacon-дельты, Probe Requests, события детекторов, `karma_response` | Drop с инкрементом счётчика `ipc_drop_count` |

Python читает `high_priority` первым в каждой итерации event loop. Счётчик дропов отображается в TUI.

**Версионирование событий:**
Каждое событие несёт `api_version: u8` (текущий = 4). Python отклоняет события с несовместимой версией и логирует предупреждение — без паники.

**Фильтрация (что идёт в Python, что остаётся в Rust):**

| Событие | Канал | Примечание |
| :--- | :--- | :--- |
| EAPOL-фреймы (все 4 шага) | `high_priority` | |
| `adapter_error` | `high_priority` | |
| `sae_complete` | `high_priority` | Только полный обмен (4 фрейма) |
| `evil_twin_waiting` | `high_priority` | Нет Beacon от цели; данные: `{bssid, elapsed_ms}` |
| `evil_twin_ready` | `high_priority` | Первый Beacon получен, hostapd перезапущен |
| `beacon_ie_changed` | `normal` | BeaconCloner детектировал изменение IE; данные: `{bssid, changed_fields[]}` → Python вызывает `config_manager.reload()` |
| Probe Request (ассоциированные клиенты) | `normal` | |
| `karma_response` | `normal` | Какой SSID был запрошен клиентом |
| События детекторов (Rogue AP, PMKID) | `normal` | |
| Data-фреймы, дублирующиеся Beacon, ACK | остаются в Rust | |

---

### 2.3 IPC: Python → Rust (команды)

Python командует Rust через **синхронный PyO3 Command API** — прямые вызовы Rust-функций, экспортированных через `#[pyfunction]`. Никакого отдельного обратного канала не нужно: PyO3 уже предоставляет вызов Rust из Python как обычный вызов функции.

Все функции **non-blocking**: они кладут `Command` в отдельный bounded MPSC (capacity: 32) и немедленно возвращают управление Python. Rust-поток читает канал команд в своём цикле — без блокировки RT.

```rust
// core/src/ipc/commands.rs

// --- Phase 1–3: базовые команды ---
#[pyfunction] pub fn cmd_start_deauth(bssid: &str, client: Option<&str>, count: u32, interval_ms: u64) -> PyResult<()>
#[pyfunction] pub fn cmd_stop_deauth(bssid: &str) -> PyResult<()>
#[pyfunction] pub fn cmd_lock_channel(channel: u8) -> PyResult<()>
#[pyfunction] pub fn cmd_unlock_channel() -> PyResult<()>
#[pyfunction] pub fn cmd_set_channel(channel: u8) -> PyResult<()>
#[pyfunction] pub fn cmd_shutdown() -> PyResult<()>

// --- Phase 4: Evil Twin ---
// Запускает BeaconCloner на цель. hostapd стартует Python-слой после события evil_twin_ready.
// Параметры канала и интервала берутся из TOML через config_manager, не передаются здесь.
#[pyfunction] pub fn cmd_evil_twin_start(target_bssid: &str, waiting_timeout_ms: u32) -> PyResult<()>
#[pyfunction] pub fn cmd_evil_twin_stop() -> PyResult<()>

// --- Phase 4: Karma/Mana ---
#[pyfunction] pub fn cmd_karma_start(mode: &str, tx_channel: u8, ssid_blacklist: Vec<String>, ssid_whitelist: Option<Vec<String>>) -> PyResult<()>
#[pyfunction] pub fn cmd_karma_stop() -> PyResult<()>

// --- Phase 4: Beacon Flooding ---
#[pyfunction] pub fn cmd_beacon_flood_start(ap_count: u32, ssid_mode: &str, ssid_file: Option<&str>, channel: u8, oui_pool: Vec<String>) -> PyResult<()>
#[pyfunction] pub fn cmd_beacon_flood_stop() -> PyResult<()>

// --- Phase 4: Stealth ---
#[pyfunction] pub fn cmd_stealth_set(profile: &str) -> PyResult<()>  // "off" | "low" | "medium" | "high"
```

**Обработка ошибок:** если Command MPSC переполнен — `cmd_*` возвращает `PyErr` с `RuntimeError("command queue full")`. Python логирует WARNING и повторяет через 50 мс. Не паника.

> **Почему не отдельный обратный MPSC?** PyO3 уже является мостом — Python вызывает Rust напрямую. Command MPSC нужен только чтобы сделать PyO3-вызов non-blocking и не тормозить Python AsyncIO.

---

### 2.4 Полная схема IPC

```
Python AttackController
    │  cmd_*(...)  via PyO3 direct call
    ▼
Command MPSC (cap=32, non-blocking)
    │
    ▼
PacketEngine loop (Rust)
    │                         ┌──── AAL::lock_channel()
    ├── dispatch Command ──►  ├──── AAL::set_channel()
    │                         ├──── start/stop deauth RT-thread
    │                         ├──── BeaconCloner start/stop (Evil Twin)
    │                         ├──── KarmaEngine start/stop
    │                         ├──── BeaconFloodEngine start/stop
    │                         └──── StealthEngine::set_profile()
    │
    │   event filter
    ├──────────────────► high_priority MPSC (cap=64)  ──────────────┐
    │                    [EAPOL, adapter_error, sae_complete,        │
    │                     evil_twin_waiting, evil_twin_ready]        │
    │                                                                │
    ├──────────────────► normal MPSC (cap=512) ─────────────────────┤
    │                    [beacon_ie_changed, Probe Req,              │
    │                     karma_response, detectors]                 ▼
    │                                                    Python AsyncIO
    │                                                    (high first per tick)
    │                                                    AttackController (FSM)
    │                                                         │
    │                                           evil_twin_ready → config_manager.reload()
    │                                                              → hostapd SIGHUP/restart
    │                                           beacon_ie_changed → config_manager.reload()
    │                                                              → hostapd SIGHUP
    │                                                    PluginBus → плагины
    │
    ├── BeaconCloner ──► beacon_ie_changed event ──► normal MPSC
    │           │
    │           └── (при старте) ──► evil_twin_ready ──► high_priority MPSC
    │
    ├── KarmaEngine ──────────────────────────────────────────────┐
    │                                                              │
    ├── BeaconFloodEngine ──────────────────────────────────────┐  │
    │                                                            │  ▼
    │                                               TxQueue MPSC (priority cap=64, normal cap=1024)
    │                                               TxDispatch thread (SCHED_FIFO)
    │                                               fair drain: max 8 priority → 1 normal
    │                                               StealthEngine (rate limiting)
    │                                                    │
    │                                               raw socket (Injector)
    │
    ├── SAEFilter ──► sae_complete ──► high_priority MPSC
    │
    └── PcapWriter ──► ArrayQueue(4096) ──► Writer ──► .pcapng
                                                       MetadataDB (SQLite)
```

---

### 2.5 Python Layer

#### Config & Profile Manager

TOML-профили. **Правило единственного источника истины:** `attack.evil_twin.our_channel` и `attack.evil_twin.beacon_interval_tu` — канонические значения. `config_manager.py` при рендере `hostapd.conf` берёт их оттуда и никогда не читает `channel`/`beacon_int` из `[attack.evil_twin.hostapd]` — этих полей в секции быть не должно, при наличии логируется WARNING и они игнорируются.

```toml
[session]
targets = ["AA:BB:CC:DD:EE:FF"]
channels = [1, 6, 11]
adapters = ["wlan0"]

[attack.deauth]
enabled = true
count = 5
interval_ms = 100

[attack.channel_hopping]
dwell_ms = 500

[attack.handshake]
wordlists = ["/usr/share/wordlists/rockyou.txt"]

# Phase 4: Evil Twin
[attack.evil_twin]
enabled = false
our_channel = 11             # источник истины для канала двойника
beacon_interval_tu = 98      # источник истины для Beacon interval
waiting_timeout_ms = 10000   # сколько ждать первого Beacon от цели до ошибки

# Параметры hostapd. Канал и beacon_int НЕ указываются — config_manager.py
# берёт их из attack.evil_twin выше. Неизвестные поля → WARNING + игнор.
# Обязательные поля для рендера: hw_mode. Остальные — опциональны.
[attack.evil_twin.hostapd]
hw_mode = "g"          # a | b | g
ieee80211n = true      # включить 802.11n (HT)
ieee80211ac = false    # включить 802.11ac (VHT); требует hw_mode="a"
wmm_enabled = true     # WMM/QoS — обязательно для 802.11n
max_num_sta = 64

# Phase 4: Karma/Mana
[attack.karma]
enabled = false
mode = "Mana"          # Karma | Mana | ManaLoud (experimental — см. раздел 2.6.2)

# Phase 4: Beacon Flooding
[attack.beacon_flood]
enabled = false
ap_count = 500
ssid_mode = "dictionary"

# Phase 4: Stealth / Anti-Detection
[attack.stealth]
profile = "medium"     # off | low | medium | high

[plugins]
active = ["telegram_notify", "auto_crack"]
```

#### Attack Controller (FSM)

**4 состояния** + подсостояния внутри `Attacking` (Phase 4):

```
Idle ──► Scanning ──► Attacking ──► Reporting
           │               │
           └──── Error ◄───┘

Attacking (подсостояния):
  ├── Attacking::Deauth        (Phase 3: деаутентификация)
  ├── Attacking::EvilTwin      (Phase 4: ожидание Beacon / двойник активен)
  ├── Attacking::Karma         (Phase 4: охота на Probe Requests)
  └── Attacking::Passive       (только захват, без инъекции)
```

| Переход | Триггер |
| :--- | :--- |
| `Idle → Scanning` | Запуск профиля |
| `Scanning → Attacking` | Целевой BSSID найден |
| `Attacking → Scanning` | Handshake захвачен или таймаут атаки |
| `Attacking → Reporting` | Явная команда пользователя |
| `* → Error` | `adapter_error` после исчерпания retry; `evil_twin_waiting` таймаут |
| `Error → Idle` | Ручной reset или успешный авторестарт адаптера |

Состояние в памяти. При graceful shutdown (`Ctrl+C`) — дамп в JSON рядом с `.pcapng`.

#### Error State Cleanup

При переходе в `Error` AttackController выполняет строго упорядоченный cleanup:

1. **Остановить активные атаки:** `cmd_stop_deauth`, `cmd_evil_twin_stop`, `cmd_karma_stop`, `cmd_beacon_flood_stop` — для каждой активной атаки. Ошибки игнорируются.
2. **Снять Channel Lock:** `cmd_unlock_channel()`.
3. **Закрыть PCAP-файл:** `cmd_shutdown()` в PcapWriter. Частичный `.pcapng` сохраняется — он валиден.
4. **Записать в SQLite:** сессия `status = "error"`, `ended_at = now()`. Захваченные handshakes и SAE captures остаются.
5. **Дамп FSM-состояния** в JSON.
6. **Уведомить плагины:** событие `session_error` на Plugin Bus (timeout 500 мс).
7. **Если активен Captive Portal:** плагин получает `session_error` и выполняет собственный cleanup (см. раздел 2.6.3).

Общий таймаут всего cleanup: **3 секунды**.

#### Session Resume / Partial Capture Recovery

**Явно вне области действия (out of scope).**

При аварийном завершении на диске остаётся валидный `.pcapng` и запись в SQLite со статусом `error`. «Продолжить» перехват невозможно: состояние радиоэфира не воспроизводимо — клиенты могли переключить каналы, сменить PMKID, завершить ассоциацию.

**Что поддерживается:**
- Частичный `.pcapng` остаётся читаемым — `hcxpcapngtool` корректно обрабатывает файлы с обрывом в конце.
- Ручной импорт через `sora import --pcapng session_42.pcapng` — создаёт новую запись в SQLite из существующего файла (Phase 4+).

**Что не поддерживается:** автоматическое продолжение захвата, восстановление in-progress SAE state machine, слияние двух `.pcapng` от одной логической сессии.

#### Client Tracking

Только клиенты, реально ассоциированные с целевыми BSSID (Data-фреймы, QoS Data, Authentication, Association). Probe Requests с рандомизированным MAC фильтруются в Rust. Karma-клиенты (ассоциировались с нашим двойником) отслеживаются отдельно — поле `source = "karma"` в таблице `clients`.

#### Metadata Storage (SQLite)

```sql
-- Core (Phase 1–3)
CREATE TABLE sessions (
    id           INTEGER PRIMARY KEY,
    timestamp    TEXT NOT NULL,
    pcapng_path  TEXT NOT NULL,
    profile_name TEXT,
    status       TEXT DEFAULT 'active'  -- active | completed | error
);

CREATE TABLE bssids (
    session_id  INTEGER REFERENCES sessions(id),
    bssid       TEXT NOT NULL,
    ssid        TEXT,
    channel     INTEGER,
    encryption  TEXT,          -- WPA2 | WPA3 | WPA3-Transition | Open
    oui_vendor  TEXT
);

-- Клиенты, ассоциированные с целевыми BSSID (не Probe Request-ы)
CREATE TABLE clients (
    id          INTEGER PRIMARY KEY,
    session_id  INTEGER REFERENCES sessions(id),
    bssid       TEXT NOT NULL,    -- AP с которой ассоциирован
    client_mac  TEXT NOT NULL,
    source      TEXT DEFAULT 'passive',  -- passive | karma
    first_seen  TEXT NOT NULL,
    last_seen   TEXT NOT NULL
);

CREATE TABLE handshakes (
    session_id    INTEGER REFERENCES sessions(id),
    bssid         TEXT NOT NULL,
    -- byte offset начала pcapng Enhanced Packet Block от начала файла;
    -- используется для прямой навигации в TUI и отчёте.
    -- NULL если offset не был записан (старые сессии).
    pcapng_offset INTEGER,
    captured_at   TEXT NOT NULL
);

CREATE TABLE crack_results (
    handshake_id  INTEGER REFERENCES handshakes(id),
    status        TEXT,         -- cracked | failed | in_progress
    passphrase    TEXT,
    cracker       TEXT,         -- hashcat | john
    duration_sec  INTEGER
);

-- Phase 4 additions
CREATE TABLE sae_captures (
    id             INTEGER PRIMARY KEY,
    session_id     INTEGER REFERENCES sessions(id),
    bssid          TEXT NOT NULL,
    client         TEXT NOT NULL,
    commit_ap      BLOB,
    commit_client  BLOB,
    confirm_ap     BLOB,
    confirm_client BLOB,
    had_act        BOOLEAN,
    -- byte offset начала первого SAE Authentication pcapng-блока от начала файла.
    -- NULL если не записан.
    pcapng_offset  INTEGER,
    captured_at    TEXT NOT NULL
);

CREATE TABLE credentials (
    id              INTEGER PRIMARY KEY,
    session_id      INTEGER REFERENCES sessions(id),
    client_ip       TEXT,
    client_mac      TEXT,
    portal_template TEXT,
    data            TEXT,        -- JSON: {"password": "...", "username": "..."}
    captured_at     TEXT NOT NULL
);
```

> **`pcapng_offset`:** byte offset начала pcapng Enhanced Packet Block (EPB) от начала файла. Это позволяет TUI и HTML-отчёту генерировать прямую ссылку на пакет (`wireshark session.pcapng -Y "frame.offset==N"`). Поле заполняется PcapWriter при записи каждого релевантного фрейма. Значение NULL в старых сессиях или при ошибке записи — не критично, пакет всегда можно найти по `captured_at`.

> **Хранение credentials:** поле `data TEXT` содержит учётные данные в JSON **plaintext**. Намеренное решение: SORA — пентест-инструмент, данные уходят в отчёт заказчику. Для compliance-требований доступен **SQLCipher** (`rusqlite` с feature `bundled-sqlcipher`, ключ через `PRAGMA key`). Этот путь не поддерживается в текущей версии и оставлен на усмотрение оператора.

#### Privilege Drop и привилегированные плагины

После инициализации raw socket и netlink SORA сбрасывает привилегии. Это создаёт проблему: плагин `captive_portal` требует root для `hostapd`, `dnsmasq`, `iptables` и `ip addr`.

**Решение: плагины спавнятся до privilege drop.**

Последовательность инициализации:

```
1. Старт от root / с capabilities
2. nl80211 Controller: открыть Netlink socket, переключить в monitor mode
3. PacketEngine: открыть raw socket (AF_PACKET) — Sniffer и Injector
4. PcapWriter: открыть .pcapng файл
5. Plugin Manager: спавнить все активные плагины (subprocess.Popen)
   → дочерние процессы наследуют root от родителя
   → captive_portal работает от root весь свой жизненный цикл
6. ──── privilege drop (только основной процесс SORA) ────
7. Дальнейшая работа SORA без root; плагины продолжают от root
```

**Альтернатива (если спавн до drop невозможен по архитектурным причинам):**
Установить `sudoers.d`-фрагмент при инсталляции SORA:
```
sora_user ALL=(root) NOPASSWD: /usr/sbin/hostapd, /usr/sbin/dnsmasq, /sbin/iptables, /sbin/ip
```
Тогда `captive_portal` вызывает `sudo -n hostapd ...` без пароля. Этот путь требует изменений в инсталляторе и явно менее предпочтителен.

> **Примечание:** `hostapd` и `dnsmasq` остаются процессами с root-привилегиями независимо от подхода. Это ожидаемо — они управляют сетевыми интерфейсами. Cleanup при завершении сессии (см. раздел 2.6.3) выполняется также от root через дочерний процесс плагина.

**Реализация drop в Rust:**

```rust
// core/src/priv_drop.rs
pub fn drop_privileges(target_uid: u32, target_gid: u32) -> Result<(), PrivDropError> {
    nix::unistd::setgroups(&[])?;
    nix::unistd::setgid(Gid::from_raw(target_gid))?;
    nix::unistd::setuid(Uid::from_raw(target_uid))?;
    assert_ne!(nix::unistd::getuid().as_raw(), 0, "privilege drop failed");
    Ok(())
}
```

`target_uid` / `target_gid` берётся из `SUDO_UID` / `SUDO_GID`. Если запуск напрямую от root без sudo — WARNING в лог, продолжаем. Открытые fd (raw socket, netlink, pcap) **остаются валидными** после drop.

#### Environment Check

| Зависимость | Обязательна | Фаза | Поведение при отсутствии |
| :--- | :--- | :--- | :--- |
| `CAP_NET_RAW`, `CAP_NET_ADMIN` / root | ✅ | 1 | Hard stop с объяснением |
| `hcxpcapngtool` | ❌ | 3 | Предупреждение; cracking pipeline недоступен |
| `hashcat` | ❌ | 3 | Предупреждение; cracking pipeline недоступен |
| GPU (OpenCL/CUDA) | ❌ | 3 | Hashcat работает на CPU |
| `hostapd` | ❌ | 4 | Предупреждение; Evil Twin и Karma недоступны |
| `dnsmasq` | ❌ | 4 | Предупреждение; Captive Portal недоступен |
| Второй Wi-Fi адаптер | ❌ | 4 | Предупреждение; все Phase 4 атаки недоступны |

#### TUI / CLI

- **TUI:** `textual` — карта AP, лог событий, прогресс атак, счётчик `ipc_drop_count`, список karma-клиентов, захваченные credentials, активный stealth-профиль
- **CLI:** `typer` — полноценный интерфейс, запуск профилей
- **Reporting:** JSON + HTML экспорт

---

### 2.6 Phase 4: Advanced Auditing Engines

:::danger
**STRICT COMPLIANCE STATEMENT (Phase 4):**
Движки фазы 4 (Evil Twin, Karma/Mana, Beacon Flood, StealthEngine) представляют собой инструменты активного взаимодействия с сетью. Их использование строго ограничено сценариями тестирования *собственных* систем предотвращения вторжений (WIDS/WIPS), стресс-тестирования систем мониторинга инцидентов (SIEM) и легального аудита корпоративных сетей. Остановка оказания услуг связи или перехват учетных записей третьих лиц нарушает условия использования (STC). SORA поставляется "как есть" в конфигурации для оценки безопасности.
:::

> Все движки этого раздела требуют **AdapterRegistry** (два адаптера: Sniffer + Injector). При наличии только одного адаптера — команды возвращают `PyErr("phase4_requires_dual_adapter")`.

---

#### 2.6.1 Evil Twin (Злой Двойник)

Создание функциональной копии целевой AP: тот же SSID, те же IE, тот же RSNE — но на другом канале.

**Разделение ответственности между BeaconCloner, hostapd и EvilTwinEngine:**

| Компонент | Ответственность |
| :--- | :--- |
| `BeaconCloner` (Rust) | Слушает Beacon от цели; парсит все IE; детектирует изменения по hash; эмитит события в Python |
| `config_manager.py` (Python) | Рендерит `hostapd.conf` из TOML + данных BeaconCloner; перезапускает hostapd через SIGHUP |
| `hostapd` (процесс) | Управляет ассоциацией, 4-way handshake, DHCP-запросами; **отправляет Beacon** с нужным SSID и IE |
| `EvilTwinEngine` | **Не используется** когда hostapd активен — hostapd сам отправляет Beacon. EvilTwinEngine зарезервирован для будущего режима без hostapd (raw-only). |

> **Почему не нужен EvilTwinEngine при активном hostapd:** hostapd в AP mode самостоятельно отправляет Beacon через nl80211. Если параллельно EvilTwinEngine инъектировал бы Beacon через raw socket — на wlan1 появились бы два источника Beacon с одинаковым BSSID но разными SeqNum, что вызывает дроп фреймов на клиенте и нестабильную ассоциацию. 98 TU вместо 100 реализуется через `beacon_int=98` в сгенерированном `hostapd.conf`.

```
Adapter[Sniffer]  wlan0mon  ──► Beacon capture ──► BeaconCloner (Rust)
                                                           │
                                                  beacon_ie_changed event
                                                           │
                                                           ▼
                                                   Python AttackController
                                                           │
                                              config_manager.reload(ie_data)
                                                           │
                                              рендер hostapd.conf + SIGHUP
                                                           │
Adapter[Injector] wlan1 ◄─── hostapd (AP mode) ───────────┘
                              управляет ассоциацией + отправляет Beacon
```

**Поведение до первого Beacon (waiting state):**

`cmd_evil_twin_start(target_bssid, waiting_timeout_ms)` запускает `BeaconCloner` на целевой BSSID. Пока первый Beacon не получен:
- `EvilTwinEngine` не запускается
- hostapd не запускается
- Python получает событие `evil_twin_waiting` с `{bssid, elapsed_ms}` каждые 1000 мс
- TUI показывает статус `EvilTwin: waiting for beacon...`
- Если `waiting_timeout_ms` истёк → событие `adapter_error`-уровня, FSM переходит в `Error`

После первого Beacon:
- `BeaconCloner` эмитит `evil_twin_ready` с полным набором распарсенных IE
- Python вызывает `config_manager.reload(ie_data)` → генерирует `hostapd.conf` → запускает hostapd
- TUI показывает `EvilTwin: active`

**Адаптация при изменении оригинала:**

Если `BeaconCloner` детектирует изменение IE (RSNE, HT Caps и т.д.) — эмитит `beacon_ie_changed`. Python вызывает `config_manager.reload()` и посылает hostapd `SIGHUP`. Перезапуск < 200 мс, клиенты не отваливаются.

**Выдавливание клиентов:** `cmd_start_deauth(bssid=original, client=broadcast, count=0, interval_ms=100)` — непрерывно до явной остановки.

---

#### 2.6.2 Karma / Mana

Ответ на Probe Requests клиентов — SORA представляется любой запрошенной сетью. Ключевое требование: ответ до таймаута клиента (30–100 мс). Поэтому логика в Rust, отправка через `TxQueue` с наивысшим приоритетом.

```
Sniffer (wlan0mon) ──► PacketEngine ──► KarmaEngine (RT-поток)
                                              │ self-frame filter
                                              │ priority push → TxQueue
                                        TxDispatch ──► Injector (wlan1) ──► Probe Response
                                              │ при ассоциации клиента
                                        hostapd (AP mode, wlan1)
```

```rust
pub enum KarmaMode {
    Karma,                // только directed probe (конкретный SSID)
    Mana,                 // + wildcard probe (пустой SSID)
    ManaLoud,             // [EXPERIMENTAL] + broadcast probe response (см. ниже)
}

pub struct KarmaConfig {
    pub mode:           KarmaMode,
    pub our_bssid:      MacAddr,
    pub tx_channel:     u8,
    pub rssi_spoof:     i8,
    pub ssid_blacklist: Vec<Ssid>,
    pub ssid_whitelist: Option<Vec<Ssid>>,
}
```

Логика на каждый входящий фрейм (в RT-потоке):

```rust
fn on_frame(&self, frame: &[u8]) {
    let Some(probe) = parse_probe_request(frame) else { return };

    // Фильтр собственных фреймов: Sniffer слышит всё в эфире включая
    // фреймы которые Injector только что отправил. Без этого фильтра
    // KarmaEngine будет отвечать на собственные Probe Response-ы.
    if probe.source_mac == self.config.our_bssid { return }

    if self.config.ssid_blacklist.contains(&probe.ssid) { return }
    if let Some(wl) = &self.config.ssid_whitelist {
        if !wl.contains(&probe.ssid) { return }
    }
    if probe.ssid.is_empty() && self.config.mode == KarmaMode::Karma { return }

    let response = ProbeResponseBuilder::new()
        .destination(probe.source_mac)
        .bssid(self.config.our_bssid)
        .ssid(probe.ssid.clone())
        .channel(self.config.tx_channel)
        .capabilities(Capabilities::ESS | Capabilities::Privacy)
        .rssi_hint(self.config.rssi_spoof)
        .supported_rates(&[54, 48, 36, 24, 18, 12, 9, 6])
        .build();

    self.tx_queue.push_priority(response);
}
```

> **`ManaLoud` — experimental.** Отправляет broadcast Probe Response (DA = FF:FF:FF:FF:FF:FF) без предварительного Probe Request от клиента. Практическая ценность минимальна: Android 6+, iOS 10+, Windows 10+ игнорируют broadcast Probe Response согласно 802.11-2016 (§11.1.4.2). Оставлен для legacy-устройств. В TUI отображается `[exp]`.

При ассоциации клиента — Python создаёт/обновляет `hostapd.conf` (SIGHUP < 200 мс) с нужным SSID.

---

#### 2.6.3 Captive Portal

После подключения клиента к Evil Twin / Karma AP — плагин-актор поднимает HTTP(S)-сервер и перехватывает трафик.

```
Client ──► wlan1 (hostapd) ──► Linux bridge / NAT
                                      │
                    ┌─────────────────┼──────────────────┐
                    ▼                 ▼                   ▼
              dnsmasq            iptables           aiohttp server
          (DHCP + DNS spoof)  (redirect :80→:8080)  :8080 / :8443
```

**Два уровня DNS Spoofing:**
1. `dnsmasq`: `address=/#/10.0.0.1` — все A/AAAA резолвятся в наш IP.
2. `iptables REDIRECT`: `UDP:53 → dnsmasq` — перехватывает клиентов с захардкоженным DNS (8.8.8.8, 1.1.1.1).

**iptables правила — установка при старте:**

```bash
# Плагин сохраняет точные правила которые добавил, чтобы удалить их точечно
iptables -t nat -A PREROUTING -i wlan1 -p udp --dport 53 -j REDIRECT --to-port 53
iptables -t nat -A PREROUTING -i wlan1 -p tcp --dport 80  -j REDIRECT --to-port 8080
iptables -t nat -A PREROUTING -i wlan1 -p tcp --dport 443 -j REDIRECT --to-port 8443
```

**Cleanup при завершении — точечное удаление через `-D`:**

```python
async def on_session_end(self):
    # Удаляем только свои правила через -D, не трогаем весь PREROUTING.
    # -F PREROUTING снесёт правила других инструментов (VPN, firewall).
    for rule in self._installed_rules:  # сохранены при старте
        run(f"iptables -t nat -D {rule}")
    self._dnsmasq_proc.terminate()
    await self._http_runner.cleanup()
    run("ip addr flush dev", self.iface)
```

`self._installed_rules` — список строк правил в формате iptables (без `-A`), сохранённых при старте. Даже если одно удаление завершается с ошибкой — продолжаем остальные.

**aiohttp сервер:** catch-all роутинг (`/{path:.*}`) — любой HTTP-запрос отдаёт страницу портала. HTTPS на 8443 с self-signed сертификатом. При submit — данные сохраняются в SQLite (`credentials`, plaintext) и уходят событием `credentials_captured` в Plugin Bus.

**OUI-based автовыбор шаблона:** SORA определяет производителя целевой AP по первым 3 байтам BSSID. TP-Link → страница TP-Link, ASUS → страница ASUS.

```
portals/
├── generic_wifi/    — «Введите пароль Wi-Fi для продолжения»
├── router_login/    — имитация страницы роутера (TP-Link, ASUS, Mikrotik)
├── hotel_wifi/      — «Введите номер комнаты и фамилию»
└── isp_portal/      — «Авторизуйтесь через аккаунт провайдера»
```

---

#### 2.6.4 Beacon Flooding

Генерация сотен и тысяч поддельных AP одновременно. Цели: маскировка реального Evil Twin, DoS сканеров противника, confusion-атака на network managers клиентов.

**Ключевое решение: `sendmmsg()` вместо `sendmsg()`** — один syscall отправляет батч из N фреймов. Снижение overhead ядра в 30–50x.

```
BeaconFloodEngine
    ├── BssidGenerator     — случайные MAC из OUI-пула
    ├── SsidGenerator      — dictionary | template | clone | random
    ├── FramePool          — N готовых фреймов, собранных при старте
    └── BurstScheduler     — sendmmsg батчи через TxQueue с adaptive backpressure
```

**FramePool:** при старте генерируем N фреймов один раз. В цикле только: обновить Timestamp (8 байт по фиксированному offset) + инкремент SeqNum (2 байта) + push `Batch` в `TxQueue.normal`. Никаких аллокаций в hot path.

**Adaptive backpressure:** если `TxQueue.normal` заполнена → `BeaconFloodEngine` получает `TrySendError::Full` → batch size делится пополам. При восстановлении — плавно растёт.

| Цель | Batch size | Интервал | Результат |
| :--- | :--- | :--- | :--- |
| 100 AP, фоновый шум | 10 | 10 мс | ~1 000 фреймов/сек |
| 500 AP, умеренный флуд | 32 | 5 мс | ~6 400 фреймов/сек |
| 2000 AP, максимальный хаос | 64 | 1 мс | ~64 000 фреймов/сек |

При 64 000 фреймов/сек нагрузка на CPU: ~5–15% одного ядра.

```rust
pub enum SsidGenMode {
    Dictionary(Vec<String>),
    Template { prefix: String, suffix: SsidSuffix },
    Random { len_range: (u8, u8) },
    Clone { base_ssid: String, variants: u32 },
}
```

`Clone` — особенно эффективен при Evil Twin: десятки вариаций целевого SSID, двойник теряется в толпе.

---

#### 2.6.5 StealthEngine (WIDS Validation)

**Проблема:** без ограничений генераторы кадров инъектируют трафик с математически идеальным интервалом и от статичного MAC. Это тривиально детектируется базовыми IDS-системами, лишая аудит ценности: цель SORA — проверить способность систем WIDS (Snort, Kismet, Cisco WIPS) выявлять сложные, слабоструктурированные паттерны.

**StealthEngine** — фильтр в `TxDispatch` потоке: фреймы попадают в `TxQueue` → `StealthEngine` решает когда и как их отправить.

```rust
pub struct StealthConfig {
    pub profile:            StealthProfile,
    pub oui_pool:           Vec<[u8; 3]>,
    pub burst_cap_pps:      Option<u32>,
    pub interval_jitter:    f32,
    pub inter_frame_gap_us: RangeInclusive<u64>,
}

pub enum StealthProfile {
    Off,     // без изменений
    Low,     // OUI spoofing only
    Medium,  // OUI spoofing + jitter 20% + burst cap 1000 pps
    High,    // OUI spoofing + jitter 40% + burst cap 200 pps + inter-frame gap 50–500 мкс
}
```

**OUI Spoofing:** при старте атаки выбирается случайный OUI из `oui_pool` и применяется к src MAC всех инъектируемых фреймов. Пул по умолчанию — топ-20 OUI потребительских роутеров. Полностью случайный MAC (Locally Administered Address — нечётный первый байт) немедленно флагируется WIDS.

**Интервальная рандомизация:** базовый интервал умножается на `1.0 + jitter * random_f32(-1.0, 1.0)`. При `jitter = 0.2` и 98 TU — реальный интервал варьируется 78–118 TU.

**TX Burst Cap:** token bucket. Актуально для BeaconFloodEngine: всплеск 64 000 pps невозможно объяснить одним устройством — нормальный AP не превышает ~3 000–8 000 pps.

| Профиль | Реакция базовых WIDS | Производительность | Сценарий применения |
| :--- | :--- | :--- | :--- |
| `off` | Триггер (сразу) | Максимальная | Валидация работы сенсоров WIDS |
| `low` | Вероятный триггер | ~95% | Базовый стресс-тест SIEM |
| `medium` | Снижение числа алертов | ~60–70% | Аудит сред со слабой WIDS логикой |
| `high` | Высокий шанс false negative | ~15–25% | Стресс-тест Advanced WIDS корреляторов |

> **Ограничение:** `StealthEngine` маскирует TX-паттерны, но не скрывает сам факт инъекции. Физическая радиосигнатура (мощность, позиция) за пределами возможностей ПО.

---

#### 2.6.6 Concurrency модель Phase 4: Injector TxQueue

**Проблема:** `KarmaEngine`, `BeaconFloodEngine` работают в раздельных RT-потоках и оба инъектируют через один Injector raw socket. Прямой `send_raw` из нескольких потоков — гонка данных.

**Решение: единая `TxQueue` + один `TxDispatch` поток.**

```rust
// core/src/engine/tx_dispatch.rs

pub enum TxFrame {
    Normal(Vec<u8>),
    Priority(Vec<u8>),       // Probe Response от KarmaEngine
    Batch(Vec<Vec<u8>>),     // батч от BeaconFloodEngine — sendmmsg
}

pub struct TxQueue {
    priority: crossbeam_channel::Sender<TxFrame>,  // cap=64
    normal:   crossbeam_channel::Sender<TxFrame>,  // cap=1024
}
```

**Приоритеты:**

| Источник | Тип | Приоритет | Обоснование |
| :--- | :--- | :--- | :--- |
| `KarmaEngine` | Probe Response | `Priority` | Таймаут клиента 30–100 мс |
| `Deauth` (Phase 3) | Deauth/Disassoc | `Priority` | Выдавливание клиентов чувствительно к задержке |
| `BeaconFloodEngine` | Beacon Batch | `Normal` | Высокий объём; терпит задержку |

> **EvilTwinEngine исключён:** Beacon инъектирует hostapd напрямую (см. 2.6.1), поэтому `EvilTwinEngine` не пишет в `TxQueue`.

**`TxDispatch` поток — fair drain (`SCHED_FIFO`):**

```rust
const MAX_PRIORITY_PER_ITER: usize = 8;

loop {
    // 1. Дренировать priority, но не более MAX_PRIORITY_PER_ITER фреймов.
    //    Без этого лимита плотный Probe Request трафик полностью вытеснит
    //    нормальные фреймы и BeaconFloodEngine встанет.
    let mut drained = 0;
    while drained < MAX_PRIORITY_PER_ITER {
        match self.rx_priority.try_recv() {
            Ok(frame) => { self.stealth.maybe_delay(); self.send(frame); drained += 1; }
            Err(_)    => break,
        }
    }
    // 2. Один фрейм/батч из normal
    if let Ok(frame) = self.rx_normal.try_recv() {
        self.stealth.maybe_delay();
        self.send(frame);
    }
    // 3. Yield если обе очереди пусты
    std::thread::sleep(Duration::from_micros(100));
}
```

**Почему не `SO_REUSEPORT`:** для `AF_PACKET` сокетов не даёт независимых TX-очередей — фреймы всё равно уходят через один TX ring буфер драйвера. Единая `TxQueue` проще и даёт `StealthEngine` видимость всего потока.

**Backpressure:**
- `BeaconFloodEngine`: `TrySendError::Full` на `normal` → уменьшает batch.
- `KarmaEngine`: блокируется не более 2 мс на `priority` (cap 64 практически никогда не заполняется).

---

#### 2.6.7 WPA3 SAE Hunting

Захват SAE (Dragonfly handshake) для offline dictionary attack через `hashcat -m 22301`.

**Чем SAE сложнее EAPOL:**

| Аспект | WPA2 EAPOL | WPA3 SAE |
| :--- | :--- | :--- |
| Фреймы | 4 × EAPOL Data | 2 × Authentication (subtype SAE) |
| Идентификация | EtherType 0x888E | Auth Algorithm Number = 3 |
| Порядок | Строго 1→2→3→4 | Commit может повториться (ACT) |
| Повтор Commit | Недопустим | Норма при перегрузке AP |
| Transition mode | Нет | AP принимает WPA2 и WPA3 одновременно |

**Определение direction (AP→Client vs Client→AP):**

Direction определяется по Transmitter Address (TA) поля 802.11 MAC header. `PacketEngine` передаёт `direction` в `SAEFilter` следующим образом:

```rust
// Direction определяется до вызова SAEFilter.
// TA — адрес устройства, которое физически передало фрейм.
// known_bssid — BSSID цели, за которой следит SAEFilter.

fn classify_direction(ta: MacAddr, known_bssid: MacAddr) -> Direction {
    if ta == known_bssid {
        Direction::ApToClient   // фрейм передан AP
    } else {
        Direction::ClientToAp   // фрейм передан клиентом
    }
}
```

Это работает надёжно для SAE: фреймы Authentication в Infrastructure mode всегда идут между AP (известный BSSID) и клиентом. Случай IBSS/Mesh здесь не рассматривается.

**SAEFilter** — state machine в PacketEngine:

```rust
pub struct SAECapture {
    pub bssid:          MacAddr,
    pub client:         MacAddr,
    pub commit_ap:      Option<SaeCommitFrame>,
    pub commit_client:  Option<SaeCommitFrame>,
    pub confirm_ap:     Option<SaeConfirmFrame>,
    pub confirm_client: Option<SaeConfirmFrame>,
    pub token:          Option<Vec<u8>>,
    pub captured_at:    Instant,
    pub complete:       bool,
}
```

**Anti-Clogging Token handling:** при Status Code 76 — AP перегружена, клиент должен повторить Commit с токеном. SAEFilter сохраняет токен и ждёт повторный Commit.

```rust
fn on_auth_frame(&mut self, frame: &[u8], direction: Direction) {
    let Some(sae) = parse_sae_auth(frame) else { return };
    let capture = self.in_progress.entry((bssid, client_mac)).or_default();

    match sae {
        SaeAuthFrame::Commit(c) if c.status == 76 => {
            capture.token = Some(c.anti_clogging_token.clone());
        }
        SaeAuthFrame::Commit(c) => {
            match direction {
                Direction::ApToClient => capture.commit_ap     = Some(c),
                Direction::ClientToAp => capture.commit_client = Some(c),
            }
        }
        SaeAuthFrame::Confirm(c) => {
            match direction {
                Direction::ApToClient => capture.confirm_ap    = Some(c),
                Direction::ClientToAp => capture.confirm_client = Some(c),
            }
            self.check_complete((bssid, client_mac));
        }
    }
}
```

Completeness = все 4 фрейма → `sae_complete` в `high_priority` канал. Неполные обмены — GC через **30 секунд**.

**WPA3-Transition Mode:** EAPOL-детектор и SAEFilter работают параллельно. Transition mode детектируется по RSN IE: `AKM Suite 2` (PSK) + `AKM Suite 8` (SAE) → ловим оба типа.

```bash
hcxpcapngtool session_42.pcapng -o session_42.hc22000  # WPA2
hcxpcapngtool session_42.pcapng -o session_42.hc22301  # WPA3-SAE
hashcat -m 22301 session_42.hc22301 /usr/share/wordlists/rockyou.txt
```

---

## 3. Logging

**Rust:** [`tracing`](https://docs.rs/tracing) + JSON. **Python:** [`structlog`](https://www.structlog.org) + JSON. Два потока: файл (ротируемый) + stderr (только `WARN+`).

```toml
[logging]
level = "info"
dir = "~/.local/share/sora/logs"
max_size_mb = 10
keep_files = 5
```

Ротация по размеру. Логи хранятся рядом с `.pcapng` и ссылаются на `session_id`.

| Категория | Уровень | Примеры |
| :--- | :--- | :--- |
| FSM переходы | INFO | `Idle→Scanning`, `Attacking→Error` |
| IPC drops | WARN | `ipc_drop_count=12`, `command_queue_full` |
| Adapter events | WARN/ERROR | `adapter_error: ENODEV`, `retry 2/3` |
| Evil Twin state | INFO | `evil_twin_waiting elapsed_ms=1200`, `evil_twin_ready ssid=HomeWiFi` |
| Handshake capture | INFO | `eapol_complete bssid=AA:... client=BB:...` |
| SAE capture | INFO | `sae_complete bssid=AA:... had_act=true` |
| Karma responses | INFO | `karma_response ssid="Home_WiFi" client=AA:... mode=Mana` |
| Credentials | INFO | `credentials_captured portal=router_login client=10.0.0.2` |
| Plugin events | INFO/WARN | `plugin_started`, `plugin_timeout` |
| Error cleanup | INFO | Каждый шаг с результатом |
| Privilege drop | INFO | `privileges dropped uid=1000` |
| Stealth | DEBUG | `stealth_delay_us=312 profile=medium` |
| TxQueue | WARN | `tx_priority_drained_max iter=N`, `beacon_tx_queue_full` |
| iptables | INFO | `iptables_rule_added rule=...`, `iptables_rule_removed rule=...` |

---

## 4. Kernel & Distro Compatibility

**Рекомендуемый минимум: ядро 5.4 LTS.**

| Функциональность | Минимальная версия ядра |
| :--- | :--- |
| Monitor mode via nl80211 | 2.6.27 |
| `NL80211_CMD_SET_CHANNEL` | 3.2 |
| Frame injection via `NL80211_CMD_FRAME` | 3.6 |
| `sendmmsg(2)` | 3.0 |
| `PACKET_TX_RING` | 3.14 |

| Дистрибутив | Версия | Ядро | Статус |
| :--- | :--- | :--- | :--- |
| Kali Linux | 2023.x+ | 6.x | ✅ Основная платформа |
| Parrot OS | 5.x+ | 6.x | ✅ Поддерживается |
| Ubuntu | 22.04 LTS | 5.15 | ✅ Поддерживается |
| Ubuntu | 20.04 LTS | 5.4 | ⚠️ Минимум, не тестируется регулярно |
| Arch Linux | rolling | 6.x | ✅ Поддерживается |
| macOS / Windows | — | — | ❌ nl80211 Linux only |

Проверенные чипсеты: Atheros AR9271, Ralink RT3070/RT5370, Realtek RTL8812AU.

---

## 5. Система плагинов

### Роли

| Роль | Возможности | Доступна |
| :--- | :--- | :--- |
| **Observer** | Чтение событий: уведомления, логирование | Phase 2 |
| **Actor** | Чтение событий + команды SORA через Plugin Command API | Phase 3 |
| **Transformer** | Обработка фреймов в RT-потоке (dylib, Rust/C ABI) | Phase 4 |

### Plugin Subprocess IPC Protocol

**Протокол: NDJSON over stdin/stdout.**

**SORA → Plugin:**
```json
{"type": "event", "api_version": 4, "event": "handshake_captured", "data": {"bssid": "AA:BB:CC:DD:EE:FF", "client": "11:22:33:44:55:66", "pcapng_path": "/tmp/session_42.pcapng"}}
{"type": "event", "api_version": 4, "event": "credentials_captured", "data": {"portal": "router_login", "password": "12345678", "client_ip": "10.0.0.2"}}
{"type": "event", "api_version": 4, "event": "sae_complete", "data": {"bssid": "AA:BB:CC:DD:EE:FF", "client": "11:22:33:44:55:66"}}
{"type": "shutdown"}
```

**Plugin → SORA (Actor):**
```json
{"type": "command", "api_version": 4, "cmd": "start_deauth", "params": {"bssid": "AA:BB:CC:DD:EE:FF", "count": 3, "interval_ms": 100}}
{"type": "log", "level": "info", "message": "crack started"}
```

Несовместимый `api_version` → `{"type": "version_error"}`, плагин завершается. Timeout на shutdown: **500 мс**, затем `SIGKILL`.

### Встроенные плагины

| Плагин | Роль | Фаза | Назначение |
| :--- | :--- | :--- | :--- |
| `telegram_notify` | Observer | 3 | Уведомления о handshake, SAE, credentials |
| `auto_crack` | Actor | 3 | Автоматический запуск hashcat при захвате |
| `captive_portal` | Actor | 4 | dnsmasq + aiohttp + iptables; спавнится до privilege drop |

### Event Bus

- **Radio:** `new_bssid`, `client_appeared`, `rssi_changed`, `karma_response`
- **Security:** `eapol_captured`, `pmkid_found`, `rogue_ap_detected`, `sae_complete`, `credentials_captured`
- **EvilTwin:** `evil_twin_waiting`, `evil_twin_ready`, `beacon_ie_changed`
- **System:** `channel_changed`, `adapter_error`, `pcap_buffer_overflow`, `ipc_drop_count`, `task_finished`, `session_error`

### Hot Reload (Phase 3)

1. Plugin Bus: прекратить отправку новых событий
2. Ожидание завершения текущего обработчика (таймаут 500 мс)
3. По таймауту — `SIGKILL`, WARNING в TUI
4. Выгрузка → загрузка нового процесса
5. Plugin Bus: возобновление

---

## 6. Внешние зависимости

| Инструмент | Пакет | Назначение | Фаза |
| :--- | :--- | :--- | :--- |
| `hcxpcapngtool` | `hcxtools` | `.pcapng → .hc22000 / .hc22301` | Phase 3 |
| `hashcat` | `hashcat` | Крекинг WPA2 (`-m 22000`) и WPA3 (`-m 22301`) | Phase 3 |
| `john` | `john` | Альтернативный крекер (опционально) | Phase 3 |
| `hostapd` | `hostapd` | Поднятие AP для Evil Twin и Karma | Phase 4 |
| `dnsmasq` | `dnsmasq` | DHCP + DNS Spoofing для Captive Portal | Phase 4 |

---

## 7. Стратегия тестирования

### Rust Core

| Тип | Что тестируем | Подход |
| :--- | :--- | :--- |
| Unit | PacketEngine парсинг фреймов | Mock-сокеты, статические `.pcapng` fixtures |
| Unit | EAPOL/MIC валидация | Корпус валидных и инвалидных handshake |
| Unit | AAL Channel Lock | Mock nl80211 backend |
| Unit | Command MPSC: переполнение → PyErr | Синхронный тест без Python |
| Unit | `drop_privileges`: uid после drop | Требует non-root запуска |
| Unit | BeaconCloner: мутация IE, hash изменений, `beacon_ie_changed` event | Статические Beacon fixtures |
| Unit | BeaconCloner: `evil_twin_waiting` таймаут | Mock без входящих Beacon |
| Unit | KarmaEngine: self-frame filter (`src_mac == our_bssid`) | Mock Probe Response как входящий фрейм |
| Unit | KarmaEngine: filtered/whitelist/blacklist | Mock Probe Requests |
| Unit | SAEFilter: direction detection по TA | Fixtures с known BSSID |
| Unit | SAEFilter: полный обмен, ACT, GC по таймауту | Corpus SAE fixtures + неполные обмены |
| Unit | BeaconFloodEngine: ENOBUFS → shrink batch | Mock raw socket возвращающий ENOBUFS |
| Unit | TxDispatch: fair drain — max 8 priority, затем 1 normal | 100 priority + 100 normal; проверить чередование |
| Unit | TxDispatch: backpressure при заполнении Normal | Быстрый BeaconFlood + медленный TxDispatch |
| Unit | StealthEngine: jitter в заданном диапазоне | Статистика 1000 интервалов |
| Unit | StealthEngine: OUI применяется к src MAC | Inspect отправленных фреймов |
| Integration | PCAP Writer + ArrayQueue | Быстрый продьюсер → проверка файла на диске |
| Integration | TxDispatch + KarmaEngine + BeaconFloodEngine | Параллельный старт; проверка отсутствия data race |
| Stress | IPC backpressure | Генератор событий > скорость потребления Python |
| Stress | BeaconFlood throughput | Счётчик фреймов за 10 сек с mock socket |

### Python Layer

| Тип | Что тестируем | Инструмент |
| :--- | :--- | :--- |
| Unit | FSM переходы включая все подсостояния Attacking | `pytest` |
| Unit | Error cleanup: порядок шагов, частичный PCAP | `pytest` + mock cmd_* |
| Unit | Config validation: дублирующиеся поля channel/beacon_int в hostapd-секции → WARNING | `pytest` |
| Unit | config_manager.py: channel и beacon_int берутся из `attack.evil_twin.*`, не из `hostapd` | `pytest` + сравнение строк hostapd.conf |
| Unit | evil_twin_waiting таймаут → FSM Error | `pytest` + mock без beacon_ie_changed |
| Unit | OUI lookup → шаблон портала | `pytest` |
| Unit | iptables cleanup: используется `-D`, не `-F` | `pytest` + mock subprocess; assert на вызванные команды |
| Integration | Plugin lifecycle: спавн до privilege drop | `pytest` + проверка uid дочернего процесса |
| Integration | Plugin IPC: NDJSON send/receive | `pytest` + echo-плагин |
| Integration | captive_portal: iptables -D при завершении | `pytest` + mock subprocess |
| E2E | Replay `.pcapng` через mock Rust core | `pytest` + pcap fixture |

---

## 8. Архитектурные решения

| Компонент | Решение | Обоснование |
| :--- | :--- | :--- |
| Adapter Management | AdapterHandle (Phase 1–3) → AdapterRegistry (Phase 4) | Не усложнять single-adapter MVP |
| Interface Control | nl80211 + ioctl fallback (автодетект) | Современный стандарт; совместимость со старыми чипсетами |
| Channel Hopping | Round-Robin + dwell 500 мс при активности BSSID | Handshake за < 2 сек цикла |
| IPC Rust→Python | PyO3 + 2 bounded MPSC (high/normal) + версионирование | Backpressure без блокировки RT |
| IPC Python→Rust | PyO3 direct call + Command MPSC (cap=32) | Non-blocking; не тормозит AsyncIO |
| Plugin IPC | NDJSON over stdin/stdout | Любой язык; без зависимостей в SDK |
| Privilege Drop | После init, до основного цикла; плагины спавнятся до drop | Открытые fd валидны; привилегированные плагины наследуют root |
| Logging | structlog + tracing, JSON, ротация по размеру | Structured для jq; доказательная база пентеста |
| Kernel minimum | 5.4 LTS | nl80211 + frame injection + sendmmsg |
| Error cleanup | 7 шагов, таймаут 3 сек | Предсказуемость; включает Phase 4 движки и Captive Portal |
| PCAP Writing | lock-free ArrayQueue (cap=4096) + Writer thread | RT-потоки не блокируются на I/O |
| pcapng_offset | Byte offset начала EPB от начала файла | Прямая навигация в TUI и отчёте |
| FSM | 4 состояния + подсостояния Attacking | Минимально необходимо |
| Metadata Storage | SQLite | Одна система; clients таблица отдельно от bssids |
| credentials хранение | Plaintext JSON | Пентест-инструмент; SQLCipher опционально для compliance |
| Plugin Isolation | Только `process` | Надёжность; любой язык; нет GIL |
| Evil Twin Beacon | hostapd отправляет Beacon; BeaconCloner только парсит/отслеживает | Один источник Beacon на интерфейсе; нет конфликта SeqNum |
| Evil Twin waiting | Молчит до первого Beacon; таймаут → FSM Error | Нет смысла стартовать двойника без знания IE цели |
| TOML источник истины | `attack.evil_twin.our_channel` и `beacon_interval_tu`; hostapd-секция не дублирует | Один источник истины; конфликт при расхождении невозможен |
| Beacon interval | 98 TU в hostapd.conf | Клиент предпочитает «пунктуального» двойника |
| Karma self-filter | `src_mac == our_bssid` → drop в RT-потоке | Sniffer слышит собственные фреймы Injector |
| Karma response | Priority push в TxQueue | Латентность < 1 мс |
| SAE direction | По Transmitter Address vs known BSSID | Надёжно для Infrastructure mode; IBSS не поддерживается |
| Phase 4 TX concurrency | Единая TxQueue + TxDispatch; fair drain max 8 priority | Исключает гонку; EvilTwinEngine не голодает при плотном Karma трафике |
| iptables cleanup | `-D` для точечного удаления своих правил | `-F PREROUTING` сносит чужие правила (VPN, firewall) |
| StealthEngine | OUI spoofing + jitter + burst cap | SORA без stealth видна Kismet/WIDS |
| ManaLoud | Experimental | Broadcast Probe Response игнорируется Android 6+, iOS 10+, Win10+ |
| **Audit Trail (EULA)** | Хранение факта принятия EULA в SQLite | [FUTURE] Юридическая защита: доказательство согласия пользователя |
| **Metadata Injection** | Комментарий "Authorized Audit Only" в pcapng/reports | [FUTURE] Сохранение юридического статуса данных при экспорте |
| Session Resume | Out of scope | Состояние эфира не воспроизводимо |

---

## 9. Структура проекта

```
sora/
├── core/                           # Rust crate
│   ├── src/
│   │   ├── adapter/
│   │   │   ├── handle.rs           # AdapterHandle (Phase 1–3)
│   │   │   ├── registry.rs         # AdapterRegistry: Sniffer + Injector (Phase 4)
│   │   │   ├── channel_lock.rs
│   │   │   └── error_recovery.rs   # 3 retry + backoff
│   │   ├── nl80211/                # nl80211 / libnl обёртки, ioctl fallback
│   │   ├── engine/
│   │   │   ├── packet_engine.rs    # PacketEngine, RT-потоки, event filter
│   │   │   ├── beacon_cloner.rs    # BeaconCloner: парсинг IE, hash, evil_twin_ready/waiting
│   │   │   ├── karma.rs            # KarmaEngine: Karma/Mana/ManaLoud + self-filter
│   │   │   ├── beacon_flood.rs     # BeaconFloodEngine + sendmmsg
│   │   │   ├── sae_filter.rs       # SAEFilter: direction по TA, Commit/Confirm FSM, ACT
│   │   │   ├── tx_dispatch.rs      # TxQueue + TxDispatch fair drain (max 8 priority)
│   │   │   └── stealth.rs          # StealthEngine: OUI pool, jitter, token bucket
│   │   ├── detector/               # Rogue AP, PMKID Sniffer
│   │   ├── ipc/
│   │   │   ├── events.rs           # bounded MPSC (high/normal) + PyO3 + api_version=4
│   │   │   └── commands.rs         # Command MPSC + cmd_* API
│   │   ├── priv_drop.rs
│   │   └── pcap/                   # PcapWriter + ArrayQueue(4096) + pcapng_offset
│   ├── tests/
│   │   ├── fixtures/               # .pcapng корпус (WPA2, WPA3-SAE, SAE+ACT)
│   │   ├── test_eapol.rs
│   │   ├── test_channel_lock.rs
│   │   ├── test_command_mpsc.rs
│   │   ├── test_pcap_writer.rs
│   │   ├── test_beacon_cloner.rs   # IE hash, waiting timeout, evil_twin_ready event
│   │   ├── test_karma_engine.rs    # self-filter, blacklist/whitelist, modes
│   │   ├── test_sae_filter.rs      # direction по TA, полный обмен, ACT, GC
│   │   ├── test_beacon_flood.rs    # ENOBUFS backpressure
│   │   ├── test_tx_dispatch.rs     # fair drain, backpressure, concurrency
│   │   └── test_stealth.rs         # jitter диапазоны, OUI в src MAC
│   └── Cargo.toml
│
├── sora/                           # Python пакет
│   ├── controller/                 # AttackController (FSM + подсостояния + evil_twin_waiting)
│   ├── config/                     # TOML профили; валидация дублирующихся полей
│   ├── storage/                    # SQLite wrapper + clients + pcapng_offset
│   ├── cracking/                   # hcxpcapngtool pipeline: hc22000 + hc22301
│   ├── plugins/                    # Plugin loader; спавн до privilege drop
│   ├── hostapd/
│   │   └── config_manager.py       # рендер TOML → hostapd.conf;
│   │                               # channel и beacon_int из attack.evil_twin.*, не из hostapd-секции
│   ├── ui/                         # TUI: evil_twin_waiting state, stealth profile
│   ├── report/                     # JSON + HTML экспортёр
│   └── env_check.py
│
├── plugins/
│   ├── telegram_notify/
│   ├── auto_crack/
│   └── captive_portal/
│       ├── main.py                 # спавнится до privilege drop; cleanup через -D
│       └── portals/
│           ├── generic_wifi/
│           ├── router_login/
│           ├── hotel_wifi/
│           └── isp_portal/
│
├── profiles/
│   ├── quick_scan.toml
│   ├── full_audit.toml
│   └── evil_twin_full.toml
│
└── tests/
    └── python/
        ├── test_fsm_transitions.py
        ├── test_fsm_error_cleanup.py
        ├── test_config_validation.py         # дублирующиеся поля → WARNING
        ├── test_hostapd_config_render.py     # channel/beacon_int из attack.evil_twin.*
        ├── test_evil_twin_waiting.py         # таймаут → FSM Error
        ├── test_plugin_lifecycle.py          # спавн до privilege drop
        ├── test_plugin_ipc.py
        ├── test_oui_lookup.py
        ├── test_captive_portal.py            # iptables -D в cleanup
        └── test_iptables_cleanup.py          # assert нет -F PREROUTING
```

---

## 10. Roadmap

### Phase 1 — Foundation
- Cargo crate `core`: AdapterHandle + Channel Lock API, nl80211 controller, базовый PacketEngine
- PyO3 биндинги: event MPSC (high/normal, api_version=4) + Command MPSC + cmd_* API
- Privilege drop после инициализации; плагины спавнятся до drop
- Python: Config Manager, Environment Check, заглушка TUI
- PCAP Writer: ArrayQueue(4096) + Writer thread + pcapng_offset
- Logging: structlog + tracing, JSON, ротация
- FSM: 4 состояния + Error cleanup
- Тесты Rust: fixtures, `test_pcap_writer`, `test_channel_lock`, `test_command_mpsc`

### Phase 2 — Recon & Handshake
- Channel Hopping: Round-Robin + BSSID dwell (500 мс)
- On-the-fly EAPOL/MIC валидация, PMKID снифинг
- Event filter + backpressure мониторинг
- Attack Controller FSM + JSON session dump
- Детекторы: Rogue AP, PMKID
- Plugin SDK v1: Observer role, NDJSON protocol
- TUI: карта AP, лог событий, `ipc_drop_count`
- SQLite: sessions, bssids, handshakes, clients

### Phase 3 — Attack & Crack
- Deauth через `cmd_start_deauth`
- hcxpcapngtool pipeline: `.pcapng → .hc22000`
- Hashcat/John интеграция
- Plugin Actor role + `auto_crack`, `telegram_notify`
- Plugin Hot Reload
- Full TUI + Reporting

### Phase 4 — Advanced

**4a — Multi-Adapter Foundation**
- AdapterRegistry: Sniffer + Injector роли
- TxQueue + TxDispatch: fair drain (max 8 priority)
- hostapd интеграция: `config_manager.py` с единственным источником истины для channel/beacon_int
- env_check: hostapd, dnsmasq, второй адаптер

**4b — Evil Twin + Karma**
- BeaconCloner: IE парсинг, hash, `evil_twin_waiting`/`evil_twin_ready`, `beacon_ie_changed`
- Поведение до первого Beacon: молчим, таймаут → FSM Error
- hostapd управляет Beacon; конфликт SeqNum устранён
- KarmaEngine: Karma/Mana/ManaLoud + self-frame filter
- FSM подсостояния: `Attacking::EvilTwin`, `Attacking::Karma`
- Тесты: `test_beacon_cloner`, `test_karma_engine` (self-filter), `test_tx_dispatch` (fair drain)

**4c — Captive Portal**
- Plugin `captive_portal`: спавн до privilege drop
- iptables через `-A`/`-D` (не `-F`)
- OUI lookup → автовыбор шаблона
- `credentials_captured` + SQLite credentials (plaintext)
- Тесты: `test_captive_portal`, `test_iptables_cleanup`

**4d — Beacon Flooding**
- BeaconFloodEngine: FramePool + sendmmsg + TxQueue
- Adaptive backpressure (ENOBUFS + TxQueue full)
- SsidGenerator: dictionary, template, clone, random

**4e — WPA3 SAE Hunting**
- SAEFilter: direction по TA vs known BSSID, Commit/Confirm FSM, ACT
- GC 30 сек
- WPA3-Transition mode
- hashcat -m 22301 pipeline
- Тесты: `test_sae_filter` с direction fixtures

**4f — Stealth / Anti-Detection**
- StealthEngine: OUI pool, jitter, token bucket
- `cmd_stealth_set` + `[attack.stealth]`
- TUI: активный профиль + `stealth_delay_avg_us`

**4g — Compliance & Hardening (Future)**
- **Audit Trail**: сохранение `eula_accepted_at` и `system_fingerprint` в БД `sessions`.
- **Legal Metadata**: инъекция `shb_comment` (Section Header Block) в pcapng со строкой «Authorized Audit Only».
- **SQLCipher integration**: прозрачное шифрование БД с ключом активации.

---

## 11. Known Limitations

| Ограничение | Причина | Статус |
| :--- | :--- | :--- |
| MAC-рандомизация | Android 8+, iOS 14+, Win10 2004+ рандомизируют MAC при сканировании | Probe Requests игнорируются; реальный MAC только при association |
| Single-adapter | Невозможно слушать и инъектировать на разных каналах одновременно | Channel Lock; multi-adapter в Phase 4 |
| Phase 4 требует два адаптера | Evil Twin, Karma, BeaconFlood — нужен отдельный Injector | Команды возвращают ошибку при одном адаптере |
| nl80211 на экзотических чипсетах | Некоторые старые чипсеты некорректно реализуют nl80211 | ioctl-fallback (автодетект) |
| Transformer-плагины только Rust/C | RT несовместим с subprocess IPC; нужен dylib | Phase 4 |
| PCAP buffer overflow при высоком трафике | ArrayQueue фиксированного размера (4096) | Drop с событием `pcap_buffer_overflow` |
| Privilege drop без SUDO_UID | Запуск напрямую от root без sudo | WARNING в лог, продолжаем |
| hostapd один SSID | Один hostapd процесс — один интерфейс — один SSID | Смена SSID < 200 мс через SIGHUP |
| Captive Portal HTTPS | Self-signed сертификат — браузер предупреждает | Часть клиентов игнорирует; HTTP всегда работает |
| WPA3-SAE offline attack | SAE устойчив к offline атаке только при сильном пароле | dictionary attack реален только на слабых паролях |
| SAE direction только Infrastructure | Direction по TA vs BSSID не работает для IBSS/Mesh | IBSS/Mesh out of scope |
| Session Resume | Состояние эфира не воспроизводимо | Out of scope; частичный .pcapng читается hcxpcapngtool |
| StealthEngine ≠ полная невидимость | Маскирует TX-паттерн, не радиофизику | Физическая сигнатура за пределами ПО |
| ManaLoud на современных клиентах | Broadcast Probe Response игнорируется Android 6+, iOS 10+, Win10+ | Experimental; ценность только на legacy |
| credentials не шифруются by default | Plaintext; намеренно | SQLCipher — опциональный путь для compliance |
| TxDispatch fair drain при очень плотном Priority | Max 8 priority за итерацию; при >8 pps устойчивый приток Priority — normal всё равно получает слот, но редко | Известное ограничение; 8 — разумный компромисс |
