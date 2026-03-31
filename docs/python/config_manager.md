# ConfigManager: Advanced Template Rendering & Risk Matrix

`ConfigManager` в SORA является критическим звеном, трансформирующим абстрактные цели аудита в конкретные конфигурации системных демонов. Этот раздел описывает внутреннюю логику рендеринга и анализ рисков параметров `hostapd`.

## 1. Risk Matrix: Анализ параметров `hostapd.conf`

Каждый параметр в конфигурации `hostapd` напрямую влияет на успех и легальность аудита. Ниже приведена матрица рисков для ключевых опций.

| Параметр | Описание | ИБ-Риск / Влияние |
| :--- | :--- | :--- |
| `ignore_broadcast_ssid` | Скрытие SSID в Beacon-фреймах | **Critical (Karma)**: Установка в `1` отключает ответ на Probe Requests с пустым SSID, что делает атаку Mana/Karma неэффективной против большинства современных клиентов. |
| `wpa_key_mgmt` | Протоколы управления ключами | **High**: Использование `WPA-PSK` (WPA2) необходимо для классического аудита. Переход на `WPA-EAP` требует интеграции с внешним RADIUS (Phase 4). |
| `ieee80211w` | Protected Management Frames (PMF) | **Security Flex**: Если `1` (optional) или `2` (required), Deauth-атаки на этот интерфейс будут игнорироваться клиентами. SORA отключает PMF по умолчанию для тестирования устойчивости. |
| `noscan` | Пропуск сканирования соседних сетей | **Stability**: Позволяет форсировать использование 40MHz каналов (HT40) даже при наличии помех, что может нарушать регуляции FCC/ETSI. |

## 2. Template Rendering Pipeline

SORA использует конвейерную обработку для генерации конфигов, минимизируя задержку (latency) между обнаружением цели и развертыванием "двойника".

### Визуализация: Config Rendering Pipeline
```mermaid
graph TD
    Kernel[Kernel/nl80211] -->|Raw IE| Rust[Rust BSSID Struct]
    Rust -->|PyO3 Bridge| PyObj[Python Dict]
    PyObj -->|Validation| CM[ConfigManager]
    CM -->|Jinja2/Format| Render[Renderer]
    Render -->|Atomic Write| FS[/tmp/sora/hostapd.conf]
    FS -->|SIGHUP| Hostapd[hostapd Process]
```

### Построчный разбор логики (manager.py:L163)
Метод `render_hostapd_conf` выполняет финальную сборку:
1. **Source of Truth**: Значения `channel` и `beacon_int` принудительно берутся из `attack.evil_twin` (L176-177), игнорируя любые вхождения в секции `hostapd`. Это предотвращает "split-brain" конфигурацию.
2. **Type Mapping**: Булевы значения Python (`True/False`) транслируются в бинарные флаги `1/0` для совместимости с синтаксисом `hostapd`.
3. **Atomic Replacement**: Конфигурация записывается во временный файл, после чего процессу отправляется сигнал `SIGHUP`.

## 3. Динамическая адаптация IE (Information Elements)

В Phase 3 `ConfigManager` будет расширен для поддержки **IE Shadowing**. 
- **Задача**: Скопировать специфичные для вендора теги (Vendor Specific OUI) из оригинального Beacon-пакета.
- **Реализация**: `ConfigManager` будет принимать `data_hex` из события `beacon_ie_changed` и инжектировать их в параметр `vendor_elements` в `hostapd.conf`. 

:::info
**Strict Technical Note**: Прямая инъекция байтов из сырого трафика в конфиг требует предварительной валидации длины тега (Length Field), чтобы предотвратить выход за границы буфера парсера в самом `hostapd`.
:::
