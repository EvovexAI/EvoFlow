# android-agent Skill

让 EvoFlow 里的 AI Agent 通过命令行直接控制 Android 设备。

## 三级能力，按需启用

| 级别 | 前提 | 能力 |
|------|------|------|
| **🟢 基础** | Python 3.8+ + adb | 设备列表、点击、输入、滑动、截图、按键、启动应用、已装应用列表 |
| **🟡 增强** | + android-agent 后端 (:5055) | UI 元素解析（含坐标/可点击性）、LLM 可读屏幕树、OCR、截图标注、设备健康检查 |
| **🔵 可选** | + MCP 注册到 EvoFlow | 模型通过 MCP 工具发现路径调用（需要 EvoFlow 后端） |

脚本 **自动检测** 后端是否可用，有后端走 REST API（增强），没有走 ADB 直连（基础）。输出中 `_mode` 字段标明当前模式。

## 快速开始（30 秒）

```bash
# 0. 先跑环境检查（缺什么提示什么，附下载链接）
python scripts/check_env.py

# 1. 把整个 android-agent/ 目录放到技能目录，直接用
python scripts/android_ctl.py devices

# 2. 在 EvoFlow 面板里对模型说："列出 Android 设备" / "截屏看看手机" / "点击屏幕上的按钮"
```

**不需要安装任何 Python 包**，脚本仅依赖 Python 标准库（`subprocess` + `urllib`）。

> 第一次使用如果 `check_env.py` 提示缺 adb，按提示下载 Platform Tools 解压即可，不需要装 Android Studio。

## 目录结构

```
android-agent/
├── SKILL.md                      # 技能定义（Agent 读取）
├── README.md                     # 本文件（人类阅读）
├── scripts/
│   ├── android_ctl.py            # 双模式 CLI（核心脚本）
│   └── check_env.py              # 环境一键检查（缺什么提示什么）
└── mcp/
    └── mcp-config.example.json   # MCP 配置模板（可选）
```

## 命令速查

```bash
python scripts/android_ctl.py <command> [args...]
```

| 命令 | 用途 | 示例 |
|------|------|------|
| `devices` | 列出已连接设备 | `devices` |
| `screenshot <device> [--save path]` | 截屏（保存到文件） | `screenshot emulator-5554 --save screen.png` |
| `elements <device>` | 屏幕 UI 元素列表（含坐标、文字） | `elements emulator-5554` |
| `tree <device>` | LLM 可读的屏幕层级树 | `tree emulator-5554` |
| `tap <device> <x> <y>` | 点击坐标 | `tap emulator-5554 540 1200` |
| `type <device> <text>` | 输入文字 | `type emulator-5554 "Hello"` |
| `swipe <device> <x1> <y1> <x2> <y2>` | 滑动 | `swipe emulator-5554 540 1500 540 500` |
| `back <device>` | 返回键 | `back emulator-5554` |
| `home <device>` | 主页键 | `home emulator-5554` |
| `key <device> <keycode>` | 发送按键 | `key emulator-5554 ENTER` |
| `launch <device> <package>` | 启动应用 | `launch emulator-5554 com.android.settings` |
| `stop <device> <package>` | 强制停止应用 | `stop emulator-5554 com.android.settings` |
| `packages <device>` | 已安装应用列表 | `packages emulator-5554` |
| `health <device>` | 设备健康检查 | `health emulator-5554` |

## 安装方式

### 安装到 EvoFlow（推荐）

```bash
# 复制到 EvoFlow 技能目录
cp -r android-agent/ ~/.evoflow/skills/public/android-agent/

# 重启 EvoFlow 或刷新技能列表
# 在面板里对模型说："列出 Android 设备"
```

Windows 目标路径示例：`%USERPROFILE%\.evoflow\skills\public\android-agent\`

不会用命令行：解压后拖进 EvoFlow，让 AI 按 `使用说明-从零开始.md` 帮你安装。

### 独立使用（不需要 AI，只测脚本）

脚本本身就是一个完整的 CLI 工具，直接在终端跑：

```bash
python scripts/android_ctl.py devices
python scripts/android_ctl.py tap emulator-5554 540 1200
python scripts/android_ctl.py screenshot emulator-5554 --save screen.png
```

## 可选：启用增强模式

如果需要 UI 元素解析、OCR 等高级功能，启动 android-agent 后端：

```bash
# 1. 克隆 android-agent 项目
git clone https://github.com/your-repo/android-agent.git
cd android-agent

# 2. 安装依赖（Python 3.10+）
python -m venv .venv
.venv\Scripts\activate    # Windows
# source .venv/bin/activate  # Linux/Mac
pip install -r requirements.txt

# 3. 启动后端
python -m gitd.app
# 默认运行在 http://127.0.0.1:5055
```

脚本会自动检测后端并切换到增强模式，无需额外配置。

## 可选：MCP 配置（EvoFlow 专用）

如果想让 EvoFlow 模型通过 MCP 工具发现路径调用（而非 terminal + 脚本），参考 `mcp/mcp-config.example.json`：

```bash
# 1. 启动 android-agent MCP server（HTTP 模式）
cd android-agent
python -m gitd.mcp_server --http --port 8002

# 2. 在 EvoFlow 中注册
# UI: 设置 -> MCP -> 添加 -> 名称: android-agent, URL: http://127.0.0.1:8002/mcp, Transport: http
# 或 API:
curl -X PUT http://127.0.0.1:8070/api/config/mcp-servers/android-agent \
  -H "Content-Type: application/json" \
  -d '{"url":"http://127.0.0.1:8002/mcp","transport":"http"}'

# 3. 绑定到 agent
curl -X PUT http://127.0.0.1:8070/api/agents/main \
  -H "Content-Type: application/json" \
  -d '{"mcp_servers":["android-agent"]}'
```

> **注意**：MCP 方式依赖 EvoFlow 的 ContextVar 传播，可能需要重启后端才能生效。日常使用推荐 terminal + 脚本方式，更简单稳定。

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `ANDROID_AGENT_URL` | `http://127.0.0.1:5055` | android-agent 后端地址 |
| `ADB_CMD` | `adb` | adb 命令路径（如 adb 不在 PATH 中可指定完整路径） |

## 常见问题

**Q: adb 不在 PATH 中？**
```bash
# Windows
set ADB_CMD=D:\Android\Sdk\platform-tools\adb.exe
# Linux/Mac
export ADB_CMD=/opt/android-sdk/platform-tools/adb
```

**Q: 中文输入不生效？**
ADB 的 `input text` 仅支持 ASCII。中文需要安装 [ADBKeyboard](https://github.com/senzhk/ADBKeyBoard) 后用 `type_unicode` 命令（需要增强模式）。

**Q: 模拟器连不上？**
```bash
adb kill-server
adb start-server
adb devices
```

**Q: 多台设备怎么选？**
先跑 `devices` 拿到 serial，所有命令都带 serial 参数：`tap <serial> <x> <y>`。
