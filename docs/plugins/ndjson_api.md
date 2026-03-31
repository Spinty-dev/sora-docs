# NDJSON Протокол (События и Команды)

Взаимодействие SORA с плагинами осуществляется через **NDJSON (Newline Delimited JSON)** по стандартным потокам Ввода/Вывода (`stdin`, `stdout`). 

Любой объект, отправленный плагином в `stdout`, воспринимается SORA как команда. Любой объект, отправленный SORA в `stdin` плагина, является событием из ядра.

> [!IMPORTANT]  
> Каждая запись должна представлять собой ровно одну строку текста, завершающуюся символом `\n`. Пустые строки игнорируются. Сообщения, не являющиеся валидным JSON, логируются как `plugin_parse_error`.

## 1. События: SORA → Плагин (Observer)

Все плагины по умолчанию являются "Наблюдателями" (Observers) и получают поток событий из Rust-ядра.

### Начало и завершение сессии
```json
{"event": "session_start", "session_id": 12, "pcap_path": "sora_data/audit_2026.pcapng"}
{"event": "session_stop", "session_id": 12, "status": "completed"}
```

### Захват Хэндшейков (EAPOL)
```json
{
  "event": "eapol_captured",
  "bssid": "AA:BB:CC:DD:EE:FF",
  "client": "11:22:33:44:55:66",
  "step": 2,
  "pcap_offset": 1048576,
  "data_hex": "010300..."
}
```

### Детектирование Изменений (BeaconCloner)
```json
{
  "event": "beacon_ie_changed",
  "bssid": "AA:BB:CC:DD:EE:FF",
  "changed_fields": ["ssid", "rsn_capabilities"]
}
```

## 2. Команды: Плагин → SORA (Actor)

Плагины-акторы могут отправлять команды в ядро SORA для автоматизации атак или смены конфигурации "на лету".

### Запуск Deauth атаки
```json
{
  "command": "cmd_start_deauth",
  "bssid": "AA:BB:CC:DD:EE:FF",
  "client": "11:22:33:44:55:66",
  "count": 5
}
```

### Переключение канала
```json
{
  "command": "cmd_set_channel",
  "channel": 11
}
```

### Остановка работы
```json
{"command": "cmd_shutdown", "reason": "all_targets_pwned"}
```

## 3. Статус и Логирование

Плагины могут передавать свой статус и сообщения в консоль SORA:

```json
{"type": "plugin_log", "level": "INFO", "message": "Portal server started on port 8080"}
{"type": "plugin_status", "status": "running", "uptime": 120}
```

> [!CAUTION]  
> **Strict Compliance Statement**: Использование командного API плагинами должно быть строго регламентировано в рамках аудита. Любая неконтролируемая инъекция пакетов (Deauth, Beacon Flood) может привести к нестабильности систем связи за пределами зоны тестирования.
