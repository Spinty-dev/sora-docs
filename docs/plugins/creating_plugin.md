# Как написать свой плагин

Создание простого плагина требует 3 шагов:
1. Зарегистрировать его в TOML `[plugins.active]`.
2. Создать директорию `plugins/my_plugin/`.
3. Написать цикл, читающий `sys.stdin` и пишущий в `sys.stdout` NDJSON.

## Пример (Python)

```python
import sys, json

for line in sys.stdin:
    event = json.loads(line)
    if event['type'] == 'handshake_captured':
        print(json.dumps({"type": "log", "msg": "Send to tg bot!"}))
        sys.stdout.flush()
```
