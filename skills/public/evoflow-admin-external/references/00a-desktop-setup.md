# EvoFlow 桌面端：下载 → 配置 → 检测 CLI

外部 Agent / 用户在装治理技能包之前，必须先有 **可运行的 EvoFlow + `evoflow` CLI**。本页按顺序做完即可。

官网文档对照：[快速开始](/docs/getting-started) · 发行版：[GitHub Releases](https://github.com/EvovexAI/EvoFlow/releases/latest)

---

## 1. 下载并安装桌面端

| 入口 | 说明 |
|------|------|
| 官网首页顶部按钮 **「下载桌面端」** | 跳到 GitHub Releases |
| 顶栏 **下载** | 同上 |
| 直链 | https://github.com/EvovexAI/EvoFlow/releases/latest |

按系统选安装包（Windows `.exe` 等），运行安装向导。

**Windows 重要：** 安装向导有一页「将 evoflow CLI 添加到 PATH」——**保持默认勾选**。装完后**新开一个终端**（旧窗口 PATH 不刷新）。

静默安装参数（若用）：`/AddPath` 强制写 PATH，`/NoAddPath` 跳过。

不要运行安装根目录的 `evoflow.exe` 当 CLI——那是**桌面客户端**。CLI 入口是：

```text
<安装目录>\binaries\evoflow-gateway\tools\evoflow\evoflow.cmd
```

未勾选 PATH 时，用上面全路径调用，例如：

```powershell
& "<安装目录>\binaries\evoflow-gateway\tools\evoflow\evoflow.cmd" models list
```

---

## 2. 首次打开与配置模型

1. 启动 **EvoFlow 桌面客户端**（会起 Gateway；派发员工 / 跑 App 需要它在跑）。
2. **设置 → 模型**（或旧侧栏「配置 → 模型配置」）：
   - 添加服务商：名称、接口地址、API Key  
   - 测试连接（若界面有）  
   - 添加模型 ID → 设为 **主模型**
3. （可选）联网搜索：设置页「联网搜索」；或装好本技能后用 platform `settings.*_web_search`（见 `04-http-platform.md`）。
4. 开一轮对话确认能正常回复。

也可用 CLI 配模型（Gateway/配置路径就绪后）：

```bash
evoflow models create --file examples/model-create.json
evoflow models primary set <name>
evoflow models list
```

配置文件默认：`%USERPROFILE%\.evoflow\config.yaml`（或 `EVOFLOW_CONFIG_PATH`）。仅 `cd` 到数据目录**不会**改配置路径。

---

## 3. 检测 CLI 是否可用（必做）

在**新开**的 PowerShell / Terminal：

```powershell
# A. 是否在 PATH
Get-Command evoflow -ErrorAction SilentlyContinue
evoflow -h

# B. 功能冒烟（应返回 JSON，exit code 0）
evoflow models list
evoflow agents list
evoflow employees list
```

### 判定

| 结果 | 含义 | 处理 |
|------|------|------|
| `Get-Command` 有路径，`models list` 有 JSON | **CLI OK** | 继续装技能包 |
| `找不到 evoflow` | 未进 PATH / 未新开终端 | 新开终端；或用 `evoflow.cmd` 全路径；重装勾选 AddPath |
| `models list` 报错 / 空配置 | CLI 在，但模型未配或配置路径不对 | 回桌面端配模型；检查 `EVOFLOW_CONFIG_PATH` |
| 派发/审批失败 | CLI 在，Gateway 未开 | 先打开桌面客户端 |

### 一键自检脚本（可复制给 Agent）

```powershell
$ErrorActionPreference = 'Continue'
Write-Host '== which evoflow =='
Get-Command evoflow -ErrorAction SilentlyContinue | Format-List
Write-Host '== evoflow -h (exit) =='
evoflow -h | Select-Object -First 5
Write-Host "exit=$LASTEXITCODE"
Write-Host '== models list =='
evoflow models list --compact
Write-Host "exit=$LASTEXITCODE"
```

期望：能打印 help；`models list` 非 `{"error":...}` 且 exit 为 0。

---

## 4. 再装治理技能包

CLI 冒烟通过后：

1. 官网首页 `/#skill-pack` → **下载 .zip**  
   或直链：`/skills/downloads/evoflow-admin-external-1.0.3.zip`（版本以首页卡片为准）
2. `evoflow skills install <zip路径>`
3. `evoflow skills enable evoflow-admin-external`
4. 读 `00-concept-routing.md` → `03-cli-cheatsheet.md`

细节：[`01-install.md`](01-install.md)、[`02-version-check.md`](02-version-check.md)。

---

## 5. 给 runtime / Work Body 的最短指令

```text
1. 从 https://github.com/EvovexAI/EvoFlow/releases/latest 下载并安装 EvoFlow 桌面端（勾选 Add PATH，新开终端）
2. 打开客户端，在「设置 → 模型」配置主模型并确认能对话
3. 运行：evoflow models list ；失败则用安装目录 binaries/.../evoflow.cmd
4. 从官网 /#skill-pack 下载 evoflow-admin-external zip，evoflow skills install 后按包内 00/03/examples 管理平台
```
