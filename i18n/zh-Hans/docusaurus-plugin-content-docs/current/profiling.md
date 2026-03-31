# 全链路性能分析方法论 (Profiling)

为了确保 10Gbps 级别的性能并处理高负载 Wi-Fi 网络，需要对每个处理阶段的延迟进行深度分析。

## 1. Rust 核心性能分析 (CPU 与内存)

为了寻找数据包解析 (`parsers.rs`) 和队列管理 (`packet_engine.rs`) 中的瓶颈，使用了 `flamegraph`（火焰图）工具。

### 使用 `cargo flamegraph`
这允许可视化调用树以及每个函数所花费的时间。
```bash
# 带有调试符号但启用优化的构建
cargo flamegraph --bin sora-core-tests -- --bench
```
1. **瓶颈 #1：内存分配**。在 `Vec::with_capacity` 或 `String::from_utf8` 中寻找较高的图形。在 Phase 2 中，我们通过零拷贝 (Zero-copy) 技术将其降至最低。
2. **瓶颈 #2：取掩码 (Unmasking)**。Radiotap 标头需要大量的位运算，可以通过 SIMD 指令集进行加速。

## 2. Python 层性能分析 (AsyncIO)

在 Python 层中，关键的不是 CPU 频率，而是事件循环 (Event Loop) 的响应能力。

### 使用 `viztracer`
`viztracer` 非常适合 SORA，因为它能够同时跟踪 AsyncIO 协程和 Rust 的原生系统线程。
```bash
viztracer --attach_installed_ret -m sora scan -a wlan0mon profile.toml
```

### 图形分析：
- **事件间隔 (Event Gap)**：如果 TUI 中 `poll_events` 循环迭代之间的间隔超过 100 毫秒，则意味着数据库 (SQLite) 或插件阻塞了主线程。
- **GC 开销 (GC Overhead)**：从 Rust 传输大量数据时，Python 垃圾回收器活动的激增。

## 3. 测量 IPC 开销（方法论）

为了准确测量通过 PyO3 进行对象编组的延迟，我们使用了“全链路时间戳”方法。

### 延迟公式：
```text
Latency_IPC = T_Python_Recv - T_Rust_Send
```

### 如何测量：
1. **Rust**：在 `self.high_tx.send()` 之前，在 `SoraEvent` 中立即添加 `timestamp_ns` 字段。
2. **Python**：在从 `event_receiver.poll_high()` 返回后立即记录 `time.time_ns()`。
3. **分析**：如果延迟超过 2 毫秒，这是一个关键信号，表明队列过载或 MAC 地址字符串的拷贝效率低下。

## 4. 性能调优指南（内核级）

对于高负载运行模式（实时监控数百个网络），标准的 Linux 内核缓冲区可能会成为瓶颈。建议应用以下 `sysctl` 设置。

### 网络栈优化
在 `/etc/sysctl.conf` 中添加：
```bash
# 增加 RAW 套接字的最大接收缓冲区大小
net.core.rmem_max = 33554432
net.core.rmem_default = 33554432

# 增加接口的数据包队列
net.core.netdev_max_backlog = 10000
```
- **rmem_max**：如果 Rust 核心暂时忙碌（例如在向 PCAP 写入大块数据时），允许内核在 `AF_PACKET` 队列中保留更多数据包。
- **netdev_max_backlog**：防止在流量突发期间在驱动程序级别丢包。

## 5. 优化总结

| 组件 | 工具 | 目标 (Baseline) |
| :--- | :--- | :--- |
| **Rust 内核** | `cargo flamegraph` | 每帧 < 10μs (不含 PCAP) |
| **Python TUI** | `viztracer` | GUI > 60 FPS |
| **IPC 桥接** | `py-spy` | 延迟 < 1ms |
| **SQLite I/O** | `iostat` | < 100 IOPS |

:::tip
**进阶说明**：对于 Phase 4 (Karma)，IPC 延迟至关重要。对 Probe Request 的任何响应都必须比亚广合法的访问点响应得快（通常 < 100 毫秒）。对象编组优化和协议栈调优是赢得“无线电竞赛” (Radio Race) 的唯一途径。
:::
