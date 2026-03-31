# Межпроцессное Взаимодействие (IPC)

SORA использует гибридный подход для связи:

- **PyO3 (Синхронные вызовы)**: Python вызывает Rust без накладных расходов на сериализацию (`cmd_start_deauth`).
- **MPSC Channels (Асинхронные события)**: Rust присылает события в Python (`high_priority` и `normal`).
- **NDJSON (STDIN/STDOUT)**: Механизм общения Python-оркестратора с внешними плагинами (например, BruteForcer или Telegram-бот).
