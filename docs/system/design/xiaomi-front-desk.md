# 小V（xiaomi）能力盘点

> 身份码：`xiaomi` · 展示名：小V · 定位：**系统前台 / 平台管家**  
> 与 `main`（超级助手）分离：小V 不亲自改代码、不挂普通工具/MCP/技能。  
> 代码 SSOT：`backend/packages/harness/evoflow/agents/xiaomi/`

---

## 1. 一句话定位

小V是用户的**全局助手**与平台**后台常驻管家**：看名册 → 看进度 → **可下钻某员工/某任务** → 派活/催办 → 口语汇报；用法/概念题走知识库。具体实现永远交给智能体员工。

| 对比 | `main` 超级助手 | 小V (`xiaomi`) |
|------|-----------------|----------------|
| 职责 | 问答、改代码、编排任务 | 接待、传讯、分诊、催办、查进度、知识答疑 |
| 工具面 | 角色可配置内置工具 + MCP + 技能 | **仅前台系统工具（7 个）** |
| 值班 | 可雇佣为普通岗 | **常驻岗**（不可归档删除） |
| 回复风格 | 常规助手 | **口语短句、禁 Markdown**（偏语音播报） |

---

## 2. 应有工具（唯一允许面）

运行时由 `get_xiaomi_tools()` 挂载，`filter_xiaomi_tools()` 白名单裁剪。  
持久化配置固定：`tools=[]` / `skills=[]` / `mcp_servers=[]`（角色编辑器不展示普通工具勾选）。

### 2.1 总览 / 下钻 / 推进 / 知识

| 工具名 | 读写 | 作用 | 典型入参 | 关键返回 |
|--------|------|------|----------|----------|
| `xiaomi_org_status` | 读 | 名册：有多少员工、谁忙谁闲、待审批数 | （无） | `employee_count` / `busy_count` / `idle_count` / `employees[]`（不含小V自己） |
| `xiaomi_board_overview` | 读 | 各岗未结 Task 与进度；标出卡住候选 | `limit_per_role`（默认 8） | `total_open_tasks` / `boards[]` / `stuck_candidates[]` |
| `xiaomi_employee_brief` | 读 | **某员工近况**：忙闲、未结任务、近况摘要、最近工作轨迹 | `agent_code` 或岗位中文名；可选 `include_trail` | `busy` / `open_tasks` / `last_think_summary` / `work_trail.tool_sequence` / `last_assistant_text` |
| `xiaomi_task_brief` | 读 | **某 Task 汇报**：状态、进度、summary/result | `task_id` | `status` / `progress` / `summary` / `result` / 子任务摘要 |
| `xiaomi_dispatch` | 写 | **新目标**派给指定员工（开值班轮） | `agent_code` + `goal`（+ 可选 `description`） | 派发结果；对方忙碌 → `busy: true` |
| `xiaomi_wake` | 写 | **催办**已有 Task 或补一句目标 | 优先 `task_id`；否则 `goal`；必填 `agent_code` | 催办结果；禁止催自己 |
| `xiaomi_knowledge_search` | 读 | 检索已启用知识库 Vault（用法/概念/文档） | `query` + `top_k`（默认 6） | `items[]`（title/path/snippet）；无命中勿编造 |

源码：`agents/xiaomi/tools.py` · 白名单：`agents/xiaomi/tool_policy.py` · `XIAOMI_SYSTEM_TOOL_NAMES`。

### 2.2 用户话术 → 工具

| 用户大概会说 | 小V 该调 |
|--------------|----------|
| 现在有几个员工 / 谁闲着 | `xiaomi_org_status` |
| 全局有什么没干完 / 谁卡住了 | `xiaomi_board_overview` |
| 代码助手在干嘛 / 前端岗进度怎么样 | `xiaomi_employee_brief` |
| 这个任务怎么样了 / 汇报写了啥 | `xiaomi_task_brief` |
| 帮我让某某去做… | `xiaomi_dispatch` |
| 催一下那个未结任务 | `xiaomi_wake`（带 `task_id`） |
| 怎么用某某功能 / 什么是… | `xiaomi_knowledge_search` |

