# Высокоуровневая Архитектура Ядра (Rust Core)

Ядро проекта SORA (`sora-core`) представляет собой скомпилированную библиотеку на языке Rust, интегрируемую в Python-окружение через интерфейс **PyO3**. Основное назначение ядра — выполнение высоконагруженных сетевых операций, требующих микросекундной точности и отсутствия пауз сборщика мусора (Garbage Collector), свойственных Python.

:::danger
**Strict Compliance Statement**: Ядро SORA выполняет исключительно синтаксический анализ (парсинг) открытых (plaintext) 802.11 заголовков. Ни один модуль ядра не содержит криптографических функций для дешифровки WEP/WPA/WPA2/WPA3 (CCMP/TKIP). Проект является пассивным/активным аудитором протокола, а не инструментом дешифровки полезной нагрузки (payload).
:::

## Структура Модулей

Архитектура ядра разделена на изолированные подсистемы с жестко заданным разделением зон ответственности (Separation of Concerns):

- **`engine` (`packet_engine`, `af_packet`, `tx_dispatch`)**: Сердце системы. Отвечает за открытие `AF_PACKET` сокетов, чтение сырых фреймов в цикле (без аллокаций памяти) и диспетчеризацию трафика.
- **`ipc` (`commands`, `events`)**: Топология межпроцессного взаимодействия (Inter-Process Communication). Реализует паттерн Message Passing через `std::sync::mpsc` (в будущем `crossbeam-channel`).
- **`nl80211` (`controller`, `neli_backend`)**: Системная абстракция над Netlink-сокетами для конфигурации беспроводных интерфейсов (смена каналов, Monitor Mode, установка мощности передачи).
- **`adapter` (`channel_lock`, `error_recovery`)**: Finite State Machine (FSM) для обработки ошибок аппаратных сетевых карт и блокировки каналов при захвате хэндшейков.
- **`pcap` (`writer`)**: Асинхронная запись захваченного трафика в формате `pcapng` (с поддержкой смещений).

## Интеграция с Python (PyO3)

Точка входа (Entrypoint) ядра определяется в `core/src/lib.rs`. При импорте модуля `sora_core` в Python вызывается конфигуратор `#[pymodule]`, который регистрирует глобальные константы и функции.

### Инициализация (start_engine)

Функция `start_engine` запускает фоновый поток `PacketEngine` и возвращает кортеж из управляющего Handle-объекта и канала событий (Rx).

```rust
#[pyfunction]
fn start_engine(interface: &str, pcap_path: &str) -> PyResult<(engine::packet_engine::PacketEngineHandle, ipc::events::EventReceiver)> {
    let engine = std::sync::Arc::new(
        engine::packet_engine::PacketEngine::new(interface, pcap_path)
            .map_err(|e| pyo3::exceptions::PyRuntimeError::new_err(e.to_string()))?
    );
    let rx = engine.event_receiver(); // Канал получения событий (Beacon, Eapol)
    engine.start(); // Spawns OS Thread
    
    let handle = engine::packet_engine::PacketEngineHandle::new(engine);
    Ok((handle, rx))
}
```

### Привязки Модуля (Module Bindings)

Все синхронные команды оркестратора (Deauth, смена канала) пробрасываются через глобальные функции, которые отправляют сообщения в MPSC-канал (см. раздел `Связь (IPC)`).

```rust
#[pymodule]
fn sora_core(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add("__version__", VERSION)?;
    m.add("API_VERSION", API_VERSION)?;

    // Core Init
    m.add_function(wrap_pyfunction!(start_engine, m)?)?;
    
    // Command Busses
    m.add_function(wrap_pyfunction!(ipc::commands::cmd_start_deauth, m)?)?;
    m.add_function(wrap_pyfunction!(ipc::commands::cmd_lock_channel, m)?)?;
    m.add_function(wrap_pyfunction!(ipc::commands::cmd_shutdown, m)?)?;

    // Class Mappers
    m.add_class::<ipc::events::EventReceiver>()?;
    m.add_class::<engine::packet_engine::PacketEngineHandle>()?;

    Ok(())
}
```

## Потоковая Модель (Threading Model)

1. **Main Thread (Python)**: Управляет UI (через Textual) и высокоуровневой логикой (AttackController FSM).
2. **Sora-Packet-Engine Thread (Rust)**: Владеет сырым `AF_PACKET` сокетом. Блокируется на вызове `recv()`. Гарантирует микросекундную реакцию на входящий 802.11 кадр.
3. **Pcap Flusher Thread (Rust)** (внутри `PcapWriter`): Принимает копии пакетов в Ring Buffer и асинхронно сбрасывает (flush) их на диск, чтобы не блокировать Packet Engine при высоком iowait.

В следующих разделах детализируется устройство каждого компонента.
