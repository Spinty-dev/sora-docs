# 插件开发实战指南 (Practical Guide to Creating a Plugin)

为 SORA 创建扩展插件不需要深入了解 Rust 核心的内部机制。插件作为独立进程与系统交互，通过文本格式的消息进行通信。

## 目录结构

每个插件必须位于 `plugins/` 的子目录下，并遵循以下结构：

```text
plugins/my_custom_audit/
├── manifest.json      # 必选元数据
├── main.py            # 可执行文件（可以是 .sh, .go 或二进制文件）
└── requirements.txt   # 依赖项（如果是 Python 项目）
```

### Manifest.json

此文件告知 SORA 如何运行您的插件以及它所需的权限。

```json
{
  "name": "My Custom Audit",
  "version": "1.0.0",
  "author": "Security Team",
  "entrypoint": "python3 main.py",
  "requires_root": true,
  "description": "自动将握手包上传至外部服务器"
}
```

:::warning
如果 `requires_root` 设置为 `true`，SORA 将在卸载特权之前启动您的插件。请务必小心：插件代码中的任何漏洞都可能危及整个审计系统。
:::

## 示例 1：Python (观察者模式 Observer)

这是一个最简单的插件，它只监听并记录事件。

```python
import sys
import json

def log_to_sora(message):
    # 发送日志并显式刷新缓冲区
    print(json.dumps({"type": "plugin_log", "level": "INFO", "message": message}))
    sys.stdout.flush()

def main():
    log_to_sora("插件已启动，等待事件中...")
    
    for line in sys.stdin:
        try:
            event = json.loads(line)
            if event.get("event") == "eapol_captured":
                bssid = event["bssid"]
                log_to_sora(f"检测到 {bssid} 的握手包！")
        except Exception as e:
            continue

if __name__ == "__main__":
    main()
```

## 示例 2：Bash (执行者模式 Actor)

您甚至可以用 Bash 编写插件。以下示例展示了一个简单的脚本，它每 10 秒切换一次 SORA 的信道（模拟外部扫描器）。

```bash
#!/bin/bash

# SORA 核心控制循环
while true; do
  # 向标准输出 (stdout) 发送命令
  echo '{"command": "cmd_set_channel", "channel": 1}'
  sleep 10
  echo '{"command": "cmd_set_channel", "channel": 6}'
  sleep 10
  echo '{"command": "cmd_set_channel", "channel": 11}'
  sleep 10
done
```

## 授权建议

为了确保与 SORA 生态系统的最大兼容性，我们建议您使用 **MIT License** 对插件进行授权。这允许社区其他成员使用您的成果，而不会受到核心所使用的 GPLv3 许可证的“传染性”限制。

:::danger
在发布插件之前，请确保它不包含硬编码的 API 密钥或令牌。请使用 `ConfigManager` 提供的环境变量 (`ENV`) 机制。
:::