> `board_overview` 是**横扫**；`employee_brief` / `task_brief` 是**下钻**。用户点名查某人或某单时，不要只停在总览。

### 2.3 标准动作闭环

```
用户说话 / 值班心跳
        │
        ├─ 组织总览 ──► org_status ──► board_overview
        │                    │
        │                    ├─► employee_brief（某人在干嘛）
        │                    ├─► task_brief（某单汇报）
        │                    └─► dispatch（新活）或 wake（卡住）
        │                                      │
        │                                      └─► 一两句口语汇报
        │
        └─ 用法/概念/文档类 ──► knowledge_search ──► 基于片段口语回答
```

### 2.4 明确不该有的能力

以下**不得**出现在小V 工具面（配置层空列表 + 运行时白名单双保险）：

| 类别 | 示例 | 原因 |
|------|------|------|
| 一线工程 | `read` / `write` / `terminal` / `apply_patch` | 不代替员工改仓 |
| 澄清空转 | `ask_clarification` | 缺信息先查名册/看板/下钻，不问用户代替查工具 |
| 编排总承包 | `plan` / `supervisor` / `task` | 前台分诊，不做 DAG 总承包 |
| 联网检索 | `web_search` / `web_fetch_enhanced` | 文档走知识库 |
| 工具发现 | `tool_search` / `<tool_catalog>` | 工具面固定，无需动态发现；系统提示也不注入 deferred 目录 |
| 普通 MCP | 角色 `mcp_servers` | 前台不挂 MCP |
| 普通技能 | 角色 `skills`（含 baseline intro） | 知识答疑用 `xiaomi_knowledge_search` |
| 原始全量 transcript dump | 把整段 chat JSON 甩给用户 | 用 `work_trail` 压缩序列即可 |

---

## 3. 应有非工具能力

### 3.1 对话前台

| 能力 | 说明 | 实现要点 |
|------|------|----------|
| 全局助手会话 | 用户找「小V」聊天 | `agent_code=xiaomi`；prompt 走 `agents/xiaomi/prompt.py`，与 lead 通用 ROLE 分离 |
| 口语 / 语音友好回复 | 短句、先结论；禁 Markdown | SOUL + `<role>` / `<xiaomi_policy>` / `<xiaomi_runtime>` |
| 知识答疑 | 产品用法、概念、「为什么」类 | `xiaomi_knowledge_search`；内置「EvoFlow 用户指南」Vault + 用户自建 Vault |
| 查员工 / 查任务 | 「他在干嘛」「这单怎么样了」 | `xiaomi_employee_brief` / `xiaomi_task_brief` |
| 分诊派活 | 用户新需求未点名时按名册选岗 | 先 `org_status`，再 `dispatch` |
| 催办推进 | 未结 / 卡住 Task | `board_overview` → `wake(task_id=…)` |

### 3.2 常驻值班岗

| 项 | 值 |
|----|-----|
| 岗位 | `agent_code=xiaomi`，部门默认「用户办公室」 |
| 心跳 | `FREQ=HOURLY;INTERVAL=1`（每小时巡检） |
| 工时窗 | 默认 8:00–23:00 |
| 自主权 | `FULL_AUTO`；催办/派发默认可自动 |
| 轮次预算 | `max_turns=10`，`timeout_seconds=360` |
| 职责摘要 | 汇总未结 Task、催卡住交接、白话汇报；无待办则快速结束 |
| KPI 摘要 | 有阻塞则至少 wake/dispatch 一次或给出待用户确认项；不亲自提交业务代码 |
| 保护 | **不可归档/删除**（可下班暂停催办） |

源码：`agents/xiaomi/duty.py`（`ensure_xiaomi_proactive_role` / duty brief）。  
值班本轮优先用：`org_status` → `board_overview` →（必要时）`employee_brief`/`task_brief` → `wake`/`dispatch`。  
`knowledge_search` 主要是聊天答疑路径。

