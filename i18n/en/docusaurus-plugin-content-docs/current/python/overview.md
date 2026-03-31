# Python Orchestrator: High-Level Overview

The SORA management layer is fully implemented in Python. Unlike the Rust core, which scrupulously saves microseconds, the Python layer operates at the macrotask level: interface rendering, session logging, finite state machine (FSM) management, and configuration rendering.

## Process Separation

Python does not read frames from the network interface directly and does not block the main Event Loop with heavy computations. All network operations are carried out in the compiled `sora-core` library.

The orchestrator only periodically polls MPSC event queues via `EventReceiver.poll_high()`.

:::danger
**Strict Compliance Statement**: Long-term logging (Persistence) and session analytics are used exclusively for legal reporting (Audit Trail) and integration with corporate SIEM solutions. Captured PCAP dumps and PMKID/EAPOL markers must be immediately deleted after the completion of the contract with the client regarding WIDS system vulnerability assessment.
:::

## Key Components

### 1. AsyncIO & FSM (`controller/`)
The mission control center of the system is the `AttackController` class. It is a "Strict Finite State Machine" (Strict FSM) that describes a legal audit flow: from scanning the air (Scanning) to attack simulation (Attacking) and report generation (Reporting). The FSM guarantees predictable behavior and mandatory cleanup of all subprocesses (hostapd/dnsmasq) if critical `AdapterError` issues occur.

### 2. User Interface (TUI / CLI)
Since SORA is a headless utility designed for use over SSH, the graphical interface is implemented directly in the terminal using the **Textual** framework. 
The interface is designed like React components: it works asynchronously, instantly sends commands to the core, and updates UI widgets (DataTable) without interrupting the IPC bus polling.

### 3. Session Persistence (SQLite)
All telemetry is recorded in a lightweight SQLite database.
- Each new session is assigned a `session_id`.
- For integration with standard Wireshark, the Python layer records the `pcapng_offset` (byte offset of the frame in the PCAP file), allowing a security analyst to jump directly to the relevant frame from the TUI in a single click.
- Credentials and hashes are saved within `credentials` tables and aggregated into a single JSON Reporting file.

### 4. Privilege Drop
The Python layer starts with **root** privileges. However, immediately after raw socket initialization by the core and spawning all necessary daemons (hostapd, dnsmasq), the orchestrator uses `nix::unistd::setuid` to forcibly drop its privileges for information security purposes (Least Privilege Principle).

For more details on specific nodes, please refer to the relevant sections of the documentation.
