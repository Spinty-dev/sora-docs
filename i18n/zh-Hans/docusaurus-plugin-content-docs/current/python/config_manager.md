# ConfigManager：高级模板渲染与风险矩阵

SORA 中的 `ConfigManager` 是一个关键环节，它将抽象的审计目标转化为系统守护进程的具体配置。本章节介绍了 `hostapd` 参数的内部渲染逻辑和风险分析。

## 1. 风险矩阵：`hostapd.conf` 参数分析

`hostapd` 配置中的每个参数都会直接影响审计的成功与合法性。下面是关键选项的风险矩阵。

| 参数 | 描述 | 安全风险 / 影响 |
| :--- | :--- | :--- |
| `ignore_broadcast_ssid` | 在 Beacon 帧中隐藏 SSID | **关键 (Karma)**：设置为 `1` 会处理对空 SSID 的 Probe Request 响应，使得 Mana/Karma 攻击对大多数现代客户端失效。 |
| `wpa_key_mgmt` | 密钥管理协议 | **高**：使用 `WPA-PSK` (WPA2) 对经典审计至关重要。过渡到 `WPA-EAP` 需要与外部 RADIUS 进行集成 (Phase 4)。 |
| `ieee80211w` | 受保护的管理帧 (PMF) | **安全灵活性**：如果设置为 `1` (可选) 或 `2` (强制)，客户端将忽略对该接口的 Deauth 攻击。SORA 默认禁用 PMF 以进行抗压测试。 |
| `noscan` | 跳过对相邻网络的扫描 | **稳定性**：即使存在干扰，也允许强制使用 40MHz 信道 (HT40)，这可能会违反 FCC/ETSI 的相关法规。 |

## 2. 模板渲染流水线 (Template Rendering Pipeline)

SORA 使用处理流水线来生成配置，从而最大限度地减少目标检测与“克隆”部署之间的延迟。

### 可视化：配置渲染流水线 (Config Rendering Pipeline)
```mermaid
graph TD
    Kernel[内核/nl80211] -->|原始 IE| Rust[Rust BSSID 结构]
    Rust -->|PyO3 Bridge| PyObj[Python 字典]
    PyObj -->|验证| CM[ConfigManager]
    CM -->|Jinja2/格式化| Render[渲染器]
    Render -->|原子化写入| FS[/tmp/sora/hostapd.conf]
    FS -->|SIGHUP| Hostapd[hostapd 进程]
```

### 逐行逻辑分解 (manager.py:L163)
`render_hostapd_conf` 方法执行最终的组装工作：
1. **单一事实来源 (Source of Truth)**：`channel` 和 `beacon_int` 的值强制从 `attack.evil_twin` (L176-177) 获取，忽略 `hostapd` 部分中的任何设置。这防止了配置上的“分裂脑” (split-brain) 状态。
2. **类型映射**：Python 的布尔值 (`True/False`) 被翻译成二进制标志 `1/0`，以兼容 `hostapd` 的语法。
3. **原子化替换**：配置被写入临时文件，随后向进程发送 `SIGHUP` 信号。

## 3. IE (信息元素) 的动态适配

在 Phase 3 中，`ConfigManager` 将扩展支持 **IE Shadowing (IE 影子化)**。
- **任务目标**：从原始 Beacon 包中复制厂商特定标签 (Vendor Specific OUI)。
- **实现方式**：`ConfigManager` 将接收来自 `beacon_ie_changed` 事件的 `data_hex`，并将其注入到 `hostapd.conf` 的 `vendor_elements` 参数中。

:::info
**严格的技术说明**：直接将原始流量中的字节注入到配置中，需要对长度字段 (Length Field) 进行预验证，以防止在 `hostapd` 本身的解析器中发生缓冲区溢出。
:::
