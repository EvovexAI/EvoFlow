# EvoFlow Plan 模式 · Agent Teams 协作流程说明

EvoFlow Plan 模式从需求输入到验收交付的完整协作流程说明文档（静态网页版）。

## 主文档

| 文件 | 说明 |
|------|------|
| [plan-workflow/index.html](./plan-workflow/index.html) | **正式流程说明页**（推荐） |
| [plan-workflow/styles.css](./plan-workflow/styles.css) | 样式 |
| [plan-workflow/main.js](./plan-workflow/main.js) | 导航、图片放大、专注阅读 |

### 官网访问

构建或部署官网后，顶栏菜单 **「Plan 流程」** 指向：

`https://www.evovexai.com/presentations/plan-workflow/`

同步脚本：`website/scripts/sync-presentations.mjs`（随 `pnpm sync:media` 自动执行，将本页与配图复制到 `website/apps/web/public/`）。


```bash
python -m http.server 8765 --directory docs
# 浏览器打开 http://localhost:8765/presentations/plan-workflow/
```

### 文档结构

| 章节 | 内容 |
|------|------|
| 一、模式概述 | 痛点与 Plan 模式定义 |
| 二、全流程概览 | 六阶段、协作状态机 |
| 三、规划阶段 | 澄清、调研、能力摸排、**能力缺口与角色创建**、三项门禁 |
| 四、计划阶段 | 结构化计划、确认授权 |
| 五、执行阶段 | 主控职责、团队协作、进度监控、**主控干预**、**子任务协作问询**、**用户方向修正** |
| 六、验收与交付 | 分层验收、交付形式、模式价值 |

## 备选：Marp / PPTX

早期导出版本，内容与网页版可能不同步：

- [evoflow-plan-workflow.marp.md](./evoflow-plan-workflow.marp.md)
- [evoflow-plan-workflow.pptx](./evoflow-plan-workflow.pptx)

## 配图素材

见 [../assets/plan-supervisor/README.md](../assets/plan-supervisor/README.md)。

## 技术对照

- 能力缺口与角色创建：`plan_tool.py` / `plan_prompt_blocks_zh.py`（用户同意后委派子任务创建，配置技能与工具）
- 子任务协作问询：`collab-peer-messaging-design.md`（进行中 ↔ 进行中、进行中 → 已完成）
- 主控干预：`supervisor_tool.py`（修正指令、重新执行、改派、续接会话）
- 用户方向修正：主会话 → 主控智能体；亦可针对子任务定向修正

详细技术说明见 [../guides/chat/plan-mode.md](../guides/chat/plan-mode.md)。
