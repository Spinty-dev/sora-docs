# SORA — Signals Offensive Radio Auditor
## Architecture v4.4

> **Changelog vs v4.3:**
> — **TOML duplication eliminated:** `our_channel` and `beacon_interval_tu` are the sole sources of truth; `[attack.evil_twin.hostapd]` no longer contains `channel`/`beacon_int` — `config_manager.py` populates them automatically.
> — **EvilTwinEngine + hostapd separated by responsibility:** hostapd manages association and sends Beacons; `EvilTwinEngine` is removed from the Beacon injection path when hostapd is active. `BeaconCloner` now feeds `config_manager.py` instead of `EvilTwinEngine` directly. SeqNum conflict resolved.
> — **Behavior before first Beacon fixed:** Evil Twin remains silent until the first Beacon is received from the target; Python receives an `evil_twin_waiting` event; timeout is configurable.
> — **TxDispatch fair drain:** the priority queue is drained for a maximum of N frames per iteration (default N=8), then one Normal frame is sent — ensuring `EvilTwinEngine` doesn't starve.
> — **`clients` table added to the SQLite schema.**
> — **`pcapng_offset` semantics fixed:** byte offset of the start of the pcapng block from the start of the file.
> — **Privilege drop and privileged plugins:** clarification that `captive_portal` spawns before the drop and inherits root; alternative — `sudoers.d` fragment.
> — **iptables cleanup fixed:** targeted deletion via `-D` instead of `-F PREROUTING`.
> — **KarmaEngine filters own frames:** `src_mac == our_bssid` → drop.
> — **SAEFilter direction detection documented:** determined by Transmitter Address vs known target BSSID.

---

## 1. Goals

| Goal | Solution |
| :--- | :--- |
| Minimal injection jitter | Rust RT threads, raw sockets |
| Zero handshake loss | On-the-fly MIC/EAPOL validation in Rust |
| Scenario flexibility | Python controller + TOML profiles |
| Plugin isolation | `process`-mode only |
| Single and multi-adapter support | Adapter Abstraction Layer + Channel Lock → AdapterRegistry (Phase 4) |
| Adapter fault tolerance | FSM Adapter Error state + auto-restart |
| MITM and credential harvesting | Evil Twin + Captive Portal (Phase 4) |
| AP-less client hunting | Karma/Mana — Probe Request response (Phase 4) |
| WPA3 Interception | SAEFilter: Commit/Confirm state machine (Phase 4) |
| Obfuscation / confusion attack | Beacon Flooding: thousands of APs in the air (Phase 4) |
| Invisibility to IDS/WIDS | StealthEngine: TX burst limiting, interval randomization, OUI spoofing (Phase 4) |

---

## 2. Architecture: Layers and Responsibilities

### 2.1 Rust Core

#### Adapter Abstraction Layer (AAL)

Abstraction over the physical Wi-Fi interface.

- **AdapterHandle** — descriptor of a single adapter with its capabilities (`inject`, `monitor`). Role registry will appear in Phase 4 (multi-adapter).
- **Fallback** — a single adapter takes both roles with an active Channel Lock.
- **Adapter Error Recovery** — upon interface loss (`ENODEV`, `ENETDOWN`), AAL emits an `adapter_error` event and attempts to bring the interface back up (3 attempts, backoff 1/2/5 sec). If unsuccessful — FSM transitions to `Error`.

**Channel Lock (single-adapter mode):**
At attack start, `PacketEngine` calls `AAL::lock_channel(channel)` — the nl80211 controller suspends hopping. After the attack or upon timeout — `AAL::unlock_channel()`. In multi-adapter mode (Phase 4), locking is unnecessary — Sniffer and Injector operate on different channels independently.

**AdapterRegistry (Phase 4):**
Replaces AdapterHandle. Two adapters with explicit roles: `Sniffer` (monitoring, wlan0mon) and `Injector` (injection/AP, wlan1). Channel Lock is removed from the code.

#### nl80211 Interface Controller

Interface management via `nl80211` (`libnl` / `neli`). `ioctl` is a fallback for legacy drivers only, with auto-detection via an nl80211-command attempt.

- Switch to monitor mode
- **Channel Hopping:** Round-Robin across a specified channel list. Upon detecting target BSSID activity — delay `dwell_ms` on that channel (configurable in TOML, default **500 ms**).
- TX power management
- Channel Lock API

> **Why dwell_ms = 500 ms (not 3000):** A full 4-way handshake takes 50–200 ms. At 3000 ms with 3 channels, the cycle = 9+ sec — the client manages to complete the handshake and leave before the next pass. 500 ms ensures handshake capture with a cycle < 2 sec for a typical channel set [1, 6, 11].

#### Packet Engine

- **Raw Socket Capture** — capture 802.11 frames with minimal allocations.
- **RT Injection Thread** — `SCHED_FIFO` / `SCHED_RR`.
- **On-the-fly Validation** — validation of handshake completeness and MIC directly in the capture stream.
- **Built-in Detectors (passive):** Rogue AP, PMKID Sniffer.
- **Phase 4 Engines** (activated if AdapterRegistry is present):
  - `BeaconCloner` — parsing and tracking target AP Beacon IE changes; feeds `config_manager.py` upon changes.
  - `KarmaEngine` — instant response to Probe Requests (< 1 ms).
  - `SAEFilter` — capture WPA3 SAE Commit/Confirm with ACT handling.
  - `BeaconFloodEngine` — generating thousands of fake Beacons via `sendmmsg`.
  - `StealthEngine` — TX rate limiting, interval randomization, MAC/OUI spoofing (see Section 2.6.5).

#### PCAP Writer

The RT thread places frames into a fixed-size `crossbeam::ArrayQueue` (**capacity: 4096 frames**, ~6 MB for an average 1500-byte frame). A separate low-priority Writer thread drains the queue and writes to disk (`O_DSYNC`).

Upon overflow — `pcap_buffer_overflow` event, frames are dropped (RT threads are not blocked). Graceful shutdown: Writer finishes writing the buffer and closes the file before termination.

