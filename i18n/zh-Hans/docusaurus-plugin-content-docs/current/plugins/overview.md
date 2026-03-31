# 插件架构与生命周期 (Plugin Architecture & Lifecycle)

SORA 的插件系统旨在侧重极致的隔离性、核心稳定性以及语言无关性。与插件运行在主应用程序同一地址空间的单体架构不同，SORA 采用了**基于进程的隔离模型 (Process-based Isolation)**。

## 隔离原则

1. **无 GIL 限制 (针对 Python)**：基于 Python 的插件在各自独立的解释器中运行，允许执行高负载计算或阻塞式 I/O 操作，而不会导致 SORA 主 `asyncio` 循环变慢。
2. **崩溃韧性 (Crash Resilience)**：如果插件发生崩溃（例如 C++ 中的段错误 Segfault 或 Python 中的未处理异常），SORA 的主核心将继续运行，仅记录 `plugin_terminated`（插件终止）事件。
3. **语言无关性**：任何能够从 `stdin` 读取并向 `stdout` 写入的执行文件都可以作为 SORA 的插件。

## 生命周期与特权启动 (Privilege Spawn)

SORA 的关键特性之一是权能管理机制。由于 SORA 在初始化原始套接字后会将权限降低至普通用户 (`privilege drop`)，因此需要 `root` 权限（例如配置 `iptables` 或启动 `dnsmasq`）的插件必须在此之前的关键时间点启动。

### 启动阶段：
1. **核心初始化 (Root 权限)**：打开接口，创建原始 (RAW) 钩子。
2. **插件管理器启动 (Root 权限)**：管理器读取 TOML 文件中的 `[plugins]` 部分，并通过 `subprocess.Popen` 启动插件进程。插件继承 `root` 权限。
3. **权限卸载 (SORA Core)**：SORA 的主进程切换至普通用户模式运行。
4. **活跃运行阶段**：插件通过 NDJSON 总线与 SORA 进行消息交换。
5. **拆除与清理 (TearDown)**：关闭会话时，SORA 会向所有子进程发送 `SIGTERM` 信号。插件负责正确终止并清理其临时资源（例如防火墙规则）。

## TOML 配置

插件在主配置文件中激活：

```toml
[plugins]
# 启用内置或外部插件
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
**严格合规性声明**：具有主动影响功能的插件（Captive Portal, Deauth 参与者）必须仅在授权的安全审计框架内使用。SORA 的开发人员不对第三方插件的代码及其对目标基础设施的影响承担任何责任。
:::
