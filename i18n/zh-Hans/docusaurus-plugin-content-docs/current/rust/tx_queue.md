# 调度与 StealthEngine (TxQueue)

`tx_dispatch` 模块负责将生成的 802.11 帧发送到网络中。其交付架构旨在防止队头阻塞 (Head-of-Line Blocking)，并尽量减少被 WIDS/WIPS（无线入侵检测系统）发现的可能性。

## 1. 帧类型 (TxFrame)

所有传出的数据包都通过 `enum TxFrame` 进行分类，这允许核心以不同的优先级路由它们：

```rust
// core/src/engine/tx_dispatch.rs
pub enum TxFrame {
    Normal(Vec<u8>),       // 背景流量 (Beacon Flood)
    Priority(Vec<u8>),     // 关键流量 (定向 Deauth，响应)
    Batch(Vec<Vec<u8>>),   // 摊余发送 (recvmmsg/sendmmsg batch)
}
```

- 对于 Evil Twin 类型的攻击，将队列分为 **Normal** 和 **Priority** 至关重要。对客户端请求的响应 (Probe Response) 必须在 `Priority` 队列中发送，以超过合法的访问点。

## 2. 公平消耗算法 (Fair Drain Algorithm)

`TxQueue` 实现了一种改进的加权公平队列 (Weighted Fair Queuing，带权重的轮询)，而不是简单的 FIFO 队列。如果资源密集型攻击（如 Deauth 广播）处于活动状态，`TxQueue` 保证空中接口时间的 20%（默认）始终留给优先级队列中的响应 (Probe Responses)。

该逻辑在专用的发送子线程中运行，该线程从 MPSC 通道读取数据：
```rust
// 桩代码（正在 Phase 4 实施中）
pub struct TxQueue;
```
在 Phase 4 中，该模块将使用 `crossbeam::channel::select!` 来平衡 Priority/Normal 通道之间的负载。

## 3. StealthEngine (伪装)

`StealthEngine` 是 `TxQueue` 与 `af_packet` 发送 (套接字 `send()`) 之间的中间件层。它执行数据包的 *即时 (on-the-fly)* 修改。

:::danger
**严格合规性声明**：使用 `StealthEngine` 功能专门用于对自己拥有的事件管理系统 (SIEM) 进行压力测试，以验证其运行正确性（错误警报和漏报的情况）。
:::

流量调制功能：
1. **OUI Spoofing (MAC 伪装)**：循环旋转发射器 MAC 地址 (TA)。更改仅影响最后 3 个八位字节 (NIC 部分)，保留有效的制造商 OUI（例如 Apple 或 Samsung）以绕过过滤器。
2. **Jitter Injection (抖动注入)**：严格周期性的帧（如每 100 毫秒精确发送 Deauth）会被 WIDS 系统立即标记为攻击。`StealthEngine` 在睡眠间隔 (`thread::sleep`) 中添加数学抖动（例如 $\pm 15$ 毫秒）。
3. **Burst Capping (爆发突发限制)**：限制每秒的最大帧数（令牌桶机制），以防止物理拒绝服务攻击 (DoS)，将负载维持在审计范围内，而不是完全的 DoS 攻击。
