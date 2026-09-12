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

Plan / Supervisor 演示视频仍放在 [plan-supervisor/](../plan-supervisor/README.md)，与 GUI 截图分开。

## 拍摄注意

- PNG/WebP，单张尽量 &lt; 600KB；宽约 1440px 横图更合适。
- 脱敏：API Key、本地绝对路径、真实客户对话。
- 窗口最大化或固定分辨率，避免每次比例乱跳。
- 换图后提交 `docs/assets/screenshots/`，并同步公仓 docs 面。