---

### 2.2 IPC: Rust → Python (Events)

PyO3 + `crossbeam_channel` bounded MPSC. Rust filters aggressively before sending.

**Backpressure Strategy:**
The channel is split into two priorities:

| Channel | Capacity | Content | Upon Overflow |
| :--- | :--- | :--- | :--- |
| `high_priority` | 64 | EAPOL frames, `adapter_error`, `sae_complete`, `evil_twin_waiting`, `evil_twin_ready` | Block Rust (max 5 ms, then drop with log) |
| `normal` | 512 | Beacon deltas, Probe Requests, detector events, `karma_response` | Drop with `ipc_drop_count` increment |

Python reads `high_priority` first in each event loop iteration. The drop count is displayed in the TUI.

**Event Versioning:**
Each event carries `api_version: u8` (current = 4). Python rejects events with incompatible versions and logs a warning — no panic.

**Filtering (what goes to Python, what stays in Rust):**

| Event | Channel | Note |
| :--- | :--- | :--- |
| EAPOL frames (all 4 steps) | `high_priority` | |
| `adapter_error` | `high_priority` | |
| `sae_complete` | `high_priority` | Only full exchange (4 frames) |
| `evil_twin_waiting` | `high_priority` | No Beacon from target; data: `{bssid, elapsed_ms}` |
| `evil_twin_ready` | `high_priority` | First Beacon received, hostapd restarted |
| `beacon_ie_changed` | `normal` | BeaconCloner detected IE change; data: `{bssid, changed_fields[]}` → Python calls `config_manager.reload()` |
| Probe Request (associated clients) | `normal` | |
| `karma_response` | `normal` | Which SSID was requested by the client |
| Detector events (Rogue AP, PMKID) | `normal` | |
| Data frames, duplicate Beacons, ACK | remain in Rust | |

---

### 2.3 IPC: Python → Rust (Commands)

Python commands Rust via the **synchronous PyO3 Command API** — direct calls to Rust functions exported via `#[pyfunction]`. No separate back-channel is needed: PyO3 already provides calling Rust from Python as a regular function call.

All functions are **non-blocking**: they place a `Command` into a separate bounded MPSC (capacity: 32) and immediately return control to Python. The Rust thread reads the command channel in its loop — without blocking RT.

```rust
// core/src/ipc/commands.rs

// --- Phase 1–3: Basic Commands ---
#[pyfunction] pub fn cmd_start_deauth(bssid: &str, client: Option<&str>, count: u32, interval_ms: u64) -> PyResult<()>
#[pyfunction] pub fn cmd_stop_deauth(bssid: &str) -> PyResult<()>
#[pyfunction] pub fn cmd_lock_channel(channel: u8) -> PyResult<()>
#[pyfunction] pub fn cmd_unlock_channel() -> PyResult<()>
#[pyfunction] pub fn cmd_set_channel(channel: u8) -> PyResult<()>
#[pyfunction] pub fn cmd_shutdown() -> PyResult<()>

// --- Phase 4: Evil Twin ---
// Starts BeaconCloner on target. hostapd starts the Python layer after the evil_twin_ready event.
// Channel and interval parameters are taken from TOML via config_manager, not passed here.
#[pyfunction] pub fn cmd_evil_twin_start(target_bssid: &str, waiting_timeout_ms: u32) -> PyResult<()>
#[pyfunction] pub fn cmd_evil_twin_stop() -> PyResult<()>

// --- Phase 4: Karma/Mana ---
#[pyfunction] pub fn cmd_karma_start(mode: &str, tx_channel: u8, ssid_blacklist: Vec<String>, ssid_whitelist: Option<Vec<String>>) -> PyResult<()>
#[pyfunction] pub fn cmd_karma_stop() -> PyResult<()>

// --- Phase 4: Beacon Flooding ---
#[pyfunction] pub fn cmd_beacon_flood_start(ap_count: u32, ssid_mode: &str, ssid_file: Option<&str>, channel: u8, oui_pool: Vec<String>) -> PyResult<()>
#[pyfunction] pub fn cmd_beacon_flood_stop() -> PyResult<()>

// --- Phase 4: Stealth ---
#[pyfunction] pub fn cmd_stealth_set(profile: &str) -> PyResult<()>  // "off" | "low" | "medium" | "high"
```

**Error Handling:** if Command MPSC is full — `cmd_*` returns `PyErr` with `RuntimeError("command queue full")`. Python logs a WARNING and retries after 50 ms. No panic.

> **Why not a separate reverse MPSC?** PyO3 is already a bridge — Python calls Rust directly. Command MPSC is only needed to make the PyO3 call non-blocking and not slow down Python AsyncIO.

---

### 2.4 Complete IPC Diagram

```
Python AttackController
    │  cmd_*(...)  via PyO3 direct call
    ▼
Command MPSC (cap=32, non-blocking)
    │
    ▼
PacketEngine loop (Rust)
    │                         ┌──── AAL::lock_channel()
    ├── dispatch Command ──►  ├──── AAL::set_channel()
    │                         ├──── start/stop deauth RT-thread
    │                         ├──── BeaconCloner start/stop (Evil Twin)
    │                         ├──── KarmaEngine start/stop
    │                         ├──── BeaconFloodEngine start/stop
    │                         └──── StealthEngine::set_profile()
    │
    │   event filter
    ├──────────────────► high_priority MPSC (cap=64)  ──────────────┐
    │                    [EAPOL, adapter_error, sae_complete,        │
    │                     evil_twin_waiting, evil_twin_ready]        │
    │                                                                │
    ├──────────────────► normal MPSC (cap=512) ─────────────────────┤
    │                    [beacon_ie_changed, Probe Req,              │
    │                     karma_response, detectors]                 ▼
    │                                                    Python AsyncIO
    │                                                    (high first per tick)
    │                                                    AttackController (FSM)
    │                                                         │
    │                                           evil_twin_ready → config_manager.reload()
    │                                                              → hostapd SIGHUP/restart
    │                                           beacon_ie_changed → config_manager.reload()
    │                                                              → hostapd SIGHUP
    │                                                    PluginBus → plugins
    │
    ├── BeaconCloner ──► beacon_ie_changed event ──► normal MPSC
    │           │
    │           └── (at start) ──► evil_twin_ready ──► high_priority MPSC
    │
    ├── KarmaEngine ──────────────────────────────────────────────┐
    │                                                              │
    ├── BeaconFloodEngine ──────────────────────────────────────┐  │
    │                                                            │  ▼
    │                                               TxQueue MPSC (priority cap=64, normal cap=1024)
    │                                               TxDispatch thread (SCHED_FIFO)
    │                                               fair drain: max 8 priority → 1 normal
    │                                               StealthEngine (rate limiting)
    │                                                    │
    │                                               raw socket (Injector)
    │
    ├── SAEFilter ──► sae_complete ──► high_priority MPSC
    │
    └── PcapWriter ──► ArrayQueue(4096) ──► Writer ──► .pcapng
                                                       MetadataDB (SQLite)
```

