# 桌面端 GUI 截图资源

供根目录 [README.md](../../README.md)（中文主页）/ [README.en.md](../../README.en.md) 引用。

**原则：** 截图必须对应当前 EvoPanel 侧栏与设置中心；过时图宁可不挂，也不要继续用旧「应用中心 / 顶栏模型页」画面误导用户。

本地面板常见地址：`http://localhost:1521`（以你本机 dev 端口为准）。

## 主页待换新图（优先拍这套）

| 文件名 | 拍摄内容 | 路由/入口 |
|--------|----------|-----------|
| `main-chat.png` | 新建对话，可见 Ask/Agent/Plan/Goal | `#/chat` |
| `task-center.png` | 任务中心（协作任务 / 我的事项） | `#/tasks` |
| `workflow.png` | 工作流列表或某个应用画布 | `#/apps` |
| `expert.png` | 智能体页（智能体 / 技能 / 连接器） | `#/expert` |
| `employees.png` | 智能体员工 | `#/proactive` |
| `settings-models.png` | **设置 → 模型** | `#/settings?tab=models` |
| `settings-im.png` | **设置 → IM 通信**（可选） | `#/settings?tab=im` |
| `wechat-group-qr.png` | 社群二维码 | — |

## 已退役命名（勿再当主页主图）

| 旧文件 / 旧说法 | 现状 |
|-----------------|------|
| `app-center.png` / 「应用中心」 | 侧栏已改称 **工作流** → 用 `workflow.png` |
| `agents-preset-*.png` | 智能体页已并入 `#/expert` → 用 `expert.png` |
| `smart-employees.png` | 改用 `employees.png` |
| 顶栏独立「模型 / 渠道 / 记忆」截图 | 模型与 IM 在 **设置**；记忆在 **资产中心** |

## 清单核对（截至 2026-09）

上面两张表是"该拍什么"，下面这张是"现在实际有什么"。照清单找图前先看这里，避免扑空。

### 目录中现有文件的状态

| 文件 | 状态 |
|------|------|
| `main-chat.png` | 在「待换新图」清单中，文件已存在 |
| `task-center.png` | 在「待换新图」清单中，文件已存在 |
| `wechat-group-qr.png` | 在「待换新图」清单中，文件已存在；已被 `README.md` / `README.en.md` 引用 |
| `agents-preset-teams.png`、`agents-preset-roles.png` | 已退役（智能体页并入 `#/expert`），文件仍在 |
| `smart-employees.png` | 已退役（改用 `employees.png`），文件仍在 |
| `app-center.png` | 已退役（侧栏改称「工作流」），文件仍在 |
| `app-center-canvas.png` | 文件存在，未登记在任何一张表里；同属已退役的「应用中心」命名 |
| `agents.png`、`browser.png`、`hosted-1.png`、`hosted-2.png`、`scheduled-tasks-1.png`、`scheduled-tasks-2.png` | 文件存在，但未登记在上面任何一张表里 |

### 「待换新图」清单中尚缺的文件

这 5 个文件名在目录中还不存在，拍图补位时注意：

`workflow.png`、`expert.png`、`employees.png`、`settings-models.png`、`settings-im.png`

### 关于 alt 文本

全仓 Markdown 目前只有 4 处 `<img>`（`README.md` 与 `README.en.md` 各两张微信二维码），
均已带 `alt`，且没有指向不存在文件的图片链接。因此本轮只更新清单，不动二进制文件。

Plan / Supervisor 演示视频仍放在 [plan-supervisor/](../plan-supervisor/README.md)，与 GUI 截图分开。

## 拍摄注意

- PNG/WebP，单张尽量 &lt; 600KB；宽约 1440px 横图更合适。
- 脱敏：API Key、本地绝对路径、真实客户对话。
- 窗口最大化或固定分辨率，避免每次比例乱跳。
- 换图后提交 `docs/assets/screenshots/`，并同步公仓 docs 面。
