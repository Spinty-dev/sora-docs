# Практическое руководство по созданию плагина

Создание расширения для SORA не требует глубоких знаний внутреннего устройства Rust-ядра. Плагин взаимодействует с системой как изолированный процесс, обмениваясь сообщениями в текстовом формате.

## Структура Директории

Каждый плагин должен находиться в поддиректории `plugins/` и иметь следующую структуру:

```text
plugins/my_custom_audit/
├── manifest.json      # Обязательные метаданные
├── main.py            # Исполняемый файл (может быть .sh, .go, бинарник)
└── requirements.txt   # Зависимости (если Python)
```

### Manifest.json

Этот файл сообщает SORA, как запускать ваш плагин и какие права ему требуются.

```json
{
  "name": "My Custom Audit",
  "version": "1.0.0",
  "author": "Security Team",
  "entrypoint": "python3 main.py",
  "requires_root": true,
  "description": "Автоматическая выгрузка хэндшейков на внешний сервер"
}
```

> [!WARNING]  
> Если `requires_root` установлен в `true`, SORA запустит ваш плагин до сброса привилегий. Будьте осторожны: любая уязвимость в коде плагина может скомпрометировать всю систему аудита.

## Пример 1: Python (Observer)

Самый простой плагин, который только слушает события и логирует их.

```python
import sys
import json

def log_to_sora(message):
    print(json.dumps({"type": "plugin_log", "level": "INFO", "message": message}))
    sys.stdout.flush()

def main():
    log_to_sora("Plugin started and waiting for events...")
    
    for line in sys.stdin:
        try:
            event = json.loads(line)
            if event.get("event") == "eapol_captured":
                bssid = event["bssid"]
                log_to_sora(f"DETECTED Handshake for {bssid}!")
        except Exception as e:
            continue

if __name__ == "__main__":
    main()
```

## Пример 2: Bash (Actor)

Плагины могут быть написаны даже на Bash. Пример простейшего скрипта, который переключает канал SORA каждые 10 секунд (симуляция внешнего сканера).

```bash
#!/bin/bash

# Цикл управления ядром SORA
while true; do
  # Отправляем команду в stdout
  echo '{"command": "cmd_set_channel", "channel": 1}'
  sleep 10
  echo '{"command": "cmd_set_channel", "channel": 6}'
  sleep 10
  echo '{"command": "cmd_set_channel", "channel": 11}'
  sleep 10
done
```

## Рекомендации по Лицензированию

Для обеспечения максимальной совместимости с экосистемой SORA, мы рекомендуем лицензировать плагины под **MIT License**. Это позволяет другим участникам комьюнити использовать ваши наработки, не накладывая ограничений "вирусности" GPLv3, под которой находится ядро.

> [!CAUTION]  
> Перед публикацией плагина убедитесь, что он не содержит захардкоженных API-ключей или токенов. Используйте механизмы `ENV` переменных, доступные через `ConfigManager`.