---

### 2.5 Python Layer

#### Config & Profile Manager

TOML profiles. **Sole Source of Truth Rule:** `attack.evil_twin.our_channel` and `attack.evil_twin.beacon_interval_tu` are canonical values. `config_manager.py` takes them from there when rendering `hostapd.conf` and never reads `channel`/`beacon_int` from `[attack.evil_twin.hostapd]` — these fields must not be in that section; if present, a WARNING is logged and they are ignored.

```toml
[session]
targets = ["AA:BB:CC:DD:EE:FF"]
channels = [1, 6, 11]
adapters = ["wlan0"]

[attack.deauth]
enabled = true
count = 5
interval_ms = 100

[attack.channel_hopping]
dwell_ms = 500

[attack.handshake]
wordlists = ["/usr/share/wordlists/rockyou.txt"]

# Phase 4: Evil Twin
[attack.evil_twin]
enabled = false
our_channel = 11             # Source of truth for twin channel
beacon_interval_tu = 98      # Source of truth for Beacon interval
waiting_timeout_ms = 10000   # How long to wait for first Beacon from target before error

# hostapd parameters. Channel and beacon_int are NOT specified — config_manager.py
# takes them from attack.evil_twin above. Unknown fields → WARNING + ignore.
# Mandatory fields for rendering: hw_mode. Others are optional.
[attack.evil_twin.hostapd]
hw_mode = "g"          # a | b | g
ieee80211n = true      # enable 802.11n (HT)
ieee80211ac = false    # enable 802.11ac (VHT); requires hw_mode="a"
wmm_enabled = true     # WMM/QoS — mandatory for 802.11n
max_num_sta = 64

# Phase 4: Karma/Mana
[attack.karma]
enabled = false
mode = "Mana"          # Karma | Mana | ManaLoud (experimental — see Section 2.6.2)

# Phase 4: Beacon Flooding
[attack.beacon_flood]
enabled = false
ap_count = 500
ssid_mode = "dictionary"

# Phase 4: Stealth / Anti-Detection
[attack.stealth]
profile = "medium"     # off | low | medium | high

[plugins]
active = ["telegram_notify", "auto_crack"]
```

#### Attack Controller (FSM)

**4 states** + sub-states within `Attacking` (Phase 4):

```
Idle ──► Scanning ──► Attacking ──► Reporting
           │               │
           └──── Error ◄───┘

Attacking (sub-states):
  ├── Attacking::Deauth        (Phase 3: deauthentication)
  ├── Attacking::EvilTwin      (Phase 4: waiting for Beacon / twin active)
  ├── Attacking::Karma         (Phase 4: hunting for Probe Requests)
  └── Attacking::Passive       (capture only, no injection)
```

| Transition | Trigger |
| :--- | :--- |
| `Idle → Scanning` | Profile start |
| `Scanning → Attacking` | Target BSSID found |
| `Attacking → Scanning` | Handshake captured or attack timeout |
| `Attacking → Reporting` | Explicit user command |
| `* → Error` | `adapter_error` after retry exhaustion; `evil_twin_waiting` timeout |
| `Error → Idle` | Manual reset or successful adapter auto-restart |

State in memory. Upon graceful shutdown (`Ctrl+C`) — dump to JSON next to `.pcapng`.

#### Error State Cleanup

Upon transitioning to `Error`, AttackController performs a strictly ordered cleanup:

1. **Stop active attacks:** `cmd_stop_deauth`, `cmd_evil_twin_stop`, `cmd_karma_stop`, `cmd_beacon_flood_stop` — for each active attack. Errors are ignored.
2. **Release Channel Lock:** `cmd_unlock_channel()`.
3. **Close PCAP file:** `cmd_shutdown()` in PcapWriter. Partial `.pcapng` is saved — it is valid.
4. **Record in SQLite:** session `status = "error"`, `ended_at = now()`. Captured handshakes and SAE captures remain.
5. **Dump FSM state** to JSON.
6. **Notify plugins:** `session_error` event on Plugin Bus (timeout 500 ms).
7. **If Captive Portal is active:** plugin receives `session_error` and performs its own cleanup (see Section 2.6.3).

Total cleanup timeout: **3 seconds**.

#### Session Resume / Partial Capture Recovery

**Explicitly out of scope.**

Upon abnormal termination, a valid `.pcapng` and an SQLite entry with status `error` remain on disk. "Resuming" capture is impossible: the radio environment state is non-reproducible — clients could have switched channels, changed PMKIDs, or terminated associations.

**What is supported:**
- Partial `.pcapng` remains readable — `hcxpcapngtool` correctly handles files with a break at the end.
- Manual import via `sora import --pcapng session_42.pcapng` — creates a new SQLite entry from an existing file (Phase 4+).

**What is not supported:** automatic capture resumption, recovery of in-progress SAE state machine, merging two `.pcapng` files from one logical session.

