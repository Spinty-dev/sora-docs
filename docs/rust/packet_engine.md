# Packet Engine (Анализ пакетов)

`PacketEngine` — это сердце снифера SORA (файл `core/src/engine/packet_engine.rs`). Эта структура живет в отдельном системном потоке (`thread::spawn`) и занимается тем, что бесконечно "пылесосит" эфир, фильтруя мусор и собирая драгоценные хэндшейки (EAPOL).

## Запуск движка: `pub fn start(&self)`
Когда Python отправляет команду на старт, Rust клонирует атомарные ссылки (`Arc`) на необходимые компоненты (очереди, локи) и запускает тред `sora-packet-engine`.

```rust
let socket = match RawSocket::new(&interface) { ... }
```
Здесь мы инициализируем `AF_PACKET` сокет на `wlan0mon`. Если SORA запущена не от `root` (или процессом без прав `CAP_NET_RAW`), она мгновенно упадет. Python получит событие `AdapterError` с подробным описанием причины.

## Бесконечный цикл захвата эфира
Главный цикл `while running.load(Ordering::SeqCst)` работает до тех пор, пока из Python не придет команда остановиться.

### Шаг 1: Чтение Команд (Non-blocking)
```rust
while let Ok(cmd) = cmd_rx.try_recv() {
    match cmd {
        SoraCommand::Shutdown => break,
        SoraCommand::LockChannel { channel } => channel_lock.lock_channel(channel),
        // ... (Deauth / Injection stubs)
    }
}
```
Прежде чем прочитать следующий пакет, движок проверяет `cmd_rx` — канал команд MPSC, поступающих из Python (или IPC). Используется именно `try_recv()`, чтобы не заблокировать тред, если команд нет.
*Если пользователь нажал "Атака" в терминале, команда `StartDeauth` обрабатывается здесь мгновенно (в пределах текущего радио-фрейма).*

### Шаг 2: Чтение Фрейма (Blocking recv)
```rust
let mut buf = [0u8; 4096];
match socket.recv(&mut buf) {
    Ok(len) => {
        let frame = &buf[..len];
        pcap_writer.enqueue(frame);
```
Мы читаем данные во временный буфер. Первым делом, сырой байт-код отправляется асинхронному писателю (`PcapWriter`), чтобы дамп `sora.pcapng` был полным и не терял ни одного пакета, даже если парсер Rust не может его распознать.

### Шаг 3: Парсинг (`parse_frame`)
```rust
match parse_frame(frame) {
    ParsedFrame::Beacon { bssid, ssid, channel, rssi } => {
        event_channel.send(SoraEvent::BeaconFrame { ... });
    }
    ParsedFrame::Eapol { bssid, client, step, data } => {
        event_channel.send(SoraEvent::EapolFrame { ... });
    }
    // ...
```
Слой `parsers.rs` (написанный с применением zero-copy подхода `nom` или прямой арифметики указателей) анализирует 802.11 Radiotap заголовок.
*   **Beacons (Маяки)**: Генерируют событие `BeaconFrame`. Чтобы Python не захлебнулся, если вокруг 50 сетей (500 биконов в секунду), на стороне Python реализован Rate-Limiter, а в будущем (Phase 4) дедупликация будет перенесена прямо в этот `match` блок в Rust.
*   **EAPOL (Handshakes)**: Если фрейм имеет тип данных 802.1X Auth (EAPOL) и содержит ключи, Rust немедленно упаковывает его в высокоприоритетное событие `EapolFrame` и пушит в UI, чтобы пользователь увидел заветное `[WPA HANDSHAKE CAPTURED]`.

### Шаг 4: Graceful Shutdown
Если произошла критическая аппаратная ошибка (кто-то выдернул Wi-Fi адаптер из USB порта):
```rust
Err(e) => {
    event_channel.send(SoraEvent::AdapterError { ... });
    thread::sleep(Duration::from_millis(100)); // Защита от 100% CPU lock
}
```
`PacketEngine` отправляет прощальное предсмертное уведомление `AdapterError`, аккуратно завершает `pcap_writer.shutdown()` и завершает поток.
