# Error Bridge: Panic & Exception Mapping

In SORA's multi-language architecture (Rust + Python), correct error handling at the FFI boundary is critical for the stability of the entire system. This section describes how panics in native code and system call errors are translated into Python exceptions.

## 1. Exception Mapping

SORA uses the `PyO3` library for both automatic and manual error type mapping.

### Error Matching Table (commands.rs:L68)

| Rust Error (Enum/Type) | Python Exception | Cause |
| :--- | :--- | :--- |
| `TrySendError::Full` | `PyRuntimeError("command queue full")` | The Python layer is sending commands faster than the Rust core can process them. |
| `TrySendError::Disconnected` | `PyRuntimeError("command channel disconnected")` | The Rust `PacketEngine` thread has terminated or crashed (Panic). |
| `std::io::Error` | `PyOSError` / `PyRuntimeError` | System call error (e.g., lack of permissions to open a socket). |
| `invalid MAC` | `PyValueError` | Validation error of input data from the TUI or config. |

### `PyResult` Mechanism
All functions exported from Rust to Python (e.g., `cmd_start_deauth`) return a `PyResult<()>` type. This allows Python to catch errors in standard `try...except` blocks:

```python
try:
    sora_core.cmd_start_deauth("invalid_mac")
except RuntimeError as e:
    logger.error(f"Failed to start deauth: {e}")
```

## 2. Panic Propagation

A panic (`panic!`) in Rust represents an incorrect thread termination. Since the SORA core runs in a separate system thread (`std::thread`), a panic does not kill the entire Python process instantly but leads to a cascading failure.

### Panic Lifecycle:
1. **Panic in Rust Thread**: Stack unwinding is triggered.
2. **Channel Disconnection**: `Sender` and `Receiver` objects within the Rust thread are destroyed (dropped).
3. **Detection in Python**:
    - Upon the next `poll_events()` call, the `event_receiver.poll_high()` method will return an error or an empty result.
    - Upon an attempt to send a command, Python will receive a `RuntimeError: command channel disconnected`.
4. **FSM Transition**: The `AttackController` transitions the system to the `ERROR` state and initiates the cleanup protocol.

:::warning
**Strict Technical Note**: Although PyO3 attempts to catch panics (if the `catch-unwind` feature is enabled), SORA relies on thread isolation. Any panic in Rust should be treated as a critical core bug requiring analysis of `dmesg` or `stderr` logs.
:::

## 3. Diagnostics via Status Codes

To simplify debugging, IPC messages include numeric error codes from the Netlink API and Linux system calls.

```json
{"event": "adapter_error", "error_code": 1, "message": "Operation not permitted (EPERM)"}
```

- **EPERM (1)**: Permission denied error (requires `root` or `CAP_NET_RAW`).
- **EBUSY (16)**: Interface is busy with another process (e.g., `wpa_supplicant`).
- **ENODEV (19)**: Interface has been physically removed or renamed.