#### Client Tracking

Only clients actually associated with target BSSIDs (Data frames, QoS Data, Authentication, Association). Probe Requests with randomized MACs are filtered in Rust. Karma clients (associated with our twin) are tracked separately — `source = "karma"` field in the `clients` table.

#### Metadata Storage (SQLite)

```sql
-- Core (Phase 1–3)
CREATE TABLE sessions (
    id           INTEGER PRIMARY KEY,
    timestamp    TEXT NOT NULL,
    pcapng_path  TEXT NOT NULL,
    profile_name TEXT,
    status       TEXT DEFAULT 'active'  -- active | completed | error
);

CREATE TABLE bssids (
    session_id  INTEGER REFERENCES sessions(id),
    bssid       TEXT NOT NULL,
    ssid        TEXT,
    channel     INTEGER,
    encryption  TEXT,          -- WPA2 | WPA3 | WPA3-Transition | Open
    oui_vendor  TEXT
);

-- Clients associated with target BSSIDs (not Probe Requests)
CREATE TABLE clients (
    id          INTEGER PRIMARY KEY,
    session_id  INTEGER REFERENCES sessions(id),
    bssid       TEXT NOT NULL,    -- AP associated with
    client_mac  TEXT NOT NULL,
    source      TEXT DEFAULT 'passive',  -- passive | karma
    first_seen  TEXT NOT NULL,
    last_seen   TEXT NOT NULL
);

CREATE TABLE handshakes (
    session_id    INTEGER REFERENCES sessions(id),
    bssid         TEXT NOT NULL,
    -- byte offset of start of pcapng Enhanced Packet Block from start of file;
    -- used for direct navigation in TUI and report.
    -- NULL if offset was not recorded (old sessions).
    pcapng_offset INTEGER,
    captured_at   TEXT NOT NULL
);

CREATE TABLE crack_results (
    handshake_id  INTEGER REFERENCES handshakes(id),
    status        TEXT,         -- cracked | failed | in_progress
    passphrase    TEXT,
    cracker       TEXT,         -- hashcat | john
    duration_sec  INTEGER
);

-- Phase 4 additions
CREATE TABLE sae_captures (
    id             INTEGER PRIMARY KEY,
    session_id     INTEGER REFERENCES sessions(id),
    bssid          TEXT NOT NULL,
    client         TEXT NOT NULL,
    commit_ap      BLOB,
    commit_client  BLOB,
    confirm_ap     BLOB,
    confirm_client BLOB,
    had_act        BOOLEAN,
    -- byte offset of start of first SAE Authentication pcapng block from start of file.
    -- NULL if not recorded.
    pcapng_offset  INTEGER,
    captured_at    TEXT NOT NULL
);

CREATE TABLE credentials (
    id              INTEGER PRIMARY KEY,
    session_id      INTEGER REFERENCES sessions(id),
    client_ip       TEXT,
    client_mac      TEXT,
    portal_template TEXT,
    data            TEXT,        -- JSON: {"password": "...", "username": "..."}
    captured_at     TEXT NOT NULL
);
```

> **`pcapng_offset`:** byte offset of the start of the pcapng Enhanced Packet Block (EPB) from the start of the file. This allows the TUI and HTML report to generate a direct link to the packet (`wireshark session.pcapng -Y "frame.offset==N"`). The field is populated by PcapWriter when recording each relevant frame. A NULL value in old sessions or upon write error is not critical; the packet can always be found by `captured_at`.

> **Credentials storage:** the `data TEXT` field contains credentials in JSON **plaintext**. A deliberate decision: SORA is a pentest tool; data goes into the customer report. For compliance requirements, **SQLCipher** is available (`rusqlite` with feature `bundled-sqlcipher`, key via `PRAGMA key`). This path is not supported in the current version and is left to the discretion of the operator.

#### Privilege Drop and Privileged Plugins

After initializing raw sockets and netlink, SORA drops privileges. This creates a problem: the `captive_portal` plugin requires root for `hostapd`, `dnsmasq`, `iptables`, and `ip addr`.

**Solution: Plugins spawn before privilege drop.**

Initialization sequence:

```
1. Start as root / with capabilities
2. nl80211 Controller: open Netlink socket, switch to monitor mode
3. PacketEngine: open raw sockets (AF_PACKET) — Sniffer and Injector
4. PcapWriter: open .pcapng file
5. Plugin Manager: spawn all active plugins (subprocess.Popen)
   → child processes inherit root from parent
   → captive_portal runs as root throughout its lifecycle
6. ──── privilege drop (main SORA process only) ────
7. Further SORA operation without root; plugins continue as root
```

**Alternative (if spawning before drop is impossible for architectural reasons):**
Install a `sudoers.d` fragment during SORA installation:
```
sora_user ALL=(root) NOPASSWD: /usr/sbin/hostapd, /usr/sbin/dnsmasq, /sbin/iptables, /sbin/ip
```
Then `captive_portal` calls `sudo -n hostapd ...` without a password. This path requires installer changes and is explicitly less preferred.

> **Note:** `hostapd` and `dnsmasq` remain processes with root privileges regardless of the approach. This is expected — they manage network interfaces. Cleanup at session end (see Section 2.6.3) is also performed as root via the plugin's child process.

**Rust drop realization:**

```rust
// core/src/priv_drop.rs
pub fn drop_privileges(target_uid: u32, target_gid: u32) -> Result<(), PrivDropError> {
    nix::unistd::setgroups(&[])?;
    nix::unistd::setgid(Gid::from_raw(target_gid))?;
    nix::unistd::setuid(Uid::from_raw(target_uid))?;
    assert_ne!(nix::unistd::getuid().as_raw(), 0, "privilege drop failed");
    Ok(())
}
```

`target_uid` / `target_gid` are taken from `SUDO_UID` / `SUDO_GID`. If running directly as root without sudo — a WARNING is logged, and we continue. Open fds (raw socket, netlink, pcap) **remain valid** after the drop.

