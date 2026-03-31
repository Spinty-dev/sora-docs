# Adapter Layer and Recovery

The `adapter` layer is responsible for the logical state management of the physical Wi-Fi interface. During active audits (AAL, EvilTwin, Deauth), interfaces are subjected to extreme loads, which can lead to failures at the Kernel Driver level (e.g., driver panics in `ath9k` or `rtw88`).

The SORA core isolates these failures and attempts to resolve them before the Python orchestrator crashes with a critical error.

## 1. Channel Locking (`channel_lock.rs`)

When the first `EAPOL M1` message is detected from a target access point, SORA must prevent `Channel Hopping` (channel switching by the background scanner) to ensure that `M2`, `M3`, and `M4` are successfully captured.

`ChannelLock` implements a thread-safe `Mutex<Option<u8>>`:

```rust
// core/src/adapter/channel_lock.rs
pub struct ChannelLock {
    state: Mutex<Option<u8>>,
}

impl ChannelLock {
    pub fn lock_channel(&self, channel: u8) -> Result<(), ChannelLockError> {
        let mut state = self.state.lock();
        if let Some(locked) = *state {
            return Err(ChannelLockError::AlreadyLocked(locked));
        }
        *state = Some(channel);
        Ok(())
    }
}
```

When Python calls `cmd_lock_channel`, the `PacketEngine` locks the channel. Any subsequent attempt by Python to call `cmd_set_channel` will be silently rejected by the core until `UnlockChannel` is called. This eliminates the possibility of a Handshake Miss due to a Race Condition between the Python FSM and the Rust core.

## 2. Automatic Recovery (`error_recovery.rs`)

The `AdapterErrorRecovery` mechanism is a Finite State Machine that responds to errors such as `ENETDOWN` or `ENODEV` when attempting to send a frame or change a channel.

The system uses **Exponential Backoff** for interface restart attempts.

```rust
// core/src/adapter/error_recovery.rs
const MAX_RETRIES: u32 = 3;
const BACKOFF_SECS: [u64; 3] = [1, 2, 5];

pub enum RecoveryStatus {
    Recovered,
    Retrying { attempt: u32, next_delay: Duration },
    Failed,
}
```

### Recovery Lifecycle:
1. `PacketEngine` catches an `io::Error` when writing to the socket.
2. `attempt_recovery` is initiated.
3. An attempt is made to execute `interface_down` -> `interface_up` via the Netlink Controller. An `on_status` callback informs the calling thread.
4. If the status is `Recovered`, the process continues without stopping the program.
5. If all 3 attempts are exhausted, `Failed` is returned, and the core sends a fatal `AdapterError` event to Python for a graceful shutdown.
