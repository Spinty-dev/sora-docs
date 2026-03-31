# SORA — 信号进攻性无线审计器 (SORA)

[English](/sora-docs/en/) | [Русский](/sora-docs/ru/) | 中文

---

**SORA** 是一个用于深度无线（Wi-Fi）安全审计和渗透测试的高性能框架。SORA 的设计侧重于超低抖动、隐身性和最大灵活性，在系统层面结合了 Rust 的强大功能与 Python 的编排能力。

:::danger
**警告：** 本工具仅用于教育目的和授权的安全审计。使用前，请阅读 [法律声明](DISCLAIMER.md)。
:::

---

## 🚀 核心功能 (v4.4+)

### 🦀 Rust 核心
- **高性能注入**：实时线程 (`SCHED_FIFO`) 实现零延迟帧注入。
- **即时验证**：在捕获流中实时验证 4-way 握手 (4-way handshake) 和 MIC。
- **StealthEngine (隐身引擎)**：高级流量混淆 — OUI 欺骗、时间间隔抖动 (20-40%) 和 TX 突发上限，以规避 WIDS/IDS (Kismet, Cisco WIPS)。
- **多适配器准备**：支持 `Sniffer` (wlan0mon) 和 `Injector` (wlan1) 的专用角色。

### 🐍 Python 层
- **智能 TOML 配置**：自动化攻击，从简单的取消认证 (Deauth) 到复杂的邪恶孪生 (Evil Twin) 场景。
- **事件驱动 IPC**：通过 PyO3 将实时事件从 Rust 流式传输到 Python，具有优先级队列和背压管理功能。
- **插件系统 (MIT)**：高度可扩展的架构，用于通知 (Telegram)、自动暴力破解 (Hashcat) 和强制门户 (Captive Portal)。
  - **NDJSON IPC**：SORA 核心与插件之间通过标准输入/输出的 NDJSON 协议进行通信。
  - **插件角色**：支持 `Observer` (观察者, 通知)、`Actor` (执行者, 可发送回命令) 和 Phase 4 `Transformer` (转换者, 实时帧处理)。

### 📡 高级攻击引擎 (Phase 4)
- **Evil Twin 2.0 (邪恶孪生)**：实时 Beacon IE 克隆、自适应 hostapd 实例管理和客户端取消认证/推送。
- **Karma/Mana 引擎**：Probe Request 响应时间低于 1 毫秒。
- **Beacon Flooding (信标洪水)**：使用 `sendmmsg()` 以最小的 CPU 开销同时生成数千个 AP。
- **SAE 过滤器**：WPA3 (SAE) Commit/Confirm 握手截获。

---

## 🛠 快速开始

### 前提条件
- 操作系统：Kali Linux / Parrot OS / Arch Linux。
- 特权：`root` 或 `CAP_NET_RAW`/`CAP_NET_ADMIN`。
- 依赖项：`hostapd`, `dnsmasq`, `hcxpcapngtool`, `hashcat` (可选)。

### 安装
```bash
# 克隆仓库
git clone https://github.com/Spinty-dev/SORA.git
cd SORA

# 运行设置脚本 (自动创建 venv 并构建 Rust 核心)
./sora.sh build
```

### 使用
```bash
./sora.sh run --profile quick_scan.toml
```

---

## 🏗 架构

有关无线审计标准和监管合规性的信息，请参阅 [合规性与标准](COMPLIANCE.md)。

---

## ⚖️ 许可

- **核心与 Python 层**：[GNU GPL v3](LICENSE.md)。
- **插件**：[MIT](plugins/LICENSE.md) — 为您的扩展提供充分的自由。

---

*由 SORA 团队为研究目的创建。*
