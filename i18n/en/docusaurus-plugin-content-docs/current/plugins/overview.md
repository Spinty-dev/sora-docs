# Plugin Architecture and Lifecycle

SORA's plugin system is designed with a focus on maximum isolation, core stability, and language independence. Unlike monolithic architectures where plugins run in the same address space as the main application, SORA uses a **process-based isolation model**.

## Isolation Principles

1. **No GIL (for Python)**: Python-based plugins run in their own interpreters, allowing them to perform heavy computations or blocking I/O operations without slowing down SORA's main `asyncio` loop.
2. **Crash Resilience**: If a plugin crashes (e.g., a Segfault in C++ or an Unhandled Exception in Python), the main SORA core continues to operate, merely recording a `plugin_terminated` event.
3. **Language Agnostic**: Any executable file capable of reading from `stdin` and writing to `stdout` can serve as a SORA plugin.

## Lifecycle and Privilege Spawning

One of SORA's critical features is its privilege management mechanism. Since SORA drops its privileges to a regular user (`privilege drop`) after initializing raw sockets, plugins that require `root` (e.g., for configuring `iptables` or launching `dnsmasq`) must be started **BEFORE** this point.

### Launch Stages:
1. **Core Initialization (Root)**: Opening interfaces, creating RAW hooks.
2. **Plugin Manager Spawning (Root)**: The manager reads the `[plugins]` section in the TOML file and launches plugin processes via `subprocess.Popen`. Plugins inherit `root` privileges.
3. **Privilege Drop (SORA Core)**: SORA's main process transitions to a regular user mode.
4. **Active Phase**: Plugins exchange messages with SORA via an NDJSON bus.
5. **TearDown (Cleanup)**: When closing a session, SORA sends a `SIGTERM` signal to all child processes. Plugins are responsible for correctly terminating and cleaning up their temporary resources (e.g., firewall rules).

## Configuration in TOML

Plugins are activated in the main profile file:

```toml
[plugins]
# Enabling internal or external plugins
enabled = ["captive_portal", "telegram_notify", "auto_crack"]

[plugins.captive_portal]
interface = "wlan1"
template = "dark_material"
redirect_all = true

[plugins.telegram_notify]
token = "ENV:TELEGRAM_TOKEN"
chat_id = "123456789"
```

:::danger
**Strict Compliance Statement**: Plugins that perform active impacts (Captive Portal, Deauth actors) must be used exclusively within the framework of an authorized security audit. The SORA developer is not responsible for the code of third-party plugins and its impact on the target infrastructure.
:::
