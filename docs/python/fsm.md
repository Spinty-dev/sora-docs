# Конечный автомат (Attack Controller FSM)

Мозг системы — это `AttackController`, который переключается между состояниями:

1. `Idle` — ожидание пользователя.
2. `Scanning` — поиск целевых BSSID.
3. `Attacking` — инъекции (Deauth, EvilTwin, Beacon Flood).
4. `Reporting` — результат и запись в базу.
5. `Error` — gracefully shutdown потоков при ошибках адаптера.