#### Environment Check

| Dependency | Required | Phase | Behavior if Missing |
| :--- | :--- | :--- | :--- |
| `CAP_NET_RAW`, `CAP_NET_ADMIN` / root | ✅ | 1 | Hard stop with explanation |
| `hcxpcapngtool` | ❌ | 3 | Warning; cracking pipeline unavailable |
| `hashcat` | ❌ | 3 | Warning; cracking pipeline unavailable |
| GPU (OpenCL/CUDA) | ❌ | 3 | Hashcat works on CPU |
| `hostapd` | ❌ | 4 | Warning; Evil Twin and Karma unavailable |
| `dnsmasq` | ❌ | 4 | Warning; Captive Portal unavailable |
| Second Wi-Fi adapter | ❌ | 4 | Warning; all Phase 4 attacks unavailable |

#### TUI / CLI

- **TUI:** `textual` — AP map, event log, attack progress, `ipc_drop_count` meter, karma client list, captured credentials, active stealth profile.
- **CLI:** `typer` — full interface, profile execution.
- **Reporting:** JSON + HTML export.

---

### 2.6 Phase 4: Advanced Auditing Engines

:::danger
**STRICT COMPLIANCE STATEMENT (Phase 4):**
Phase 4 engines (Evil Twin, Karma/Mana, Beacon Flood, StealthEngine) are active interaction tools. Their use is strictly limited to testing *your own* intrusion prevention systems (WIDS/WIPS), stress-testing incident monitoring systems (SIEM), and legal auditing of corporate networks. Terminating communications services or intercepting third-party credentials violates terms of use (STC). SORA is provided "as is" in a security assessment configuration.
:::

> All engines in this section require the **AdapterRegistry** (two adapters: Sniffer + Injector). If only one adapter is present — commands return `PyErr("phase4_requires_dual_adapter")`.

---

#### 2.6.1 Evil Twin

Creating a functional copy of a target AP: same SSID, same IE, same RSNE — but on a different channel.

**Separation of Responsibility between BeaconCloner, hostapd, and EvilTwinEngine:**

| Component | Responsibility |
| :--- | :--- |
| `BeaconCloner` (Rust) | Listens for target Beacons; parses all IEs; detects changes by hash; emits events to Python. |
| `config_manager.py` (Python) | Renders `hostapd.conf` from TOML + BeaconCloner data; restarts hostapd via SIGHUP. |
| `hostapd` (process) | Manages association, 4-way handshake, DHCP requests; **sends Beacons** with correct SSID and IE. |
| `EvilTwinEngine` | **Not used** when hostapd is active — hostapd sends Beacons itself. EvilTwinEngine is reserved for a future raw-only mode without hostapd. |

> **Why EvilTwinEngine is unneeded with active hostapd:** hostapd in AP mode independently sends Beacons via nl80211. If EvilTwinEngine were to concurrently inject Beacons via raw sockets on wlan1 — two Beacon sources with the same BSSID but different SeqNums would appear, causing client frame drops and unstable association. The 98 TU interval instead of 100 is implemented via `beacon_int=98` in the generated `hostapd.conf`.

```
Adapter[Sniffer]  wlan0mon  ──► Beacon capture ──► BeaconCloner (Rust)
                                                           │
                                                  beacon_ie_changed event
                                                           │
                                                           ▼
                                                   Python AttackController
                                                           │
                                              config_manager.reload(ie_data)
                                                           │
                                              render hostapd.conf + SIGHUP
                                                           │
Adapter[Injector] wlan1 ◄─── hostapd (AP mode) ───────────┘
                              manages association + sends Beacons
```

**Behavior before first Beacon (waiting state):**

`cmd_evil_twin_start(target_bssid, waiting_timeout_ms)` starts the `BeaconCloner` on the target BSSID. Until the first Beacon is received:
- `EvilTwinEngine` does not start.
- hostapd does not start.
- Python receives an `evil_twin_waiting` event with `{bssid, elapsed_ms}` every 1000 ms.
- TUI displays status `EvilTwin: waiting for beacon...`.
- If `waiting_timeout_ms` expires → `adapter_error`-level event, FSM transitions to `Error`.

After the first Beacon:
- `BeaconCloner` emits `evil_twin_ready` with the full set of parsed IEs.
- Python calls `config_manager.reload(ie_data)` → generates `hostapd.conf` → starts hostapd.
- TUI displays `EvilTwin: active`.

**Adaptation upon original change:**

If `BeaconCloner` detects an IE change (RSNE, HT Caps, etc.) — it emits `beacon_ie_changed`. Python calls `config_manager.reload()` and sends hostapd a `SIGHUP`. Restart < 200 ms, clients do not disconnect.

**Client Eviction:** `cmd_start_deauth(bssid=original, client=broadcast, count=0, interval_ms=100)` — continuously until explicitly stopped.

---

#### 2.6.2 Karma / Mana

Responding to client Probe Requests — SORA presents itself as any requested network. Key requirement: response before client timeout (30–100 ms). Therefore, logic is in Rust, sent via `TxQueue` with highest priority.

```
Sniffer (wlan0mon) ──► PacketEngine ──► KarmaEngine (RT thread)
                                              │ self-frame filter
                                              │ priority push → TxQueue
                                        TxDispatch ──► Injector (wlan1) ──► Probe Response
                                              │ upon client association
                                        hostapd (AP mode, wlan1)
```

```rust
pub enum KarmaMode {
    Karma,                // directed probe only (specific SSID)
    Mana,                 // + wildcard probe (empty SSID)
    ManaLoud,             // [EXPERIMENTAL] + broadcast probe response (see below)
}

pub struct KarmaConfig {
    pub mode:           KarmaMode,
    pub our_bssid:      MacAddr,
    pub tx_channel:     u8,
    pub rssi_spoof:     i8,
    pub ssid_blacklist: Vec<Ssid>,
    pub ssid_whitelist: Option<Vec<Ssid>>,
}
```

