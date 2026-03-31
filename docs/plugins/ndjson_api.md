# Спецификация NDJSON API (Plugin Subprocess IPC)

В SORA архитектура плагинов реализована через **Subprocess IPC**, где обмен данными происходит по протоколу NDJSON. Это обеспечивает абсолютную изоляцию и возможность использования любого языка программирования без привязки к ABI Rust или GIL Python.

## 1. Схема Событий (SORA ➔ Plugin)

Все события передаются в `stdin` плагина. Событие — это одна JSON-строка, завершающаяся `\n`.

### Схема `eapol_captured`
Используется при захвате 4-way handshake (M1-M4).
```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "properties": {
    "event":       {"const": "eapol_captured"},
    "bssid":       {"type": "string", "pattern": "^([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})$"},
    "client":      {"type": "string", "pattern": "^([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})$"},
    "step":        {"type": "integer", "minimum": 1, "maximum": 4},
    "pcap_offset": {"type": "integer", "description": "Смещение в байтах в pcapng-файле"},
    "data_hex":    {"type": "string", "description": "Сырые байты EAPOL в HEX формате"}
  },
  "required": ["event", "bssid", "client", "step", "data_hex"]
}
```

### Схема `beacon_ie_changed`
Уведомление об изменении параметров цели (например, смена канала или RSN).
```json
{
  "event": "beacon_ie_changed",
  "bssid": "...",
  "changed_fields": ["ssid", "channel", "rsn"]
}
```

## 2. Схема Команд (Plugin ➔ SORA)

Команды отправляются в `stdout` плагина. SORA считывает их асинхронно.

### Схема `cmd_start_deauth`
```json
{
  "command":     "cmd_start_deauth",
  "bssid":       "AA:BB:CC...",
  "client":      "...",
  "count":       10,
  "interval_ms": 100
}
```

## 3. Обработка Binary I/O (Internals)

Для обеспечения надежности IPC уровня ядра Linux, SORA и плагины следуют строгим правилам работы с потоками:

- **Line Buffering**: SORA читает `stdout` плагина построчно. Плагин **обязан** вызывать `flush()` после каждой записи (например, `sys.stdout.flush()` в Python), иначе команда "застрянет" в буфере до его переполнения.
- **BrokenPipe Handling**: Если плагин завершается аварийно, пайп (`stdin`) закрывается. SORA детектирует `BrokenPipe` или `EPIPE` на уровне Rust/Python и инициирует событие `session_error` с последующим Cleanup-ом.
- **Non-blocking read**: Оркестратор читает `stdout` плагинов в неблокирующем режиме через `asyncio.subprocess`, что предотвращает зависание основного цикла при "медленном" плагине.

:::warning
**Strict Technical Detail (Security)**: SORA ограничивает входной буфер для одного сообщения плагина (обычно 64 KB). Попытка отправить JSON большего размера приведет к принудительному закрытию пайпа из соображений защиты от DoS-атак на память оркестратора.
:::

## 4. Спецификация Статусов

Плагины могут рапортовать о своем состоянии:
- **`plugin_init`**: Стадия инициализации.
- **`plugin_ready`**: Готовность к приему событий.
- **`plugin_busy`**: Выполнение тяжелой операции (например, GPU cracking).

```json
{"type": "plugin_status", "status": "plugin_ready", "uptime_ms": 42000}
```
