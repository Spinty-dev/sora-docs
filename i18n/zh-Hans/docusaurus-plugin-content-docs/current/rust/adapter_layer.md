# 适配器层与故障恢复 (Adapter Layer)

`adapter` 层负责物理 Wi-Fi 接口的逻辑状态管理。在执行 AAL、EvilTwin、Deauth 等主动审计攻击时，接口会承受极高的负载，这可能会导致内核驱动程序 (Kernel Driver) 发生故障（例如 `ath9k` 或 `rtw88` 驱动程序崩溃）。

SORA 的核心 (Core) 会隔离这些故障，并尝试在 Python 协调器挂掉之前自行恢复，以防止发生关键错误。

## 1. 信道锁定 (`channel_lock.rs`)

当从目标访问点 (AP) 捕获到检测到第一个 `EAPOL M1` 消息时，SORA 必须立即阻止背景扫描器的信道跳频 (Channel Hopping) 行为，以确保能捕获随后的 `M2`、`M3` 和 `M4` 握手。

`ChannelLock` 实现了一个线程安全的 `Mutex<Option<u8>>`：

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

当 Python 调用 `cmd_lock_channel` 命令时，`PacketEngine` 会锁定当前信道。随后任何 Python 尝试调用 `cmd_set_channel` 的操作都将被核心层静默拒绝，直到显式调用 `UnlockChannel` 为止。这消除了由于 Python FSM 与 Rust 核心之间的竞态条件 (Race Condition) 而导致握手捕获失败 (Handshake Miss) 的可能性。

## 2. 自动恢复 (`error_recovery.rs`)

`AdapterErrorRecovery` 机制是一个有限状态机 (FSM)，用于响应在尝试发送帧或更改信道时发生的 `ENETDOWN` 或 `ENODEV` 错误。

系统采用**指数退避 (Exponential Backoff)** 策略进行接口重启尝试。

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

### 恢复生命周期：
1. `PacketEngine` 在向套接字写入时捕获到 `io::Error` 错误。
2. 触发 `attempt_recovery` 恢复流程。
3. 尝试通过 Netlink 控制器执行 `interface_down` -> `interface_up` 操作。`on_status` 回调函数会同步通知调用线程。
4. 如果状态为 `Recovered`（已恢复），进程将继续运行而不会退出程序。
5. 如果三尝试都告失败，则返回 `Failed`，核心层将向 Python 发送致命事件 `AdapterError`，以便优雅地关闭系统。
