# High-Level Core Architecture (Rust Core)

The core of the SORA project (`sora-core`) is a compiled library in Rust, integrated into the Python environment through the **PyO3** interface. The primary purpose of the core is to execute high-load network operations that require microsecond precision and the absence of Garbage Collector (GC) pauses inherent in Python.

:::danger
**Strict Compliance Statement**: The SORA core performs only syntactic analysis (parsing) of public (plaintext) 802.11 headers. No core module contains cryptographic functions for decrypting WEP/WPA/WPA2/WPA3 (CCMP/TKIP). The project is a passive/active protocol auditor, not a payload decryption tool.
:::

## Module Structure

The core architecture is divided into isolated subsystems with a strictly defined Separation of Concerns:

- **`engine` (`packet_engine`, `af_packet`, `tx_dispatch`)**: The heart of the system. Responsible for opening `AF_PACKET` sockets, reading raw frames in a loop (without memory allocations), and traffic dispatching.
- **`ipc` (`commands`, `events`)**: Inter-Process Communication (IPC) topology. Implements the Message Passing pattern via `std::sync::mpsc` (moving to `crossbeam-channel` in the future).
- **`nl80211` (`controller`, `neli_backend`)**: System abstraction over Netlink sockets for wireless interface configuration (channel switching, Monitor Mode, setting transmit power).
- **`adapter` (`channel_lock`, `error_recovery`)**: Finite State Machine (FSM) for handling hardware network card errors and locking channels during handshake capture.
- **`pcap` (`writer`)**: Asynchronous recording of captured traffic in `pcapng` format (with offset support).

## Integration with Python (PyO3)

The core's Entrypoint is defined in `core/src/lib.rs`. When the `sora_core` module is imported in Python, the `#[pymodule]` configurator is called, which registers global constants and functions.

### Initialization (start_engine)

The `start_engine` function launches the background `PacketEngine` thread and returns a tuple consisting of a control Handle object and an event channel (Rx).

```rust
#[pyfunction]
fn start_engine(interface: &str, pcap_path: &str) -> PyResult<(engine::packet_engine::PacketEngineHandle, ipc::events::EventReceiver)> {
    let engine = std::sync::Arc::new(
        engine::packet_engine::PacketEngine::new(interface, pcap_path)
            .map_err(|e| pyo3::exceptions::PyRuntimeError::new_err(e.to_string()))?
    );
    let rx = engine.event_receiver(); // Channel for receiving events (Beacon, Eapol)
    engine.start(); // Spawns OS Thread
    
    let handle = engine::packet_engine::PacketEngineHandle::new(engine);
    Ok((handle, rx))
}
```

### Module Bindings

All synchronous orchestrator commands (Deauth, channel change) are passed through global functions that send messages to the MPSC channel (see the `IPC & Bridging` section).

```rust
#[pymodule]
fn sora_core(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add("__version__", VERSION)?;
    m.add("API_VERSION", API_VERSION)?;

    // Core Init
    m.add_function(wrap_pyfunction!(start_engine, m)?)?;
    
    // Command Busses
    m.add_function(wrap_pyfunction!(ipc::commands::cmd_start_deauth, m)?)?;
    m.add_function(wrap_pyfunction!(ipc::commands::cmd_lock_channel, m)?)?;
    m.add_function(wrap_pyfunction!(ipc::commands::cmd_shutdown, m)?)?;

    // Class Mappers
    m.add_class::<ipc::events::EventReceiver>()?;
    m.add_class::<engine::packet_engine::PacketEngineHandle>()?;

    Ok(())
}
```

## Threading Model

1. **Main Thread (Python)**: Manages the UI (via Textual) and high-level logic (AttackController FSM).
2. **Sora-Packet-Engine Thread (Rust)**: Owns the raw `AF_PACKET` socket. Blocks on the `recv()` call. Guarantees microsecond reaction to an incoming 802.11 frame.
3. **Pcap Flusher Thread (Rust)** (inside `PcapWriter`): Receives packet copies in a Ring Buffer and asynchronously flushes them to disk to avoid blocking the Packet Engine during high iowait.

The next sections detail the internal structure of each component.
