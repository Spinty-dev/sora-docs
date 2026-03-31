# 错误桥接 (Error Bridge)：Panic 与异常映射

在 SORA 的多语言架构（Rust + Python）中，各层边界（FFI 边界）处的错误处理对于整个系统的稳定性至关重要。本章节描述了原生代码中的恐慌 (Panic) 以及系统调用错误如何被转换为 Python 异常。

## 1. 异常映射 (Exception Mapping)

SORA 使用 `PyO3` 库进行错误类型的自动和手动映射。

### 错误对应表 (commands.rs:L68)

| Rust 错误 (Enum/类型) | Python 异常 | 原因 (Cause) |
| :--- | :--- | :--- |
| `TrySendError::Full` | `PyRuntimeError("command queue full")` | Python 层发送命令的速度超过了 Rust 核心的处理速度。 |
| `TrySendError::Disconnected` | `PyRuntimeError("command channel disconnected")` | Rust 线程 `PacketEngine` 已终止或崩溃 (Panic)。 |
| `std::io::Error` | `PyOSError` / `PyRuntimeError` | 系统调用错误（例如缺少打开套接字的权限）。 |
| `invalid MAC` | `PyValueError` | TUI 或配置文件中输入数据的验证错误。 |

### `PyResult` 机制
所有从 Rust 导出到 Python 的函数（例如 `cmd_start_deauth`）都返回 `PyResult<()>` 类型。这允许 Python 通过标准的 `try...except` 块捕获错误：

```python
try:
    sora_core.cmd_start_deauth("invalid_mac")
except RuntimeError as e:
    logger.error(f"Failed to start deauth: {e}")
```

## 2. 恐慌传播 (Panic Propagation)

Rust 中的 `panic!` 代表线程的非正常终止。由于 SORA 核心运行在独立的系统线程 (`std::thread`) 中，恐慌不会立即杀掉整个 Python 进程，但会导致级联故障。

### 恐慌生命周期：
1. **Rust 线程崩溃 (Panic)**：触发堆栈展开 (Unwinding)。
2. **通道断开**：Rust 线程内的 `Sender` 和 `Receiver` 对象被销毁 (Drop)。
3. **Python 端检测**：
    - 在下一次调用 `poll_events()` 时，`event_receiver.poll_high()` 方法将返回错误或空结果。
    - 尝试发送命令时，Python 将收到 `RuntimeError: command channel disconnected`。
4. **FSM 状态转换**：`AttackController` 将系统切换至 `ERROR` 状态，并启动清理协议。

:::warning
**严格的技术说明**：尽管 PyO3 尝试捕获恐慌（如果启用了 `catch-unwind` 功能），但 SORA 主要依靠线程隔离。Rust 中的任何恐慌都应被视为核心的关键错误，需要分析 `dmesg` 或 `stderr` 日志。
:::

## 3. 通过状态代码进行诊断

为了简化调试，IPC 消息中包含了来自 Netlink API 和 Linux 系统调用的数字错误代码。

```json
{"event": "adapter_error", "error_code": 1, "message": "Operation not permitted (EPERM)"}
```

- **EPERM (1)**：权限被拒绝错误（由于需要 `root` 或 `CAP_NET_RAW`）。
- **EBUSY (16)**：接口被其他进程占用（例如 `wpa_supplicant`）。
- **ENODEV (19)**：接口已被物理移除或重命名。
