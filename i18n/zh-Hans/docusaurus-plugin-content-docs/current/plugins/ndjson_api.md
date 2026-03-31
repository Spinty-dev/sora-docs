# NDJSON API 规范（插件子进程 IPC）

在 SORA 中，插件架构是通过**子进程 IPC (Subprocess IPC)** 实现的，其中数据交换遵循 NDJSON 协议。这确保了绝对的隔离，并允许使用任何编程语言，而无需绑定到 Rust 的 ABI 或 Python 的 GIL。

## 1. 事件模式 (Event Schema) (SORA ➔ Plugin)

所有事件都通过插件的标准输入 (`stdin`) 传输。每个事件都是一个以 `\n` 结尾的 JSON 字符串。

### `eapol_captured` 模式
用于在捕获 4 路握手（M1-M4）时。
```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "properties": {
    "event":       {"const": "eapol_captured"},
    "bssid":       {"type": "string", "pattern": "^([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})$"},
    "client":      {"type": "string", "pattern": "^([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})$"},
    "step":        {"type": "integer", "minimum": 1, "maximum": 4},
    "pcap_offset": {"type": "integer", "description": "pcapng 文件中的字节偏移量"},
    "data_hex":    {"type": "string", "description": "十六进制格式的原始 EAPOL 字节"}
  },
  "required": ["event", "bssid", "client", "step", "data_hex"]
}
```

### `beacon_ie_changed` 模式
目标参数变更通知（例如：信道切换或 RSN 变更）。
```json
{
  "event": "beacon_ie_changed",
  "bssid": "...",
  "changed_fields": ["ssid", "channel", "rsn"]
}
```

## 2. 命令模式 (Command Schema) (Plugin ➔ SORA)

命令通过插件的标准输出 (`stdout`) 发送。SORA 异步读取这些命令。

### `cmd_start_deauth` 模式
```json
{
  "command":     "cmd_start_deauth",
  "bssid":       "AA:BB:CC...",
  "client":      "...",
  "count":       10,
  "interval_ms": 100
}
```

## 3. 二进制 I/O 处理（内部机制）

为了确保 Linux 内核级 IPC 的可靠性，SORA 和插件在处理数据流时遵循严格的规则：

- **行缓冲 (Line Buffering)**：SORA 逐行读取插件的 `stdout`。插件**必须**在每次写入后调用 `flush()`（在 Python 中例如使用 `sys.stdout.flush()`），否则命令将一直“滞留”在缓冲区中直到溢出。
- **管道破裂 (BrokenPipe) 处理**：如果插件意外终止，管道 (`stdin`) 将关闭。SORA 会在 Rust/Python 层级检测到 `BrokenPipe` 或 `EPIPE`，并触发 `session_error` 事件及随后的清理程序。
- **非阻塞读取 (Non-blocking read)**：协调器通过 `asyncio.subprocess` 以非阻塞模式读取插件的 `stdout`，防止在插件响应缓慢时阻塞主循环。

:::warning
**严格的技术细节（安全相关）**：SORA 为单个插件消息设置了输入缓冲区上限（通常为 64 KB）。发送超过此大小的 JSON 会导致强制关闭管道，以保护协调器的内存免受拒绝服务攻击。
:::

## 4. 状态规范

插件可以汇报其状态：
- **`plugin_init`**：初始化阶段。
- **`plugin_ready`**：准备好接收事件。
- **`plugin_busy`**：正在执行高负载操作（例如 GPU 破解）。

```json
{"type": "plugin_status", "status": "plugin_ready", "uptime_ms": 42000}
```