Logic for each incoming frame (in RT thread):

```rust
fn on_frame(&self, frame: &[u8]) {
    let Some(probe) = parse_probe_request(frame) else { return };

    // Self-frame filter: Sniffer hears everything in the air including
    // frames the Injector just sent. Without this filter,
    // KarmaEngine would respond to its own Probe Responses.
    if probe.source_mac == self.config.our_bssid { return }

    if self.config.ssid_blacklist.contains(&probe.ssid) { return }
    if let Some(wl) = &self.config.ssid_whitelist {
        if !wl.contains(&probe.ssid) { return }
    }
    if probe.ssid.is_empty() && self.config.mode == KarmaMode::Karma { return }

    let response = ProbeResponseBuilder::new()
        .destination(probe.source_mac)
        .bssid(self.config.our_bssid)
        .ssid(probe.ssid.clone())
        .channel(self.config.tx_channel)
        .capabilities(Capabilities::ESS | Capabilities::Privacy)
        .rssi_hint(self.config.rssi_spoof)
        .supported_rates(&[54, 48, 36, 24, 18, 12, 9, 6])
        .build();

    self.tx_queue.push_priority(response);
}
```

> **`ManaLoud` — experimental.** Sends a broadcast Probe Response (DA = FF:FF:FF:FF:FF:FF) without a preceding Probe Request from the client. Practical value is minimal: Android 6+, iOS 10+, Windows 10+ ignore broadcast Probe Responses per 802.11-2016 (§11.1.4.2). Retained for legacy devices. TUI displays `[exp]`.

Upon client association — Python creates/updates `hostapd.conf` (SIGHUP < 200 ms) with the required SSID.

---

#### 2.6.3 Captive Portal

After a client connects to the Evil Twin / Karma AP — the actor plugin brings up an HTTP(S) server and intercepts traffic.

```
Client ──► wlan1 (hostapd) ──► Linux bridge / NAT
                                      │
                    ┌─────────────────┼──────────────────┐
                    ▼                 ▼                   ▼
              dnsmasq            iptables           aiohttp server
          (DHCP + DNS spoof)  (redirect :80→:8080)  :8080 / :8443
```

**Two levels of DNS Spoofing:**
1. `dnsmasq`: `address=/#/10.0.0.1` — all A/AAAA resolve to our IP.
2. `iptables REDIRECT`: `UDP:53 → dnsmasq` — intercepts clients with hardcoded DNS (8.8.8.8, 1.1.1.1).

**iptables rules — installation at start:**

```bash
# Plugin saves exact rules added to remove them precisely
iptables -t nat -A PREROUTING -i wlan1 -p udp --dport 53 -j REDIRECT --to-port 53
iptables -t nat -A PREROUTING -i wlan1 -p tcp --dport 80  -j REDIRECT --to-port 8080
iptables -t nat -A PREROUTING -i wlan1 -p tcp --dport 443 -j REDIRECT --to-port 8443
```

**Cleanup at completion — targeted removal via `-D`:**

```python
async def on_session_end(self):
    # Remove only own rules via -D, do not touch entire PREROUTING.
    # -F PREROUTING would wipe rules of other tools (VPN, firewall).
    for rule in self._installed_rules:  # saved at start
        run(f"iptables -t nat -D {rule}")
    self._dnsmasq_proc.terminate()
    await self._http_runner.cleanup()
    run("ip addr flush dev", self.iface)
```

`self._installed_rules` — list of rule strings in iptables format (without `-A`), saved at start. Even if one removal fails — continue with the others.

**aiohttp server:** catch-all routing (`/{path:.*}`) — any HTTP request serves the portal page. HTTPS on 8443 with self-signed certificate. Upon submit — data is saved to SQLite (`credentials`, plaintext) and sent as a `credentials_captured` event to the Plugin Bus.

**OUI-based auto-template selection:** SORA determines the manufacturer of the target AP by the first 3 bytes of the BSSID. TP-Link → TP-Link page, ASUS → ASUS page.

```
portals/
├── generic_wifi/    — "Enter Wi-Fi password to continue"
├── router_login/    — router page imitation (TP-Link, ASUS, Mikrotik)
├── hotel_wifi/      — "Enter room number and last name"
└── isp_portal/      — "Authorize via ISP account"
```

---

#### 2.6.4 Beacon Flooding

Simultaneous generation of hundreds and thousands of fake APs. Goals: masking the real Evil Twin, DoS of adversary scanners, confusion attack on client network managers.

**Key Decision: `sendmmsg()` instead of `sendmsg()`** — one syscall sends a batch of N frames. Reduction of kernel overhead by 30–50x.

```
BeaconFloodEngine
    ├── BssidGenerator     — random MAC from OUI pool
    ├── SsidGenerator      — dictionary | template | clone | random
    ├── FramePool          — N pre-built frames, assembled at start
    └── BurstScheduler     — sendmmsg batches via TxQueue with adaptive backpressure
```

**FramePool:** generate N frames once at start. In loop: only update Timestamp (8 bytes at fixed offset) + increment SeqNum (2 bytes) + push `Batch` into `TxQueue.normal`. No allocations in the hot path.

**Adaptive backpressure:** if `TxQueue.normal` is full → `BeaconFloodEngine` receives `TrySendError::Full` → batch size is halved. Upon recovery — grows smoothly.

| Target | Batch size | Interval | Result |
| :--- | :--- | :--- | :--- |
| 100 APs, background noise | 10 | 10 ms | ~1,000 frames/sec |
| 500 APs, moderate flood | 32 | 5 ms | ~6,400 frames/sec |
| 2000 APs, maximum chaos | 64 | 1 ms | ~64,000 frames/sec |

At 64,000 frames/sec, CPU load: ~5–15% of one core.

```rust
pub enum SsidGenMode {
    Dictionary(Vec<String>),
    Template { prefix: String, suffix: SsidSuffix },
    Random { len_range: (u8, u8) },
    Clone { base_ssid: String, variants: u32 },
}
```

