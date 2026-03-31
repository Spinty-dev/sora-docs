# 调试与故障排查 (内核级)

作为一款专业的审计工具，如果没有深度诊断章节，那么它的文档将是不完整的。超越 Python 界面并理解系统调用是 SORA 开发者的核心技能。

## 1. 系统诊断 (`strace`)

`strace` 是了解 SORA 为什么看不到数据包或无法初始化接口的首选工具。

### 网络调用分析
要查看哪些数据包和事件到达了 `AF_PACKET` 套接字：
```bash
# -e network: 仅筛选网络相关调用
# -s 64: 显示前 64 字节数据（通常足以覆盖 802.11 标头）
sudo strace -p $(pgrep sora) -f -e network -s 64
```

### 典型问题：数据包丢失
如果接口处于监听模式 (Monitor Mode)，但 `strace` 未显示 `recvfrom` 调用或返回 `0`：
- **诊断**：短暂运行 `tcpdump -i wlan0mon -n`。如果 `tcpdump` 能看到包而 SORA 不能，问题出在 `sockaddr_ll` 绑定上（参阅 `af_packet.rs`）。
- **nl80211 冲突**：如果 `strace` 对 Netlink 套接字的 `sendto` 调用显示 `EBUSY`，请检查是否存在 `wpa_supplicant` 进程。

:::tip
**Chairman's Tip**：如果接口无法变为 UP 状态，请使用 `strace -e ioctl`。寻找 `EPERM` 错误——这是 `capabilities` 权能未透传至 Python 进程的明确标志。
:::

## 2. 通过 GDB 调试 Rust 核心

由于 SORA 的 Rust 核心是以动态库（通过 PyO3）形式加载到 Python 进程中的，调试需要特殊的方法。

### 附加到进程
1. 正常启动 SORA。
2. 在另一个终端中查找 PID：`ps aux | grep sora`。
3. 启动 GDB：
```bash
sudo gdb -p <PID>
(gdb) directory core/src
(gdb) break packet_engine.rs:122
(gdb) continue
```

在捕获数据包时，GDB 将停止执行。您可以直接在内存中检查 `ParsedFrame` 的状态。

## 3. 硬件与驱动程序特性 (Quirks)

不同的芯片组在处理 `nl80211` 时表现各异。

### 验证监听模式 (Monitor Mode)
如果通过 Netlink 切换监听模式成功但未收到数据包，请检查硬件接口类型：
```bash
iw dev wlan0mon info
```
如果类型显示为 `managed`，则说明驱动程序忽略了 `SET_INTERFACE` 命令。
- **解决方法**：SORA 会自动尝试 `IOCTL fallback`。如果仍然失败，则需要通过 `airmon-ng start` 手动设置模式。

### 信道冲突 (Channel Lock)
如果 SORA 锁定在某个信道，但物理接口仍在跳频：
- 检查 `dmesg | grep nl80211`。
- 某些 Intel 驱动程序 (`iwlwifi`) 如果 `NetworkManager` 正在运行，则不允许强制锁定信道。请使用 `airmon-ng check kill`。

:::info
**严格的技术细节**：始终通过 `uname -a` 检查内核版本。SORA 已针对内核 5.15+ 进行优化，这些版本修复了许多关于 802.11ax (Wi-Fi 6) 的 Netlink 属性错误。
:::

## 4. 系统故障排查

如果问题出在层级边界或原生核心中，请使用以下方法。

### 原生日志 (`RUST_LOG`)
SORA 核心使用 `tracing` 输出调试信息。您可以通过环境变量控制详细程度：
```bash
# 启用核心的所有调试消息
RUST_LOG=debug sora scan -a wlan0
```
- **Error**：关键故障（如打开套接字失败）。
- **Warn**：异常情况（如丢包、信道锁定重试）。
- **Info**：标准事件（如引擎启动）。
- **Debug**：解析和 IPC 详情（如 EAPOL 步骤追踪）。

### IPC 流检查 (NDJSON)
如果 TUI 不显示数据，请验证核心是否正在生成事件。SORA 允许将插件事件流重定向到 `stdout`：
```bash
# 通过 jq 过滤器直接检查 NDJSON
sora scan -a wlan0 --json | jq '.'
```
这允许您在 JSON 对象进入 Python 处理程序之前查看原始数据。

### 残留进程与清理
在极少数情况下（例如 `SIGKILL` 后），`hostapd` 可能会残留在内存中。
```bash
# 查找并清理残留进程
ps aux | grep sora
sudo killall hostapd
```
- **Sora PID**：主进程。
- **hostapd PID**：由 `ConfigManager` 管理的子进程。

:::tip
**进阶说明**：如果您看到 `Device or resource busy` 错误，请检查 `rfkill list` 并确保 `NetworkManager` 或 `wpa_supplicant` 没有尝试以独占模式占用接口。
:::
