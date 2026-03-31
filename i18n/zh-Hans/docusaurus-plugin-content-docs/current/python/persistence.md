# 数据持久化：SQLite 与 Pcapng 偏移量

本章节介绍了 SORA 的长期数据存储机制。系统结合了用于元数据的关系型数据库 (SQLite) 和用于无线电频率帧的结构化二进制日志 (Pcapng)。

## 1. SQLite 模式规范 (MetadataDB)

SORA 使用 SQLite 来确保在突然断电或硬件故障期间的数据完整性。

### `sessions` 表
审计会话的主表。
- `id`：主键。
- `pcapng_path`：转储文件的绝对路径。
- `profile_name`：启动时使用的 TOML 配置文件名称。

### `handshakes` 表
数据库与数据包转储之间的连接纽带。
- `bssid`：目标访问点 (AP) 的 MAC 地址。
- **`pcapng_offset`**：Pcapng 文件中 EPB (增强型数据包块，Enhanced Packet Block) 块起始位置的准确字节偏移量。允许在不扫描整个转储文件的情况下，近乎瞬时地提取特定握手。
- `captured_at`：捕获时的 ISO8601 时间戳。

### `sae_captures` 表 (Phase 4)
专门用于 WPA3-SAE (Dragonfly) 审计的表。包含用于通过 `hashcat` 进行离线攻击所需的提交 (Commit) 和确认 (Confirm) 信息的 BLOB 字段。

## 2. Pcapng 偏移量计算

为了与分析工具（如 Wireshark、`tcpdump`）进行高效集成，SORA 以 Pcapng 格式 (RFC 802.11) 记录数据。

### 块结构与偏移量
当 `PcapWriter` 初始化时（参见 `writer.rs:L155`），会写入两个必选标头：
1. **SHB (Section Header Block)**：固定大小为 **28 字节**。
2. **IDB (Interface Description Block)**：固定大小为 **20 字节**。
   - *基础偏移量*：任何 EPB 数据包的偏移量至少为 **48 字节**。

### 计算 EPB (Enhanced Packet Block) 偏移量
每个 EPB 块的大小按照以下公式计算：
```text
BlockLength = 32 + ((DataLength + 3) & ~3) + 4
```
其中：
- `32`：静态 EPB 标头（类型、长度、接口 ID、时间戳、捕获长度、原始长度）。
- `((DataLength + 3) & ~3)`：按 4 字节对齐（填充 Padding）后的帧数据长度。
- `4`：块末尾的重复长度字段（符合 Pcapng 规范）。

### 示例
如果捕获到一个长度为 121 字节的 EAPOL 帧：
1. 对齐：`(121 + 3) & ~3 = 124`。
2. 块长度：`32 + 124 + 4 = 160 字节`。
3. 下一个数据包的偏移量将增加 160。

## 3. 与 Wireshark 集成

通过在 SQLite 中存储 `pcapng_offset`，SORA 支持近乎瞬时地跳转到特定数据包：
```bash
# TUI 生成的用于打开特定握手的命令
wireshark -r session.pcapng -Y "frame.offset == <pcapng_offset>"
```

:::danger
**严格的技术说明**：直接记录偏移量要求 Pcapng 文件中不使用压缩。SORA 写入“原始” EPB 流以确保偏移量的可预测性，这虽然增加了磁盘空间占用，但保证了对审计证据的 O(1) 级访问速度。
:::
