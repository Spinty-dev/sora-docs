# ConfigManager: Advanced Template Rendering & Risk Matrix

The `ConfigManager` in SORA is a critical link that transforms abstract audit goals into concrete configurations for system daemons. This section describes the internal rendering logic and risk analysis of `hostapd` parameters.

## 1. Risk Matrix: Analysis of `hostapd.conf` Parameters

Each parameter in the `hostapd` configuration directly affects the success and legality of the audit. Below is a risk matrix for key options.

| Parameter | Description | Security Risk / Impact |
| :--- | :--- | :--- |
| `ignore_broadcast_ssid` | Hiding the SSID in Beacon frames | **Critical (Karma)**: Setting this to `1` disables responses to Probe Requests with a null SSID, making Mana/Karma attacks ineffective against most modern clients. |
| `wpa_key_mgmt` | Key management protocols | **High**: The use of `WPA-PSK` (WPA2) is necessary for classic auditing. Transitioning to `WPA-EAP` requires integration with an external RADIUS (Phase 4). |
| `ieee80211w` | Protected Management Frames (PMF) | **Security Flex**: If set to `1` (optional) or `2` (required), Deauth attacks on this interface will be ignored by clients. SORA disables PMF by default for resilience testing. |
| `noscan` | Skipping scans for neighboring networks | **Stability**: Allows forcing the use of 40MHz channels (HT40) even in the presence of interference, which may violate FCC/ETSI regulations. |

## 2. Template Rendering Pipeline

SORA uses a processing pipeline to generate configs, minimizing the latency between target detection and "cloning" deployment.

### Visualization: Config Rendering Pipeline
```mermaid
graph TD
    Kernel[Kernel/nl80211] -->|Raw IE| Rust[Rust BSSID Struct]
    Rust -->|PyO3 Bridge| PyObj[Python Dict]
    PyObj -->|Validation| CM[ConfigManager]
    CM -->|Jinja2/Format| Render[Renderer]
    Render -->|Atomic Write| FS[/tmp/sora/hostapd.conf]
    FS -->|SIGHUP| Hostapd[hostapd Process]
```

### Line-by-Line Logic Breakdown (manager.py:L163)
The `render_hostapd_conf` method performs the final assembly:
1. **Source of Truth**: The `channel` and `beacon_int` values are forcibly taken from `attack.evil_twin` (L176-177), ignoring any occurrences in the `hostapd` sections. This prevents "split-brain" configurations.
2. **Type Mapping**: Python boolean values (`True/False`) are translated into binary flags (`1/0`) for compatibility with `hostapd` syntax.
3. **Atomic Replacement**: The configuration is written to a temporary file, after which a `SIGHUP` signal is sent to the process.

## 3. Dynamic Adaptation of IEs (Information Elements)

In Phase 3, the `ConfigManager` will be extended to support **IE Shadowing**. 
- **Goal**: Copy vendor-specific tags (Vendor Specific OUI) from the original Beacon packet.
- **Implementation**: `ConfigManager` will receive `data_hex` from the `beacon_ie_changed` event and inject them into the `vendor_elements` parameter in `hostapd.conf`.

:::info
**Strict Technical Note**: Direct injection of bytes from raw traffic into the config requires preliminary validation of the length field (Length Field) to prevent buffer overflows in the `hostapd` parser itself.
:::
