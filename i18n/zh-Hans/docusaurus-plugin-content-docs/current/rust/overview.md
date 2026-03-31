---
title: 核心架构概览
sidebar_label: 核心概览 (Core)
---
# 核心架构概览 (Rust Core)

SORA 项目核心 (`sora-core`) 是一个使用 Rust 编写的编译库，通过 **PyO3** 接口集成到 Python 环境中。核心的主要目的是执行需要微秒级精度网络操作，避免 Python 典型的垃圾回收 (GC) 暂停。

:::danger
**严格合规性声明**: SORA 核心仅执行明文 802.11 标头的句法分析（解析）。核心模块不包含用于解密 WEP/WPA/WPA2/WPA3 (CCMP/TKIP) 的加密功能。该项目是一个被动/主动协议审计器，而不是有效载荷解密工具。
:::

## 模块结构

核心架构被划分为具有严格定义关注点分离的隔离子系统：

- **`engine` (`packet_engine`, `af_packet`, `tx_dispatch`)**：系统的核心。负责打开 `AF_PACKET` 套接字、在循环中读取原始帧（零拷贝/最小分配）以及流量调度。
- **`ipc` (`commands`, `events`)**：进程间通信拓扑。通过 `std::sync::mpsc`（待替换为 `crossbeam-channel`）实现消息传递模式。
- **`nl80211` (`controller`, `neli_backend`)**：无线接口配置（信道切换、辅助监视模式、TX 功率设置）的 Netlink 套接字系统抽象。
- **`adapter` (`channel_lock`, `error_recovery`)**：用于处理硬件网卡错误和握手捕获期间信道锁定状态的有限状态机 (FSM)。
- **`pcap` (`writer`)**：以 `pcapng` 格式（支持偏移）异步记录捕获的流量。

## 与 Python 集成 (PyO3)

核心的入口点定义在 `core/src/lib.rs` 中。当 `sora_core` 模块被导入 Python 时，会调用 `#[pymodule]` 配置器，注册全局常量和函数。

### 初始化 (start_engine)

`start_engine` 函数启动后台 `PacketEngine` 线程，并返回一个包含控制句柄对象和事件通道 (Rx) 的元组。

```rust
#[pyfunction]
fn start_engine(interface: &str, pcap_path: &str) -> PyResult<(engine::packet_engine::PacketEngineHandle, ipc::events::EventReceiver)> {
    let engine = std::sync::Arc::new(
        engine::packet_engine::PacketEngine::new(interface, pcap_path)
            .map_err(|e| pyo3::exceptions::PyRuntimeError::new_err(e.to_string()))?
    );
    let rx = engine.event_receiver(); // 用于接收事件 (Beacon, Eapol) 的通道
    engine.start(); // 产生 OS 线程
    
    let handle = engine::packet_engine::PacketEngineHandle::new(engine);
    Ok((handle, rx))
}
```

### 模块绑定

来自协调器（取消认证、频率更改）的所有同步命令都通过全局函数传递，这些函数向 MPSC 通道发送消息（参见 `通信 (IPC)` 部分）。

```rust
#[pymodule]
fn sora_core(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add("__version__", VERSION)?;
    m.add("API_VERSION", API_VERSION)?;

    // 核心初始化
    m.add_function(wrap_pyfunction!(start_engine, m)?)?;
    
    // 命令总线
    m.add_function(wrap_pyfunction!(ipc::commands::cmd_start_deauth, m)?)?;
    m.add_function(wrap_pyfunction!(ipc::commands::cmd_lock_channel, m)?)?;
    m.add_function(wrap_pyfunction!(ipc::commands::cmd_shutdown, m)?)?;

    // 类映射器
    m.add_class::<ipc::events::EventReceiver>()?;
    m.add_class::<engine::packet_engine::PacketEngineHandle>()?;

    Ok(())
}
```

## 线程模型

1. **主线程 (Python)**：管理 UI（通过 Textual）和高级逻辑（AttackController FSM）。
2. **Sora-Packet-Engine 线程 (Rust)**：拥有原始 `AF_PACKET` 套接字。在 `recv()` 调用上阻塞。保证对传入 802.11 帧的微秒级反应。
3. **Pcap 刷新线程 (Rust)** (在 `PcapWriter` 内部)：在环形缓冲区中接收数据包副本，并在高 I/O 等待期间异步将其刷新到磁盘，以避免阻塞数据包引擎。

以下部分详细介绍了每个组件的设计。
