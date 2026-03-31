# Dispatching & StealthEngine (TxQueue)

The `tx_dispatch` module is responsible for sending generated 802.11 frames to the network. The delivery architecture is designed to prevent Head-of-Line Blocking and minimize the probability of detection by WIDS/WIPS (Wireless Intrusion Detection Systems).

## 1. Frame Types (TxFrame)

All outgoing packets are typed via the `enum TxFrame`, allowing the core to route them with different priorities:

```rust
// core/src/engine/tx_dispatch.rs
pub enum TxFrame {
    Normal(Vec<u8>),       // Background traffic (Beacon Flood)
    Priority(Vec<u8>),     // Critical traffic (Targeted Deauth, Response)
    Batch(Vec<Vec<u8>>),   // Amortized sending (recvmmsg/sendmmsg batch)
}
```

- Splitting queues into **Normal** and **Priority** is critical for Evil Twin-style attacks. A response (Probe Response) to a client request must be sent via the `Priority` queue to outpace the legitimate Access Point.

## 2. Fair Drain Algorithm

Instead of a simple FIFO queue, `TxQueue` implements a modified Weighted Fair Queuing (Round-Robin with weights). If a resource-intensive attack is active (e.g., Deauth broadcast), `TxQueue` guarantees that 20% of airtime (by default) is always reserved for responses (Probe Responses) from the priority queue.

This logic runs in a dedicated sender thread that reads data from an MPSC channel:
```rust
// Stub (Phase 4 implementation in progress)
pub struct TxQueue;
```
In Phase 4, the module will use `crossbeam::channel::select!` to balance the load between Priority/Normal channels.

## 3. StealthEngine (Masking)

`StealthEngine` is a middleware layer between `TxQueue` and the `af_packet` sending (socket `send()`). It performs *on-the-fly* packet modification.

:::danger
**Strict Compliance Statement**: The use of `StealthEngine` features is intended exclusively for stress-testing *one's own* Incident Management Systems (SIEM) to verify their operational correctness (generation of false positives and false negatives).
:::

Traffic Modulation Features:
1. **OUI Spoofing (MAC Masking)**: The transmitter's MAC address (TA) is rotated cyclically. The change affects only the last 3 octets (NIC part), preserving a valid manufacturer OUI (e.g., Apple or Samsung) to bypass filters.
2. **Jitter Injection**: Strictly periodic frames (e.g., sending Deauth exactly every 100 ms) are instantly flagged by WIDS systems as an attack. `StealthEngine` adds mathematical jitter (e.g., $\pm 15$ ms) to sleep intervals (`thread::sleep`).
3. **Burst Capping**: Limits the maximum number of frames per second (Token Bucket mechanism) to prevent physical Denial of Service (DoS), keeping the load within auditing limits rather than a full DoS attack.
