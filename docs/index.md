# SORA — Signals Offensive Radio Auditor

[English](./index.md) | Русский | [中文](README_ZH.md)

---

**SORA** — это высокопроизводительный фреймворк для глубокого аудита и тестирования на проникновение беспроводных сетей (Wi-Fi). Спроектированный с фокусом на минимальный джиттер, скрытность и максимальную гибкость, SORA сочетает в себе мощь системного уровня Rust и гибкость оркестрации на Python.

:::danger
**ВНИМАНИЕ:** Этот инструмент предназначен исключительно для образовательных целей и санкционированного аудита безопасности. Перед использованием ознакомьтесь с [Юридическим дисклеймером](./DISCLAIMER.md).
:::

---

## 🚀 Ключевые возможности (v4.4+)

### 🦀 Rust Core (Ядро)
- **High-Performance Injection**: RT-потоки (`SCHED_FIFO`) для инъекции фреймов без задержек.
- **On-the-fly Validation**: Проверка 4-way handshake и MIC в реальном времени прямо в потоке захвата.
- **StealthEngine**: Умная маскировка трафика — OUI spoofing, интервальный jitter (20-40%) и ограничение TX burst для обхода WIDS/IDS (Kismet, Cisco WIPS).
- **Multi-Adapter Ready**: Поддержка разделения ролей `Sniffer` (wlan0mon) и `Injector` (wlan1).

### 🐍 Python Layer (Оркестрация)
- **Умные профили (TOML)**: Полная автоматизация атак — от простого Deauth до сложных сценариев Evil Twin.
- **Event-Driven IPC**: Передача событий из Rust в Python через PyO3 с использованием приоритетных очередей (Backpressure management).
- **Plugin System (MIT)**: Гибкая система расширений для уведомлений (Telegram), авто-брутфорса (Hashcat) и Captive Portal.
  - **NDJSON IPC**: Обмен данными между SORA и плагинами через протокол NDJSON (stdin/stdout).
  - **Plugin Roles**: Поддержка ролей `Observer` (чтение), `Actor` (активные команды) и `Transformer` (Phase 4: Обработка фреймов в RT-потоке).

### 📡 Продвинутые движки атак (Phase 4)
- **Evil Twin 2.0**: Клонирование Beacon IE в реальном времени, адаптивный hostapd и выдавливание клиентов.
- **Karma/Mana Engine**: Ответ на Probe Request менее чем за 1 мс.
- **Beacon Flooding**: Генерация тысяч AP одновременно через `sendmmsg()` с минимальной нагрузкой на CPU.
- **SAE Filter**: Перехват WPA3 (SAE) Commit/Confirm хэндшейков.

---

## 🛠 Быстрый старт

### Требования
- ОС: Kali Linux / Parrot OS / Arch Linux.
- Привилегии: `root` или `CAP_NET_RAW`/`CAP_NET_ADMIN`.
- Зависимости: `hostapd`, `dnsmasq`, `hcxpcapngtool`, `hashcat` (опционально).

### Установка
```bash
# Клонируйте репозиторий
git clone https://github.com/Spinty-dev/SORA.git
cd SORA

# Запустите скрипт настройки (автоматически создаст venv и соберет Rust ядро)
./sora.sh build
```

### Запуск
```bash
./sora.sh run --profile quick_scan.toml
```

---

## 🏗 Архитектура

Информация о соответствии стандартам аудита и нормативным требованиям представлена в [Compliance & Standards](COMPLIANCE.md).

---

## ⚖️ Лицензирование

- **Ядро и Python-слой**: [GNU GPL v3](./LICENSE.md).
- **Плагины**: [MIT](../plugins/LICENSE) — полная свобода для ваших расширений.

---

*Создано в исследовательских целях командой SORA.*
