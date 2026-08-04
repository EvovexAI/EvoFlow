# 桌面端 GUI 截图资源

将 EvoFlow 桌面图形界面截图与社群二维码放在本目录，供根目录 [README.md](https://github.com/EvovexAI/EvoFlow/blob/main/README.md) / [README.zh-CN.md](https://github.com/EvovexAI/EvoFlow/blob/main/README.zh-CN.md) 引用。

本地面板默认：`http://localhost:1521`。可用仓库 `temp/capture-readme-screenshots.mjs`（需 Playwright）批量刷新。

## 当前 README 引用

| 文件名 | 用途 | 建议 |
|--------|------|------|
| `main-chat.png` | 主界面欢迎页 / 对话栏 | 宽约 1440px，横图 |
| `task-center.png` | 任务中心驾驶舱 | 含来源 Tab、状态与列表 |
| `app-center.png` | 应用中心列表 | 含活跃筛选与应用卡片 |
| `app-center-canvas.png` | 点进应用后的画布编排 | 节点库 + 画布 DAG |
| `smart-employees.png` | 智能体员工值班台 / 名册 | 含值班状态与员工卡片 |
| `agents-preset-teams.png` | 智能体页角色总览 | `#/expert` 全部角色 |
| `agents-preset-roles.png` | 项目团队等筛选后的角色 | 如「项目」分类 |
| `scheduled-tasks-1.png` | 自动化调度页 | `#/cron` |
| `wechat-group-qr.png` | 微信联系二维码（加好友后拉群） | 约 400×400px |

## 可选 / 历史资源

| 文件名 | 说明 |
|--------|------|
| `scheduled-tasks-2.png` | 自动化第二张（编辑页等），README 未强制引用 |
| `hosted-1.png` / `hosted-2.png` | 旧「目标任务」截图，已由任务中心等替换出主 README |
| `browser.png` | 旧浏览器自动化截图，主 README 已不再引用 |
| `agents.png` | 旧智能体页，可忽略 |

## 注意事项

- 格式：PNG 或 WebP；单张尽量 &lt; 600KB（可用 TinyPNG 等压缩）。
- 内容：脱敏路径、密钥、私人聊天内容。
- 二维码过期后替换 `wechat-group-qr.png` 并提交即可。
- 若某张暂未就绪，可先不上传；README 中对应位置会显示占位图裂链，补图后自动生效。

## Plan 模式 / Supervisor 协作

视频与 Plan 流程截图见 **[plan-supervisor/](../plan-supervisor/README.md)**（与本文档分开存放，避免混淆通用 GUI 截图）。
