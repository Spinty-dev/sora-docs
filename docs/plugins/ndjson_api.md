# NDJSON API для Плагинов

Плагины SORA общаются по протоколу NDJSON.
Каждая строчка в консоли STDIN/STDOUT должна быть валидным JSON-объектом.

Примеры событий:
```json
{"type": "handshake_captured", "bssid": "AA:BB:CC", "pcap_offset": 1024}
{"type": "plugin_status", "status": "running"}
```