### 3.3 产品触点（非 LLM 工具）

| 触点 | 说明 |
|------|------|
| EvoPanel 智能体员工 | 名册卡片带「系统前台」；能力标签为「前台工具 / 无 MCP / 无技能」；默认头像为女性预设 `preset:analyst`（不与 `main` 男立绘共用） |
| 员工页工作轨迹 | `employee_brief` 的 `watch_path` 指向 `/proactive/{code}?live=1`，可口头指引用户点进去看 |
| 全局助手 / 桌面唤醒 | 「小V小V」本地 KWS（见 `evopanel/public/kws/`） |
| 角色配置 API | 更新时强制清空普通 tools/mcp/skills；列表响应同样归一化 |

---

## 4. 配置与运行时边界

```
持久化 AgentConfig (xiaomi)
  tools: []          ← 角色可配置工具：无
  skills: []         ← 普通技能：无
  mcp_servers: []    ← MCP：无
        │
        ▼
lead_agent 组装工具
  get_available_tools(…)  +  whitelist=[]
        │
        ▼
filter_xiaomi_tools + get_xiaomi_tools()
  → 仅 xiaomi_* 系统工具进 LLM
```

相关函数：

- `xiaomi_front_desk_capability_defaults()` / `enforce_xiaomi_front_desk_capabilities()` — `config/agents_config.py`
- 挂载点 — `agents/lead_agent/agent.py`（`is_xiaomi_agent` 分支）
- Gateway 保护 — `app/gateway/routers/agents.py`

空列表落库语义：`tools: []` 必须与 `tools: null`（= 全工具）区分；见 `persistence/row_mappers.py` 的 `__empty__` sentinel。

---

## 5. 验收清单

- [ ] 角色页小V：**不**显示「全工具 / 全 MCP / N 技能」；显示前台能力或空能力面  
- [ ] 聊天/值班轨迹：工具名仅出现 `xiaomi_*`（不应出现 `read`/`terminal`/`web_search` 等）  
- [ ] 用户问「代码助手在干嘛」→ 调用 `xiaomi_employee_brief`，口语说出忙闲/未结/最近工具要点  
- [ ] 用户问「某 task 汇报」→ 调用 `xiaomi_task_brief`，说出进度与 summary/result  
- [ ] 派发：`dispatch` 不能指向 `xiaomi` 自己  
- [ ] 已 `reviewed`/`completed` 的 Task：不再 `wake`「重试」（结果文案含「超时」但状态已结 = 已完成，只汇报）  
- [ ] 知识问答：无命中时明确说未找到，不编造  
- [ ] 回复：口语短句、无 Markdown 标题/列表/代码块  

回归测：`packages/harness/tests/test_xiaomi_front_desk.py`

---

## 6. 源码索引

| 模块 | 路径 |
|------|------|
| 身份 / 保护文案 | `agents/xiaomi/identity.py` |
| 系统工具实现 | `agents/xiaomi/tools.py` |
| 工具白名单 | `agents/xiaomi/tool_policy.py` |
| 对话提示词 | `agents/xiaomi/prompt.py` |
| 值班岗 + duty brief | `agents/xiaomi/duty.py` |
| 打包 SOUL | `assets/builtin_agent_souls/xiaomi.md` |
| 能力面物化 | `config/agents_config.py` |
| 组织对照（名册中的小V） | `docs/system/design/proactive-vs-closed-loop-harness.md` §3 |

---

## 7. 刻意不做（避免再次膨胀）

- 不把 `main` 的工程工具「顺便」挂给小V  
- 不把 baseline skills（`evoflow-intro` 等）合并进小V  
- 不在角色编辑器开放小V 的工具/MCP/技能勾选  
- 不把小V 当成 Plan/supervisor 总承包或代码执行岗  
- 不下发整段原始 chat transcript；下钻只给压缩轨迹 + 任务汇报字段  
