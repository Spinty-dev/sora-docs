# Error Bridge: Panic & Exception Mapping

В многоязыковой архитектуре SORA (Rust + Python) корректная обработка ошибок на границе слоев (FFI Boundary) является критически важной для стабильности всей системы. Этот раздел описывает, как паники в нативном коде и ошибки системных вызовов транслируются в исключения Python.

## 1. Трансляция исключений (Exception Mapping)

SORA использует библиотеку `PyO3` для автоматического и ручного маппинга типов ошибок.

### Таблица соответствия ошибок (commands.rs:L68)

| Ошибка в Rust (Enum/Type) | Исключение Python | Причина (Cause) |
| :--- | :--- | :--- |
| `TrySendError::Full` | `PyRuntimeError("command queue full")` | Python-слой отправляет команды быстрее, чем Rust-ядро успевает их обрабатывать. |
| `TrySendError::Disconnected` | `PyRuntimeError("command channel disconnected")` | Rust-поток `PacketEngine` завершился или упал (Panic). |
| `std::io::Error` | `PyOSError` / `PyRuntimeError` | Ошибка системного вызова (например, отсутствие прав на открытие сокета). |
| `invalid MAC` | `PyValueError` | Ошибка валидации входных данных из TUI или конфига. |

### Механизм `PyResult`
Все функции, экспортируемые из Rust в Python (например, `cmd_start_deauth`), возвращают тип `PyResult<()>`. Это позволяет Python перехватывать ошибки в стандартных блоках `try...except`:

```python
try:
    sora_core.cmd_start_deauth("invalid_mac")
except RuntimeError as e:
    logger.error(f"Failed to start deauth: {e}")
```

## 2. Распространение паник (Panic Propagation)

Паника (`panic!`) в Rust — это некорректное завершение потока. Поскольку ядро SORA работает в отдельном системном потоке (`std::thread`), паника не убивает весь процесс Python мгновенно, но приводит к каскадному отказу.

### Жизненный цикл паники:
1. **Panic в Rust-потоке**: Вызывается раскрутка стека (unwinding).
2. **Обрыв каналов**: Объекты `Sender` и `Receiver` внутри Rust-потока уничтожаются (drop).
3. **Детекция в Python**:
    - При следующем вызове `poll_events()` метод `event_receiver.poll_high()` вернет ошибку или пустой результат.
    - При попытке отправить команду Python получит `RuntimeError: command channel disconnected`.
4. **FSM Transition**: `AttackController` переводит систему в состояние `ERROR` и запускает протокол очистки.

:::warning
**Strict Technical Note**: Хотя PyO3 пытается поймать паники (если включена фича `catch-unwind`), SORA полагается на изоляцию потоков. Любая паника в Rust должна рассматриваться как критический баг ядра, требующий анализа логов `dmesg` или `stderr`.
:::

## 3. Диагностика через Status Codes

Для упрощения отладки в IPC-сообщениях передаются числовые коды ошибок из API Netlink и системных вызовов Linux.

```json
{"event": "adapter_error", "error_code": 1, "message": "Operation not permitted (EPERM)"}
```

- **EPERM (1)**: Ошибка прав доступа (нужен `root` или `CAP_NET_RAW`).
- **EBUSY (16)**: Интерфейс занят другим процессом (например, `wpa_supplicant`).
- **ENODEV (19)**: Интерфейс был физически извлечен или переименован.
