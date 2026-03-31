# Python 协调器 (Python Orchestrator)：高级层概览

SORA 的管理层完全使用 Python 语言实现。与精打细算的 Rust 核心不同，Python 层在宏任务级别运行：渲染用户界面、记录会话日志、管理状态机 (FSM) 以及渲染配置。

## 进程分离

Python 不直接从网络接口读取帧，也不会通过高负载计算阻塞主事件循环 (Event Loop)。所有底层网络操作都在已编译的 `sora-core` 库中执行。

协调器仅通过 `EventReceiver.poll_high()` 定期轮询 MPSC 事件队列。

:::danger
**严格合规性声明**：长期日志记录 (Persistence) 和会话分析仅用于合法报告 (Audit Trail) 以及与企业 SIEM 解决方案的集成。捕获的 PCAP 转储以及 PMKID/EAPOL 标记必须在完成 WIDS 系统漏洞评估合同后立即删除。
:::

## 核心组件

### 1. AsyncIO 与 FSM (`controller/`)
系统的控制中心是 `AttackController` 类。它是一个“严谨的有限状态机” (Strict Finite State Machine)，描述了合法的无线审计流程：从无线电扫描 (Scanning) 到模拟攻击 (Attacking) 再到报告生成 (Reporting)。FSM 保证了行为的可预测性，并在发生关键 `AdapterError` 错误时强制清理 (Cleanup) 所有子进程 (hostapd/dnsmasq)。

### 2. 用户界面 (TUI / CLI)
由于 SORA 是设计为通过 SSH 使用的无头 (headless) 工具，图形界面通过 **Textual** 框架直接实现在终端中。
该界面的设计类似于 React 组件：它采用异步工作方式，能够立即向核心发送命令并更新 UI 组件 (DataTable)，而不会中断对 IPC 总线的轮询。

### 3. 会话持久化 (Session Persistence, SQLite)
所有遥测数据都记录在轻量级的 SQLite 数据库中。
- 每个新会话都被分配一个 `session_id`。
- 为了与标准的 Wireshark 集成，Python 层记录了 `pcapng_offset`（帧在 PCAP 文件中的字节偏移量），使安全分析人员能够从 TUI 中一键跳转到相关的帧。
- 凭据 (Credentials) 和哈希值保存在 `credentials` 表中，并汇总到最终的 JSON 报告中。

### 4. 权限卸载 (Privilege Drop)
Python 层最初以 **root** 权限启动。然而，在核心初始化原始套接字并启动所有必要的守护进程 (hostapd, dnsmasq) 后，协调器会立即使用 `nix::unistd::setuid` 强制卸载权限，以符合信息安全原则（最小特权原则）。

有关具体节点的详细信息，请参阅相关的文档章节。
