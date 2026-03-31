# End-to-End Profiling Methodology

To ensure 10Gbps-level performance and handle high-load Wi-Fi networks, deep analysis of delays at every processing stage is required.

## 1. Rust Core Profiling (CPU & Memory)

To find bottlenecks in packet parsing (`parsers.rs`) and queue management (`packet_engine.rs`), the `flamegraph` tool is used.

### Using `cargo flamegraph`
This allows visualizing the call tree and the time spent on each function.
```bash
# Build with debug symbols but optimizations enabled
cargo flamegraph --bin sora-core-tests -- --bench
```
1. **Bottleneck #1: Allocations**. Look for tall graphs in `Vec::with_capacity` or `String::from_utf8`. In Phase 2, we minimized these through Zero-copy.
2. **Bottleneck #2: Unmasking**. Radiotap headers require many bitwise operations, which can be accelerated via SIMD.

## 2. Python Layer Profiling (AsyncIO)

In the Python layer, it's not the CPU frequency that's critical, but the responsiveness of the Event Loop.

### Using `viztracer`
`viztracer` is ideal for SORA because it can simultaneously track AsyncIO coroutines and native Rust system threads.
```bash
viztracer --attach_installed_ret -m sora scan -a wlan0mon profile.toml
```

### Graph Analysis:
- **Event Gap**: If more than 100 ms passes between `poll_events` loop iterations in the TUI, it means the database (SQLite) or plugins are blocking the main thread.
- **GC Overhead**: Spikes in Python garbage collector activity when transferring large volumes of data from Rust.

## 3. Measuring IPC Overhead (Methodology)

To accurately measure marshalling delay via PyO3, we use an "End-to-End Timestamping" methodology.

### Latency Formula:
```text
Latency_IPC = T_Python_Recv - T_Rust_Send
```

### How to Measure:
1. **Rust**: Add a `timestamp_ns` field to `SoraEvent` immediately before `self.high_tx.send()`.
2. **Python**: Record `time.time_ns()` immediately after returning from `event_receiver.poll_high()`.
3. **Analysis**: If the latency exceeds 2ms, it's a critical signal of queue overload or inefficient MAC address string copying.

## 4. Performance Tuning Guide (Kernel Level)

For high-load operation (monitoring hundreds of networks in real-time), standard Linux kernel buffers can become a bottleneck. It is recommended to apply the following `sysctl` settings.

### Network Stack Optimization
Add to `/etc/sysctl.conf`:
```bash
# Increase the maximum receive buffer size for RAW sockets
net.core.rmem_max = 33554432
net.core.rmem_default = 33554432

# Increase the interface packet queue
net.core.netdev_max_backlog = 10000
```
- **rmem_max**: Allows the kernel to hold more packets in the `AF_PACKET` queue if the Rust core is briefly busy (e.g., writing a heavy block to PCAP).
- **netdev_max_backlog**: Prevents packet drops at the driver level during sudden traffic bursts.

## 5. Optimization Summary

| Component | Tool | Target (Baseline) |
| :--- | :--- | :--- |
| **Rust Kernel** | `cargo flamegraph` | < 10μs per frame (without PCAP) |
| **Python TUI** | `viztracer` | > 60 FPS for the GUI |
| **IPC Bridge** | `py-spy` | < 1ms Latency |
| **SQLite I/O** | `iostat` | < 100 IOPS |

:::tip
**Advanced Note**: For Phase 4 (Karma), IPC latency is critical. Any response to a Probe Request must be aired faster than the legitimate access point responds (usually < 100ms). Marshalling optimization and stack tuning are the only ways to win the "Radio Race."
:::
