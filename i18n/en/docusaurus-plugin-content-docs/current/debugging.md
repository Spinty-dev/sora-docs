# Debugging and Troubleshooting (Kernel Level)

The documentation for a professional audit tool would be incomplete without a section on deep diagnostics. Going beyond the Python interface and understanding system calls is a key skill for a SORA developer.

## 1. System Diagnostics (`strace`)

`strace` is the primary tool for understanding why SORA doesn't see packets or cannot initialize an interface.

### Network Call Diagnostics
To see exactly which packets and events are arriving at the `AF_PACKET` socket:
```bash
# -e network: filter only network calls
# -s 64: show the first 64 bytes of data (usually enough for an 802.11 header)
sudo strace -p $(pgrep sora) -f -e network -s 64
```

### Typical Problem: Missing Packets
If the interface is in Monitor Mode but `strace` doesn't show `recvfrom` calls or they return `0`:
- **Diagnosis**: Briefly run `tcpdump -i wlan0mon -n`. If `tcpdump` sees packets but SORA doesn't, the problem lies in the `sockaddr_ll` binding (see `af_packet.rs`).
- **nl80211 Conflict**: If `strace` shows `EBUSY` on `sendto` calls to a Netlink socket, check for an active `wpa_supplicant` process.

:::tip
**Chairman's Tip**: Use `strace -e ioctl` if the interface doesn't go UP. Look for the `EPERM` error—it's a sure sign that `capabilities` haven't been passed to the Python process.
:::

## 2. Debugging the Rust Core via GDB

Since the SORA Rust core is loaded as a dynamic library (via PyO3) into the Python process, debugging requires a special approach.

### Attaching to a Process
1. Start SORA normally.
2. In another terminal, find the PID: `ps aux | grep sora`.
3. Start GDB:
```bash
sudo gdb -p <PID>
(gdb) directory core/src
(gdb) break packet_engine.rs:122
(gdb) continue
```

Upon packet capture, GDB will halt execution. You can inspect the `ParsedFrame` state directly in memory.

## 3. Hardware & Driver Quirks

Different chipsets behave differently when working with `nl80211`.

### Verifying Monitor Mode
If switching to Monitor Mode via Netlink succeeds but no packets are received, check the hardware interface type:
```bash
iw dev wlan0mon info
```
If the type is `managed`, the driver ignored the `SET_INTERFACE` command.
- **Solution**: SORA automatically tries an `IOCTL fallback`. If that also fails, manual mode setting via `airmon-ng start` is required.

### Channel Conflicts (Channel Lock)
If SORA is locked to one channel but the physical interface is hopping frequencies:
- Check `dmesg | grep nl80211`.
- Some Intel drivers (`iwlwifi`) do not allow a hard channel lock if `NetworkManager` is running. Use `airmon-ng check kill`.

:::info
**Strict Technical Detail**: Always check the kernel version with `uname -a`. SORA is optimized for kernels 5.15+, where many Netlink attribute bugs for 802.11ax (Wi-Fi 6) have been fixed.
:::

## 4. System Troubleshooting

If the problem lies at the layer boundary or in the native core, use the following methods.

### Native Logging (`RUST_LOG`)
The SORA core uses `tracing` for outputting debug information. You can control the detail level via an environment variable:
```bash
# Enable all kernel debug messages
RUST_LOG=debug sora scan -a wlan0
```
- **Error**: Critical failures (e.g., Open socket failed).
- **Warn**: Abnormal situations (e.g., Packet drop, Channel lock retry).
- **Info**: Standard events (e.g., Engine started).
- **Debug**: Parsing and IPC details (e.g., EAPOL step trace).

### IPC Stream Inspection (NDJSON)
If the TUI doesn't display data, verify that the core is generating events. SORA allows redirecting the plugin event stream to `stdout`:
```bash
# Direct NDJSON inspection via jq filter
sora scan -a wlan0 --json | jq '.'
```
This allows you to see the raw JSON objects before they reach the Python handler.

### Hung Processes and Cleanup
In rare cases (e.g., after `SIGKILL`), `hostapd` may remain in memory.
```bash
# Find and clean up residual processes
ps aux | grep sora
sudo killall hostapd
```
- **Sora PID**: The main process.
- **hostapd PID**: A child process managed by `ConfigManager`.

:::tip
**Advanced Note**: If you see a `Device or resource busy` error, check `rfkill list` and ensure that `NetworkManager` or `wpa_supplicant` is not trying to hold the interface in exclusive mode.
:::