`Clone` is especially effective with Evil Twin: dozens of variations of the target SSID, the twin gets lost in the crowd.

---

#### 2.6.5 StealthEngine (WIDS Validation)

**Problem:** without limits, frame generators inject traffic with a mathematically ideal interval and from a static MAC. This is trivially detected by basic IDS systems, depriving the audit of value: SORA's goal is to test the ability of WIDS systems (Snort, Kismet, Cisco WIPS) to identify complex, low-structured patterns.

**StealthEngine** — filter in the `TxDispatch` thread: frames enter `TxQueue` → `StealthEngine` decides when and how to send them.

```rust
pub struct StealthConfig {
    pub profile:            StealthProfile,
    pub oui_pool:           Vec<[u8; 3]>,
    pub burst_cap_pps:      Option<u32>,
    pub interval_jitter:    f32,
    pub inter_frame_gap_us: RangeInclusive<u64>,
}

pub enum StealthProfile {
    Off,     // no changes
    Low,     // OUI spoofing only
    Medium,  // OUI spoofing + jitter 20% + burst cap 1000 pps
    High,    // OUI spoofing + jitter 40% + burst cap 200 pps + inter-frame gap 50–500 us
}
```

**OUI Spoofing:** at attack start, a random OUI is chosen from `oui_pool` and applied to the source MAC of all injected frames. Default pool — top-20 OUI of consumer routers. A completely random MAC (Locally Administered Address — odd first byte) is immediately flagged by WIDS.

**Interval Randomization:** base interval multiplied by `1.0 + jitter * random_f32(-1.0, 1.0)`. With `jitter = 0.2` and 98 TU — real interval varies 78–118 TU.

**TX Burst Cap:** token bucket. Relevant for BeaconFloodEngine: a burst of 64,000 pps cannot be explained by a single device — a normal AP does not exceed ~3,000–8,000 pps.

| Profile | Basic WIDS Reaction | Performance | Application Scenario |
| :--- | :--- | :--- | :--- |
| `off` | Trigger (immediate) | Maximum | WIDS sensor validation |
| `low` | Probable trigger | ~95% | Basic SIEM stress-test |
| `medium` | Reduced alerts | ~60–70% | Audit of environments with weak WIDS logic |
| `high` | High chance of false negative | ~15–25% | Stress-test of Advanced WIDS correlators |

> **Limitation:** `StealthEngine` masks TX patterns but does not hide the fact of injection itself. Physical radio signature (power, position) is beyond software capabilities.

---

#### 2.6.6 Concurrency Model Phase 4: Injector TxQueue

**Problem:** `KarmaEngine`, `BeaconFloodEngine` operate in separate RT threads and both inject via one Injector raw socket. Direct `send_raw` from multiple threads — data race.

**Solution: Single `TxQueue` + one `TxDispatch` thread.**

```rust
// core/src/engine/tx_dispatch.rs

pub enum TxFrame {
    Normal(Vec<u8>),
    Priority(Vec<u8>),       // Probe Response from KarmaEngine
    Batch(Vec<Vec<u8>>),     // batch from BeaconFloodEngine — sendmmsg
}

pub struct TxQueue {
    priority: crossbeam_channel::Sender<TxFrame>,  // cap=64
    normal:   crossbeam_channel::Sender<TxFrame>,  // cap=1024
}
```

**Priorities:**

| Source | Type | Priority | Rationale |
| :--- | :--- | :--- | :--- |
| `KarmaEngine` | Probe Response | `Priority` | Client timeout 30–100 ms |
| `Deauth` (Phase 3) | Deauth/Disassoc | `Priority` | Client eviction is latency sensitive |
| `BeaconFloodEngine` | Beacon Batch | `Normal` | High volume; can tolerate delay |

> **EvilTwinEngine excluded:** Beacon is injected by hostapd directly (see 2.6.1), so `EvilTwinEngine` does not write to `TxQueue`.

**`TxDispatch` thread — fair drain (`SCHED_FIFO`):**

```rust
const MAX_PRIORITY_PER_ITER: usize = 8;

loop {
    // 1. Drain priority, but no more than MAX_PRIORITY_PER_ITER frames.
    //    Without this limit, dense Probe Request traffic would completely
    //    displace normal frames and BeaconFloodEngine would stall.
    let mut drained = 0;
    while drained < MAX_PRIORITY_PER_ITER {
        match self.rx_priority.try_recv() {
            Ok(frame) => { self.stealth.maybe_delay(); self.send(frame); drained += 1; }
            Err(_)    => break,
        }
    }
    // 2. One frame/batch from normal
    if let Ok(frame) = self.rx_normal.try_recv() {
        self.stealth.maybe_delay();
        self.send(frame);
    }
    // 3. Yield if both queues are empty
    std::thread::sleep(Duration::from_micros(100));
}
```

**Why not `SO_REUSEPORT`:** for `AF_PACKET` sockets, it does not provide independent TX queues — frames still egress through a single driver TX ring buffer. A single `TxQueue` is simpler and gives `StealthEngine` visibility into the entire stream.

**Backpressure:**
- `BeaconFloodEngine`: `TrySendError::Full` on `normal` → reduces batch size.
- `KarmaEngine`: blocks for no more than 2 ms on `priority` (cap 64 is almost never filled).

---

#### 2.6.7 WPA3 SAE Hunting

Capturing the SAE (Dragonfly handshake) for offline dictionary attacks via `hashcat -m 22301`.

**Why SAE is more complex than EAPOL:**

| Aspect | WPA2 EAPOL | WPA3 SAE |
| :--- | :--- | :--- |
| Frames | 4 × EAPOL Data | 2 × Authentication (subtype SAE) |
| Identification | EtherType 0x888E | Auth Algorithm Number = 3 |
| Order | Strictly 1→2→3→4 | Commit may repeat (ACT) |
| Commit Repetition | Prohibited | Normal under AP load |
| Transition mode | No | AP accepts WPA2 and WPA3 simultaneously |

