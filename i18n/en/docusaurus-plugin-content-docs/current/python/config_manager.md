# ConfigManager: Advanced Template Rendering & Risk Matrix

`ConfigManager` in SORA is a critical link that transforms abstract audit goals into concrete system daemon configurations. This section describes the internal rendering logic and the risk analysis of `hostapd` parameters.

## 1. Risk Matrix: Analysis of `hostapd.conf` Parameters

Every parameter in the `hostapd` configuration directly impacts the success and legality of the audit. Below is the risk matrix for key options.

| Parameter | Description | Security Risk / Impact |
| :--- | :--- | :--- |
| `ignore_broadcast_ssid` | Hiding SSID in Beacon frames | **Critical (Karma)**: Setting this to `1` disables responses to Probe Requests with an empty SSID, making Mana/Karma attacks ineffective against most modern clients. |
| `wpa_key_mgmt` | Key management protocols | **High**: Using `WPA-PSK` (WPA2) is necessary for classic auditing. Transitioning to `WPA-EAP` requires integration with an external RADIUS (Phase 4). |
| `ieee80211w` | Protected Management Frames (PMF) | **Security Flex**: If set to `1` (optional) or `2` (required), Deauth attacks on this interface will be ignored by clients. SORA disables PMF by default for resilience testing. |
| `noscan` | Skip scanning neighboring networks | **Stability**: Allows forcing the use of 40MHz channels (HT40) even in the presence of interference, which may violate FCC/ETSI regulations. |

## 2. Template Rendering Pipeline

SORA uses pipeline processing to generate configs, minimizing the latency between target discovery and "evil twin" deployment.

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
1. **Source of Truth**: The `channel` and `beacon_int` values are forcibly taken from `attack.evil_twin` (L176-177), ignoring any occurrences in the `hostapd` section. This prevents a "split-brain" configuration.
2. **Type Mapping**: Python boolean values (`True/False`) are translated into binary flags (`1/0`) for compatibility with `hostapd` syntax.
3. **Atomic Replacement**: The configuration is written to a temporary file, after which a `SIGHUP` signal is sent to the process.

## 3. Dynamic IE (Information Elements) Adaptation

In Phase 3, `ConfigManager` will be expanded to support **IE Shadowing**.
- **Task**: Copy vendor-specific tags (Vendor Specific OUI) from the original Beacon packet.
- **Implementation**: `ConfigManager` will receive `data_hex` from the `beacon_ie_changed` event and inject them into the `vendor_elements` parameter in `hostapd.conf`.

:::info
**Strict Technical Note**: Direct injection of bytes from raw traffic into the config requires preliminary validation of the tag length (Length Field) to prevent buffer overflow in `hostapd` itself.
:::
