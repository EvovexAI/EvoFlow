---
name: android-agent
description: Android 设备控制 Skill。当用户想控制自有 Android 设备（截屏、点击、输入、滑动、启动 App、列出设备、ADB/UI 自动化）时使用。通过 CLI 脚本控制设备；有 android-agent 后端时走 REST API，否则降级 ADB 直连。
---

# Android Agent Skill

让 AI Agent 通过 `terminal` 调用 `android_ctl.py`，控制 **用户明确授权的自有 Android 设备**。

**边界（必读）**

- 仅用于你拥有或已获书面授权的设备与模拟器；禁止用于未授权访问他人设备。
- 默认假设本机已安装 `adb` 且设备已通过用户同意完成调试授权。
- 截屏、点击、输入可能暴露隐私；请在可信环境使用，并避免把含密钥的截图写入公开仓库。

**双模式**：检测 android-agent 后端（`:5055`）可用则 REST，否则 ADB。输出 JSON 的 `_mode` 标明模式。

## 前提条件

- **基础模式**：Python 3.8+ + `adb` 在 PATH + 至少一台已授权设备
- **增强模式（可选）**：android-agent 后端 `http://127.0.0.1:5055`
- **MCP（可选）**：见 `mcp/mcp-config.example.json`

脚本：`scripts/android_ctl.py` · 环境检查：`python scripts/check_env.py`

## 命令速查

```
python scripts/android_ctl.py <command> [args...]
```

| 命令 | 基础模式 | 增强模式 | 示例 |
|------|:--------:|:--------:|------|
| `devices` | ✅ | ✅ | `devices` |
| `screenshot <device> [--save path]` | ✅ PNG | ✅ JPEG | `screenshot emulator-5554 --save screen.png` |
| `elements <device>` | ✅ 基础 | ✅ 完整 | `elements emulator-5554` |
| `tree <device>` | ✅ XML | ✅ LLM 树 | `tree emulator-5554` |
| `tap <device> <x> <y>` | ✅ | ✅ | `tap emulator-5554 540 1200` |
| `type <device> <text>` | ✅ | ✅ | `type emulator-5554 "Hello"` |
| `swipe <device> <x1> <y1> <x2> <y2>` | ✅ | ✅ | `swipe emulator-5554 540 1500 540 500` |
| `back <device>` | ✅ | ✅ | `back emulator-5554` |
| `home <device>` | ✅ | ✅ | `home emulator-5554` |
| `key <device> <keycode>` | ✅ | ✅ | `key emulator-5554 ENTER` |
| `launch <device> <package>` | ✅ | ✅ | `launch emulator-5554 com.android.settings` |
| `stop <device> <package>` | ✅ | ✅ | `stop emulator-5554 com.android.settings` |
| `packages <device>` | ✅ | ✅ | `packages emulator-5554` |
| `health <device>` | ✅ 基础 | ✅ 完整 | `health emulator-5554` |

> **基础模式 vs 增强模式差异**：`elements` 基础模式解析 text/content-desc/resource-id/class/clickable/bounds（已足够定位和操作 UI 元素），增强模式额外提供 OCR 和完整屏幕树。`screenshot` 基础模式输出 PNG，增强模式输出 JPEG。

## 典型操作流程

### 1. 发现设备

```bash
python scripts/android_ctl.py devices
```

### 2. 查看屏幕状态

```bash
python scripts/android_ctl.py elements emulator-5554
python scripts/android_ctl.py tree emulator-5554
python scripts/android_ctl.py screenshot emulator-5554 --save screen.png
```

### 3. 操作设备

```bash
python scripts/android_ctl.py tap emulator-5554 540 1200
python scripts/android_ctl.py type emulator-5554 "Hello World"
python scripts/android_ctl.py swipe emulator-5554 540 1500 540 500
python scripts/android_ctl.py back emulator-5554
python scripts/android_ctl.py launch emulator-5554 com.android.settings
```

### 4. 循环操作（UI 自动化范式）

1. `devices` → 拿到设备 serial  
2. `elements` → 看当前屏幕有什么  
3. `tap` / `type` / `swipe` → 执行操作  
4. 重复 2–3 直到完成  

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `ANDROID_AGENT_URL` | `http://127.0.0.1:5055` | android-agent 后端地址 |
| `ADB_CMD` | `adb` | adb 命令路径（adb 不在 PATH 时指定完整路径） |

## 可选：MCP 配置

参考 `mcp/mcp-config.example.json`。详见 README.md。

## 注意事项

- **设备 serial**：从 `devices` 获取，模拟器通常是 `emulator-5554`
- **坐标**：从 `elements` 的 `center` 字段取
- **中文输入**：基础模式偏 ASCII；中文需增强模式 + ADBKeyboard
- **多设备**：所有命令都带 serial