**Direction Detection (AP→Client vs Client→AP):**

Direction is determined by the Transmitter Address (TA) field in the 802.11 MAC header. `PacketEngine` passes the `direction` to `SAEFilter` as follows:

```rust
// Direction is determined before calling SAEFilter.
// TA is the address of the device that physically transmitted the frame.
// known_bssid is the BSSID of the target monitored by SAEFilter.

fn classify_direction(ta: MacAddr, known_bssid: MacAddr) -> Direction {
    if ta == known_bssid {
        Direction::ApToClient   // frame transmitted by AP
    } else {
        Direction::ClientToAp   // frame transmitted by client
    }
}
```

This works reliably for SAE: Authentication frames in Infrastructure mode always go between the AP (known BSSID) and the client. IBSS/Mesh cases are not considered here.

**SAEFilter** — state machine in PacketEngine:

```rust
pub struct SAECapture {
    pub bssid:          MacAddr,
    pub client:         MacAddr,
    pub commit_ap:      Option<SaeCommitFrame>,
    pub commit_client:  Option<SaeCommitFrame>,
    pub confirm_ap:     Option<SaeConfirmFrame>,
    pub confirm_client: Option<SaeConfirmFrame>,
    pub token:          Option<Vec<u8>>,
    pub captured_at:    Instant,
    pub complete:       bool,
}
```

**Anti-Clogging Token handling:** at Status Code 76 — the AP is overloaded; the client must repeat the Commit with a token. SAEFilter saves the token and waits for the repeated Commit.

```rust
fn on_auth_frame(&mut self, frame: &[u8], direction: Direction) {
    let Some(sae) = parse_sae_auth(frame) else { return };
    let capture = self.in_progress.entry((bssid, client_mac)).or_default();

    match sae {
        SaeAuthFrame::Commit(c) if c.status == 76 => {
            capture.token = Some(c.anti_clogging_token.clone());
        }
        SaeAuthFrame::Commit(c) => {
            match direction {
                Direction::ApToClient => capture.commit_ap     = Some(c),
                Direction::ClientToAp => capture.commit_client = Some(c),
            }
        }
        SaeAuthFrame::Confirm(c) => {
            match direction {
                Direction::ApToClient => capture.confirm_ap    = Some(c),
                Direction::ClientToAp => capture.confirm_client = Some(c),
            }
            self.check_complete((bssid, client_mac));
        }
    }
}
```

Completeness = all 4 frames → `sae_complete` sent to the `high_priority` channel. Incomplete exchanges are GC'd after **30 seconds**.

**WPA3-Transition Mode:** EAPOL detector and SAEFilter operate in parallel. Transition mode is detected by RSN IE: `AKM Suite 2` (PSK) + `AKM Suite 8` (SAE) → we catch both types.

```bash
hcxpcapngtool session_42.pcapng -o session_42.hc22000  # WPA2
hcxpcapngtool session_42.pcapng -o session_42.hc22301  # WPA3-SAE
hashcat -m 22301 session_42.hc22301 /usr/share/wordlists/rockyou.txt
```

---

## 3. Logging

**Rust:** [`tracing`](https://docs.rs/tracing) + JSON. **Python:** [`structlog`](https://www.structlog.org) + JSON. Two streams: file (rotated) + stderr (`WARN+` only).

```toml
[logging]
level = "info"
dir = "~/.local/share/sora/logs"
max_size_mb = 10
keep_files = 5
```

Rotation by size. Logs are stored alongside the `.pcapng` and reference the `session_id`.

| Category | Level | Examples |
| :--- | :--- | :--- |
| FSM Transitions | INFO | `Idle→Scanning`, `Attacking→Error` |
| IPC Drops | WARN | `ipc_drop_count=12`, `command_queue_full` |
| Adapter Events | WARN/ERROR | `adapter_error: ENODEV`, `retry 2/3` |
| Evil Twin State | INFO | `evil_twin_waiting elapsed_ms=1200`, `evil_twin_ready ssid=HomeWiFi` |
| Handshake Capture | INFO | `eapol_complete bssid=AA:... client=BB:...` |
| SAE Capture | INFO | `sae_complete bssid=AA:... had_act=true` |
| Karma Responses | INFO | `karma_response ssid="Home_WiFi" client=AA:... mode=Mana` |
| Credentials | INFO | `credentials_captured portal=router_login client=10.0.0.2` |
| Plugin Events | INFO/WARN | `plugin_started`, `plugin_timeout` |
| Error Cleanup | INFO | Every step with result |
| Privilege Drop | INFO | `privileges dropped uid=1000` |
| Stealth | DEBUG | `stealth_delay_us=312 profile=medium` |
| TxQueue | WARN | `tx_priority_drained_max iter=N`, `beacon_tx_queue_full` |
| iptables | INFO | `iptables_rule_added rule=...`, `iptables_rule_removed rule=...` |

---

## 4. Kernel & Distro Compatibility

**Recommended Minimum: Kernel 5.4 LTS.**

| Functionality | Minimum Kernel Version |
| :--- | :--- |
| Monitor mode via nl80211 | 2.6.27 |
| `NL80211_CMD_SET_CHANNEL` | 3.2 |
| Frame injection via `NL80211_CMD_FRAME` | 3.6 |
| `sendmmsg(2)` | 3.0 |
| `PACKET_TX_RING` | 3.14 |

| Distribution | Version | Kernel | Status |
| :--- | :--- | :--- | :--- |
| Kali Linux | 2023.x+ | 6.x | ✅ Primary platform |
| Parrot OS | 5.x+ | 6.x | ✅ Supported |
| Ubuntu | 22.04 LTS | 5.15 | ✅ Supported |
| Ubuntu | 20.04 LTS | 5.4 | ⚠️ Minimum, not regularly tested |
| Arch Linux | rolling | 6.x | ✅ Supported |
| macOS / Windows | — | — | ❌ nl80211 Linux only |

