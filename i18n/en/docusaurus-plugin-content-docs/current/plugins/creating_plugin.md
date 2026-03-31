# Practical Guide to Creating a Plugin

Creating an extension for SORA does not require deep knowledge of the Rust core's inner workings. A plugin interacts with the system as an isolated process, exchanging messages in text format.

## Directory Structure

Each plugin must be located in a `plugins/` subdirectory and have the following structure:

```text
plugins/my_custom_audit/
├── manifest.json      # Mandatory metadata
├── main.py            # Executable file (can be .sh, .go, binary)
└── requirements.txt   # Dependencies (if Python)
```

### Manifest.json

This file tells SORA how to run your plugin and what permissions it requires.

```json
{
  "name": "My Custom Audit",
  "version": "1.0.0",
  "author": "Security Team",
  "entrypoint": "python3 main.py",
  "requires_root": true,
  "description": "Automatic upload of handshakes to an external server"
}
```

:::warning
If `requires_root` is set to `true`, SORA will launch your plugin before dropping privileges. Be cautious: any vulnerability in the plugin code could compromise the entire audit system.
:::

## Example 1: Python (Observer)

The simplest plugin that only listens for events and logs them.

```python
import sys
import json

def log_to_sora(message):
    print(json.dumps({"type": "plugin_log", "level": "INFO", "message": message}))
    sys.stdout.flush()

def main():
    log_to_sora("Plugin started and waiting for events...")
    
    for line in sys.stdin:
        try:
            event = json.loads(line)
            if event.get("event") == "eapol_captured":
                bssid = event["bssid"]
                log_to_sora(f"DETECTED Handshake for {bssid}!")
        except Exception as e:
            continue

if __name__ == "__main__":
    main()
```

## Example 2: Bash (Actor)

Plugins can even be written in Bash. An example of a simple script that switches the SORA channel every 10 seconds (simulating an external scanner).

```bash
#!/bin/bash

# SORA Core Control Loop
while true; do
  # Send command to stdout
  echo '{"command": "cmd_set_channel", "channel": 1}'
  sleep 10
  echo '{"command": "cmd_set_channel", "channel": 6}'
  sleep 10
  echo '{"command": "cmd_set_channel", "channel": 11}'
  sleep 10
done
```

## Licensing Recommendations

To ensure maximum compatibility with the SORA ecosystem, we recommend licensing plugins under the **MIT License**. This allows other community members to use your developments without imposing the "viral" restrictions of the GPLv3 license used by the core.

:::danger
Before publishing a plugin, ensure it does not contain hardcoded API keys or tokens. Use `ENV` variables available through the `ConfigManager`.
:::
