# High-Level Core Architecture (Rust Core)

The SORA project core (`sora-core`) is a compiled library written in Rust, integrated into the Python environment via the **PyO3** interface. The core's primary purpose is to execute high-performance network operations requiring microsecond precision and the absence of Garbage Collector (GC) pauses typical of Python.

:::danger
**Strict Compliance Statement**: The SORA core performs exclusively syntactic analysis (parsing) of plaintext 802.11 headers. No core module contains cryptographic functions for decrypting WEP/WPA/WPA2/WPA3 (CCMP/TKIP). The project is a passive/active protocol auditor, not a payload decryption tool.
:::

## Module Structure

The core architecture is divided into isolated subsystems with a strictly defined separation of concerns:

- **`engine` (`packet_engine`, `af_packet`, `tx_dispatch`)**: The heart of the system. Responsible for opening `AF_PACKET` sockets, reading raw frames in a loop (zero-copy/minimal allocations), and traffic dispatching.
- **`ipc` (`commands`, `events`)**: Inter-Process Communication topology. Implements the Message Passing pattern via `std::sync::mpsc` (to be replaced by `crossbeam-channel`).
- **`nl80211` (`controller`, `neli_backend`)**: System abstraction over Netlink sockets for wireless interface configuration (channel switching, Monitor Mode, TX power settings).
- **`adapter` (`channel_lock`, `error_recovery`)**: Finite State Machine (FSM) for handling hardware network card errors and channel locking during handshake capture.
- **`pcap` (`writer`)**: Asynchronous recording of captured traffic in `pcapng` format (with offset support).

## Integration with Python (PyO3)

The core's entrypoint is defined in `core/src/lib.rs`. When the `sora_core` module is imported into Python, the `#[pymodule]` configurator is called, registering global constants and functions.

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

All synchronous commands from the orchestrator (Deauth, channel change) are passed through global functions that send messages to the MPSC channel (see the `Communication (IPC)` section).

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
2. **Sora-Packet-Engine Thread (Rust)**: Owns the raw `AF_PACKET` socket. Blocks on the `recv()` call. Guarantees microsecond reaction to incoming 802.11 frames.
3. **Pcap Flusher Thread (Rust)** (inside `PcapWriter`): Receives packet copies in a Ring Buffer and asynchronously flushes them to disk to avoid blocking the Packet Engine during high iowait.

The following sections detail the design of each component.
