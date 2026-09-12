# 概念路由：用户一句话 → 用哪组命令

> 尚无桌面端 / CLI？先 [`00a-desktop-setup.md`](00a-desktop-setup.md)。

外部 Agent **先读本页再动手**。EvoFlow 里有多套「待办 / 员工 / 流程」，名字容易混。

## 1. 一张表定路由

| 用户大致说法 | 正确入口 | 不要用 |
|--------------|----------|--------|
| 「帮我记一下」「备忘」「个人待办」「周五交报告」 | **`items`**（个人事项） | `tasks`、`todo`（对话内 checklist） |
| 「任务中心那单」「结案」「改进度」「子任务」 | **`tasks`**（协作台账） | `items`（除非先记事再派工） |
| 「建个角色 / 助手 / SOUL / 工具白名单」 | **`agents`** | 直接 `employees hire`（岗需要先有 Agent） |
| 「雇成员工」「值班岗」「改职责 KPI」「今天谁在岗」 | **`employees`**（智能体员工 / 岗位） | 把员工拉进群聊互相对话 |
| 「让 XX 去干」「@某岗」「唤醒同事」 | **`employees dispatch` / `wake`** 或 **`items dispatch`** | 只建 `tasks` 却不 wake |
| 「批一下」「待审批」 | **`approvals`** | 直接改 task 状态绕过审批（除非用户明确跳过） |
| 「跑一下那个 App / 工作流」「固化流程」 | **`workflow`**（运行）；创建/发布见 platform `/api/apps` | 当成 LangGraph 长对话 |
| 「Plan 模式拆解长任务」「子代理并行」 | Gateway **Plan / supervisor**（对话内）或任务中心；外部 Agent 多用 `tasks`+`employees` | 只用 `workflow list` |
| 「每天九点自动…」「定时」 | **`automation`** | `employees` 心跳（心跳是值班巡检，不是任意 cron 文案） |
| 「装一整套内容运营团队」 | **`org`**（资源包） | 手工一个个 `agents create`（除非用户只要单个角色） |
| 「对话里上次聊过…」 | **`sessions search`** | 让用户自己翻面板 |
| 「系统报错 / 日志」 | **`logs`** / platform `diagnostics.*` | 手翻未知路径 |

## 2. 四套「事」别混

```text
items     = 用户个人事项/备忘（记事本）。默认不自动开跑。
tasks     = 协作任务台账（任务中心）。有状态机、进度、结案。
employees = 值班岗位（谁在岗、心跳、派发、工作汇报）。依赖已有 agents。
workflow  = 面板 Apps（可发布、可重复跑的参数化流程）。
```

典型组合：

1. **只记事** → `items create`  
2. **记事并马上派人** → `items create` → `items dispatch --agent <code>`（会派生 Task + 尽量 wake）  
3. **已有岗，直接派目标** → `employees dispatch <code> --goal "…"`  
4. **任务中心结案** → `tasks state … --status completed --summary "…"`  
5. **跑固化 App** → `workflow run App_xxx --file params.json`

## 3. 两套「人」别混

| | **agents**（智能体 / 角色） | **employees**（智能体员工 / 岗位） |
|--|------------------------------|-------------------------------------|
| 是什么 | 配置：SOUL、技能、工具、模型 | 雇佣关系：职责、KPI、心跳、上下班 |
| 命令 | `evoflow agents …` | `evoflow employees …` |
| 顺序 | **先** `agents create` | **再** `employees hire`（同一 `agent_code`） |
| 删除/归档 | `agents delete` 默认级联岗 | `employees archive` 不删 Agent |

「Lead / 主对话 / 小蜜」一般是 `main`（或产品配置的前台码），**不是**必须雇成 employees。  
用户说「lcw / 岗位 / 值班 / 自动上班」→ 走 **employees**；说「角色配置 / 改提示词」→ 走 **agents**。

## 4. 三套「流程」别混

| | 含义 | 外部 Agent 怎么动 |
|--|------|-------------------|
| **workflow / Apps** | 面板可发布应用 | CLI：`workflow list/get/run/status/stop`；创建发布：`POST /api/platform` `workflow.*` 或 `/api/apps` |
| **Plan + supervisor** | 对话内长任务编排 | 主要在 EvoFlow 会话；外部可用 `tasks` 观察台账 |
| **LangGraph** | `lead_agent` / `goal_agent` 运行时 | `/api/langgraph`；**不要**当成 `workflow` CLI |

## 5. 决策小流程（给 Agent）

```text
用户意图
  ├─ 记事/备忘？ ──────────────────────► items
  ├─ 任务中心状态/结案？ ───────────────► tasks (+ 必要时 approvals)
  ├─ 改角色人设/技能？ ────────────────► agents
  ├─ 雇岗/值班/派活/看汇报？ ──────────► agents?(若无) → employees
  ├─ 跑/停已有 App？ ──────────────────► workflow
  ├─ 新建可复用 App？ ─────────────────► platform workflow.create|publish
  ├─ 定时自动跑？ ─────────────────────► automation
  ├─ 装团队包？ ───────────────────────► org
  └─ 排障？ ───────────────────────────► logs / diagnostics
```

命令细节 → [`03-cli-cheatsheet.md`](03-cli-cheatsheet.md)  
剧本 → [`05-playbooks.md`](05-playbooks.md)  
JSON → [`../examples/README.md`](../examples/README.md)
