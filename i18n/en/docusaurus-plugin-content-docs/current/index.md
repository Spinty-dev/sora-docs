# SORA — Signals Offensive Radio Auditor

English | [Русский](/sora-docs/ru/) | [中文](/sora-docs/zh-Hans/)

---

**SORA** is a high-performance framework for deep wireless (Wi-Fi) security auditing and penetration testing. Designed with a focus on ultra-low jitter, stealth, and maximum flexibility, SORA combines the power of Rust at the system level with Python for orchestration.

:::danger
**WARNING:** This tool is intended for educational purposes and authorized security auditing ONLY. Before use, read the [Legal Disclaimer](DISCLAIMER.md).
:::

---

## 🚀 Key Features (v4.4+)

### 🦀 Rust Core
- **High-Performance Injection**: Real-time threads (`SCHED_FIFO`) for zero-delay frame injection.
- **On-the-fly Validation**: Validation of 4-way handshakes and MIC in real-time within the capture stream.
- **StealthEngine**: Advanced traffic obfuscation — OUI spoofing, interval jitter (20-40%), and TX burst capping to evade WIDS/IDS (Kismet, Cisco WIPS).
- **Multi-Adapter Ready**: Supports dedicated roles for `Sniffer` (wlan0mon) and `Injector` (wlan1).

### 🐍 Python Layer
- **Smart TOML Profiles**: Automation of attacks from simple Deauth to complex Evil Twin scenarios.
- **Event-Driven IPC**: Real-time event streaming from Rust to Python via PyO3 with prioritized queues and backpressure management.
- **Plugin System (MIT)**: Highly extensible architecture for notifications (Telegram), auto-bruteforce (Hashcat), and Captive Portal.
  - **NDJSON IPC**: Communication between SORA core and plugins via NDJSON protocol over stdin/stdout.
  - **Plugin Roles**: Supports `Observer` (notifications), `Actor` (can send commands back), and Phase 4 `Transformer` (Real-time frame processing).

### 📡 Advanced Attack Engines (Phase 4)
- **Evil Twin 2.0**: Real-time Beacon IE cloning, adaptive hostapd instance management, and client deauth/push.
- **Karma/Mana Engine**: Probe Request response time under 1ms.
- **Beacon Flooding**: Generation of thousands of APs simultaneously using `sendmmsg()` with minimal CPU overhead.
- **SAE Filter**: WPA3 (SAE) Commit/Confirm handshake interception.

---

## 🛠 Quick Start

### Prerequisites
- OS: Kali Linux / Parrot OS / Arch Linux.
- Privileges: `root` or `CAP_NET_RAW`/`CAP_NET_ADMIN`.
- Dependencies: `hostapd`, `dnsmasq`, `hcxpcapngtool`, `hashcat` (optional).

### Installation
```bash
# Clone the repository
git clone https://github.com/Spinty-dev/SORA.git
cd SORA

# Run the setup script (automatically creates venv and builds Rust core)
./sora.sh build
```

### Usage
```bash
./sora.sh run --profile quick_scan.toml
```

---

## 🏗 Architecture

For information on wireless auditing standards and regulatory compliance, see [Compliance & Standards](COMPLIANCE.md).

---

## ⚖️ Licensing

- **Core & Python Layer**: [GNU GPL v3](LICENSE.md).
- **Plugins**: [MIT](plugins/LICENSE.md) — full freedom for your extensions.

---

*Created for research purposes by the SORA Team.*
