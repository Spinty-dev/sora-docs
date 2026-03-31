# SORA — 信号攻防无线审计器 (Signals Offensive Radio Auditor)

[English](./index.md) | [Русский](README_RU.md) | 中文

---

**SORA** 是一个用于无线网络 (Wi-Fi) 深度审计和渗透测试的高性能框架。SORA 专注于超低抖动、隐蔽性和最大的灵活性，在系统层面结合了 Rust 的强大性能和 Python 的编排灵活性。

> [!CAUTION]
> **警告：** 本工具仅用于教育目的和授权安全审计。在使用前，请阅读 [法律免责声明](./DISCLAIMER.md)。

---

## 🚀 核心特性 (v4.4+)

### 🦀 Rust 核心 (Core)
- **高性能注入**: 使用实时线程 (`SCHED_FIFO`) 实现零延迟帧注入。
- **实时验证**: 在捕获流中实时验证四次握手 (4-way handshake) 和 MIC。
- **隐蔽引擎 (StealthEngine)**: 先进的流量混淆技术 —— OUI 欺骗、间隔抖动 (20-40%) 和 TX 突发限制，以规避 WIDS/IDS (如 Kismet, Cisco WIPS)。
- **多适配器支持**: 支持 `嗅探器` (Sniffer, wlan0mon) 和 `注入器` (Injector, wlan1) 的角色分离。

### 🐍 Python 层 (Orchestration)
- **智能 TOML 配置**: 自动执行从简单的取消验证 (Deauth) 到复杂的邪恶孪生 (Evil Twin) 方案。
- **事件驱动 IPC**: 通过 PyO3 实现 Rust 到 Python 的实时事件流，具备优先级队列和背压 (Backpressure) 管理。
- **插件系统 (MIT)**: 高度可扩展的架构，支持通知 (Telegram)、自动爆破 (Hashcat) 和强制门户 (Captive Portal)。
  - **NDJSON IPC**: SORA 与插件之间通过 NDJSON 协议（标准输入/输出）进行通信。
  - **Plugin Roles**: 支持 `Observer` (单向读取)、`Actor` (双向交互) 和 `Transformer` (Phase 4: 实时数据包处理)。

### 📡 先进攻击引擎 (Phase 4)
- **邪恶孪生 2.0 (Evil Twin)**: 实时 Beacon IE 克隆、自适应 hostapd 实例管理和客户端强制迁移。
- **Karma/Mana 引擎**: Probe Request 响应时间小于 1ms。
- **Beacon 洪水 (Flooding)**: 使用 `sendmmsg()` 同时生成数千个 AP，CPU 开销极小。
- **SAE 过滤器**: 拦截 WPA3 (SAE) Commit/Confirm 握手。

---

## 🛠 快速上手

### 前提条件
- 操作系统: Kali Linux / Parrot OS / Arch Linux。
- 权限: `root` 或 `CAP_NET_RAW`/`CAP_NET_ADMIN` 权限。
- 依赖项: `hostapd`, `dnsmasq`, `hcxpcapngtool`, `hashcat` (可选)。

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

## 🏗 架构说明

关于内部实现、IPC 方案和攻击引擎逻辑的详细文档，请参阅 [SORA Architecture v4.4](./SORA_architecture_v4_4.md)。有关无线审计标准及合规性的信息，请参阅 [合规性与标准](COMPLIANCE.md)。

---

## ⚖️ 许可协议

- **核心与 Python 层**: [GNU GPL v3](./LICENSE.md)。
- **插件**: [MIT](../plugins/LICENSE) — 为您的扩展提供完全自由。

---

*由 SORA 团队开发，用于研究目的。*
