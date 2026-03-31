# Compliance & Regulatory Standards

English | [Русский](/sora-docs/ru/COMPLIANCE) | [中文](/sora-docs/zh-Hans/COMPLIANCE)

---

**SORA (Signals Offensive Radio Auditor)** is designed to assist security professionals in meeting regulatory requirements for wireless infrastructure monitoring and penetration testing.

### 1. PCI DSS v3.2.1 / v4.0 (Requirement 11)
- **Rogue AP Detection (11.2)**: SORA's continuous scanning and `Passive Sniffing` capabilities exceed the standard for identifying unauthorized wireless access points.
- **Penetration Testing (11.3)**: Automating the assessment of Wi-Fi encryption (WPA2/WPA3) and authentication mechanisms directly addresses the requirement for annual external/internal penetration testing.

### 2. ISO/IEC 27001:2022 (A.12.6.1)
- **Technical Vulnerability Management**: SORA provides structured auditing of the wireless perimeter, fulfilling the requirement for proactive detection and management of vulnerabilities in network infrastructure.

### 3. SOC 2 (Security & Confidentiality)
- **Access Control Monitoring**: SORA's `Karma/Mana` engines can be used to simulate and verify that corporate devices are not automatically connecting to untrusted networks, ensuring confidentiality and integrity of data.

### 4. HIPAA / HITECH
- **Transmission Security**: Verification of WPA3 (SAE) implementation and handshake capture validates that Protected Health Information (PHI) is protected by industry-standard encryption during wireless transmission.

### 5. Stealth vs. Clandestine Operation
- **Purpose of StealthEngine**: The traffic obfuscation features (OUI spoofing, interval jitter) are designed to test the effective detection range and sensitivity of **Wireless Intrusion Detection Systems (WIDS/IDS)**.
- **Hardware Agnosticism**: SORA is a software framework that operates via standard operating system network interfaces (`AF_PACKET`, `nl80211`). It does not require or include hardware modifications that transform common Wi-Fi adapters into clandestine surveillance devices.
- **Non-Clandestine Nature**: SORA is an interactive auditing tool and does not provide "secret" or "hidden" installation/operation modes. It is not intended for clandestine information gathering.

---

:::info
**Note:** For legal purposes and international audits, this **English Version** is the primary reference document.
:::
