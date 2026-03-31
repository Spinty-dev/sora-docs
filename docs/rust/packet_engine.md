# Подсистема PacketEngine и Парсинг трафика

`PacketEngine` — это центральный узел (core orchestrator) 네트워크-слоя SORA, ответственный за непрерывный захват 802.11 кадров без блокировки основного Python-процесса. 

Философия дизайна `PacketEngine` строится на двух принципах:
1. **Zero-Allocation**: Сниффер не выделяет память в куче (heap) при парсинге кадров. Вся обработка идет через слайсы `&[u8]`.
2. **Блокирующее чтение в выделенном потоке (Dedicated OS Thread)**: Чтение сырого сокета намеренно оставлено блокирующим, чтобы избежать CPU starvation.

## 1. Инициализация сырого сокета (`af_packet.rs`)

Ядро Linux предоставляет семейство `AF_PACKET` для обхода стандартного сетевого стека (TCP/IP). SORA использует `SockProtocol::EthAll` (соответствует `ETH_P_ALL`), что позволяет захватывать абсолютно все 802.11 кадры на интерфейсе.

```rust
// core/src/engine/af_packet.rs
pub fn new(interface: &str) -> Result<Self, SocketError> {
    let fd = socket(
        AddressFamily::Packet,
        SockType::Raw,
        SockFlag::empty(),
        SockProtocol::EthAll, // Захват всех протоколов 2-го уровня
    ).map_err(SocketError::OpenFailed)?;

    // ... Получение ifindex и вызов libc::bind ...
}
```

> [!NOTE]  
> Операция привязки (`bind`) `AF_PACKET` сокета требует привилегий `CAP_NET_RAW` или `root` доступа. Поэтому SORA должна запускаться с использованием `sudo`, после чего происходит "Privilege Drop" для Python-слоя.

### Чтение без оверхеда

Чтение кадра происходит напрямую в предварительно аллоцированный буфер `[u8; 4096]` на стеке потока. Этого размера с запасом хватает для максимального 802.11 фрейма (обычно ~2346 байт).

```rust
pub fn recv(&self, buf: &mut [u8]) -> Result<usize, SocketError> {
    let res = unsafe {
        libc::recv(self.fd.as_raw_fd(), buf.as_mut_ptr() as *mut libc::c_void, buf.len(), 0)
    };
    Ok(res as usize)
}
```

## 2. Главный Worker-поток (`packet_engine.rs`)

Функция `start` создает новый поток уровня ОС, цикл которого является единственным потребителем сырого сокета.

### Non-blocking Command Bus
Пока сокет блокируется на `recv`, поток также проверяет MPSC-канал для команд оркестрации с использованием `try_recv()`.

```rust
// core/src/engine/packet_engine.rs
while let Ok(cmd) = cmd_rx.try_recv() {
    match cmd {
        SoraCommand::Shutdown => break, // Выход из потока сниффера
        SoraCommand::LockChannel { channel } => { ... } // Блокировка перехвата канала
        // ...
    }
}
```

### Маршрутизация кадров (Event Routing)

Как только `socket.recv` возвращает сырой байт-слайс, он немедленно отправляется в Pcap-очередь (если настроено создание дампа) и передается в `parsers::parse_frame`.
В зависимости от типа распознанного фрейма, `PacketEngine` оборачивает его в enum `SoraEvent` и отправляет в Python عبر `EventChannel`.

```rust
let frame = &buf[..len];
pcap_writer.enqueue(frame);

match parse_frame(frame) {
    ParsedFrame::Eapol { bssid, client, step, data } => {
        // Сигнал передается в Python-FSM для учета хэндшейков
        event_channel.send(SoraEvent::EapolFrame {
            api_version: API_VERSION,
            bssid, client, step, data: data.to_vec(),
        });
    }
    // ...
}
```

## 3. Парсинг заголовков (`parsers.rs`)

Модуль парсинга реализован как strict state machine, последовательно считывающая 802.11 (Radiotap + MAC Headers) без копирования. Возвращается объект `ParsedFrame<'a>`, который ссылается на изначальный буфер `buf`.

```rust
pub enum ParsedFrame<'a> {
    Beacon { bssid: [u8; 6], ssid: &'a [u8], channel: u8, rssi: i8 },
    Eapol { bssid: [u8; 6], client: [u8; 6], step: u8, data: &'a [u8] },
    Pmkid { bssid: [u8; 6], client: [u8; 6], pmkid: [u8; 16] },
    Unknown,
}
```

### Извлечение EAPOL и PMKID
`parse_data()` является наиболее сложной частью. Она определяет тип кадра `fc = u16::from_le_bytes([frame[0], frame[1]])` и проверяет EtherType LLC инкапсуляции. Если `ethertype == 0x888E`, кадр распознается как EAPOL.

Для детектирования хэндшейков, парсер анализирует EAPOL Key Information:

```rust
let key_info = u16::from_be_bytes([frame[eapol_start + 5], frame[eapol_start + 6]]);
let ack = (key_info & 0x0080) != 0;
let mic = (key_info & 0x0100) != 0;
let secure = (key_info & 0x0200) != 0;

let step = match (ack, mic, secure) {
    (true, false, false) => 1, // M1
    (false, true, false) => 2, // M2
    (true, true, true) => 3,   // M3
    (false, true, true) => 4,  // M4
    _ => 0,
};
```

Сразу же после определения кадра `M1`, SORA итеративно проходит по OUI Information Elements в поиске PMKID (`OUI 00:0F:AC, Type 4`). Если PMKID обнаружен, он извлекается (`16 байт`) и немедленно пробрасывается в Event Channel.
