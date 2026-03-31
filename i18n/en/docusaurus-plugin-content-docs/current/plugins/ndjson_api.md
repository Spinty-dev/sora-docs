# NDJSON API Specification (Plugin Subprocess IPC)

In SORA, the plugin architecture is implemented via **Subprocess IPC**, where data exchange occurs over the NDJSON protocol. This ensures total isolation and the ability to use any programming language without being tied to Rust's ABI or Python's GIL.

## 1. Event Schema (SORA ➔ Plugin)

All events are passed to the plugin's `stdin`. An event is a single JSON string ending with `\n`.

### `eapol_captured` Schema
Used when capturing a 4-way handshake (M1-M4).
```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "properties": {
    "event":       {"const": "eapol_captured"},
    "bssid":       {"type": "string", "pattern": "^([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})$"},
    "client":      {"type": "string", "pattern": "^([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})$"},
    "step":        {"type": "integer", "minimum": 1, "maximum": 4},
    "pcap_offset": {"type": "integer", "description": "Byte offset in the pcapng file"},
    "data_hex":    {"type": "string", "description": "Raw EAPOL bytes in HEX format"}
  },
  "required": ["event", "bssid", "client", "step", "data_hex"]
}
```

### `beacon_ie_changed` Schema
Notification of changes to target parameters (e.g., channel switch or RSN change).
```json
{
  "event": "beacon_ie_changed",
  "bssid": "...",
  "changed_fields": ["ssid", "channel", "rsn"]
}
```

## 2. Command Schema (Plugin ➔ SORA)

Commands are sent to the plugin's `stdout`. SORA reads them asynchronously.

### `cmd_start_deauth` Schema
```json
{
  "command":     "cmd_start_deauth",
  "bssid":       "AA:BB:CC...",
  "client":      "...",
  "count":       10,
  "interval_ms": 100
}
```

## 3. Binary I/O Handling (Internals)

To ensure the reliability of the Linux kernel-level IPC, SORA and plugins follow strict rules for working with streams:

- **Line Buffering**: SORA reads the plugin's `stdout` line by line. The plugin **must** call `flush()` after every write (e.g., `sys.stdout.flush()` in Python); otherwise, the command will remain "stuck" in the buffer until it overflows.
- **BrokenPipe Handling**: If a plugin terminates unexpectedly, the pipe (`stdin`) is closed. SORA detects `BrokenPipe` or `EPIPE` at the Rust/Python level and triggers a `session_error` event followed by a cleanup.
- **Non-blocking read**: The orchestrator reads plugin `stdout` in non-blocking mode via `asyncio.subprocess`, preventing the main loop from hanging if a plugin is "slow."

:::warning
**Strict Technical Detail (Security)**: SORA limits the input buffer for a single plugin message (typically 64 KB). Any attempt to send a larger JSON will result in the forced closure of the pipe to protect the orchestrator's memory from DoS attacks.
:::

## 4. Status Specification

Plugins can report their state:
- **`plugin_init`**: Initialization stage.
- **`plugin_ready`**: Ready to receive events.
- **`plugin_busy`**: Performing a heavy operation (e.g., GPU cracking).

```json
{"type": "plugin_status", "status": "plugin_ready", "uptime_ms": 42000}
```
