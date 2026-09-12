---
name: evoflow-system-verification
description: >-
  EvoFlow 全平台系统验证（真实串联案例「内容运营工作室一日」）：用 platform /
  HTTP /api/platform 的 verification.* 开轮、seed 待开始、按 ID 接力真实调用
  全部业务接口并 step 回填、conclude。凡 AI 运行（workflow.run / wake 派发等）须单独
  等待并审 progress/轨迹/提示词。覆盖 78 业务 API + verification 元接口；
  用户说系统验证、全平台验证、全流程串联、接口清单、verification、平台冒烟、
  内容运营验证时使用。详表同目录 scenario-full-chain.md。
---

# EvoFlow 系统验证

对话助手用内置工具 **`platform`**；脚本 / 外部 Agent用 **`POST http://127.0.0.1:8070/api/platform`**（同一套分发）。  
**禁止**用临时文件/自建表代替 `verification.*` 记账。

日常治理总表：`evoflow-admin`。本技能 = **验证轮次 + 全平台真实串联案例**。

逐步明细表（可与下文对照）：[`scenario-full-chain.md`](scenario-full-chain.md)

---

## 何时用

- 系统验证 / 全平台验证 / 开一轮验证 / 接口冒烟 / verification
- 要把 **全部 platform 业务接口**按真实故事从前到后串起来
- 查接口清单、seed 待开始、回填结论

---

## 覆盖规模（有没有漏）

| 项 | 数 |
|----|-----|
| 域 | 16（含 verification） |
| 接口总计 | **87** |
| 业务接口 | **78**（故事必须覆盖：真跑或显式 `skipped`+原因） |
| 元接口 | **9** × `verification.*`（记账用，不进业务故事） |

**真实案例名：**「内容运营工作室一日」  
开事项 → 角色/员工就绪 → 派活 → 跑工作流 → 知识库/经验 → 定时自动化 → 诊断。

**故意不真改（须 `skipped` + detail 写原因）：**

- `settings.set_default_model` / `assets.update_profile` / `patch_web_search` / `create_model` / `delete_model`
- `memory.clear` / `memory.delete_fact`（除非本轮可删测试事实）
- 无待批时 `approvals.approve` / `reject`
- 工作流已结束时 `workflow.stop`
- `skills.install` / `skills.delete`（无沙箱时 skip；`skills.enable` 须 false→true 还原或 skip）
- `mcp.set`：**允许**「`mcp.get` 后原样写回」无害往返，不算污染

---

## 硬规则

1. 先 `verification.init`（建议不传 `domains` = seed 全部业务接口为待开始）拿 **`roundId`**。
2. 写操作 **`confirm=true`**。
3. 每步：**真实调用业务 API** → 立刻 `verification.step`（同 `api` **覆盖**待开始/失败旧行并去重，禁止留下重复步骤）。
4. 用 **ID 接力**，不要各域孤立冒烟。
5. 验收写进 `result`（如 `status=todo` / `hits=N`）；`knowledge.search` 看 `hits`/`entries`；`workflow.run` 看顶层 `runId`；`tasks.set_state` 用合法态如 `executing`（不是 `in_progress`）。密钥脱敏；勿向用户倾倒整段 JSON。
6. 破坏性默认 skip；用户要清理时再跑 Act G 或脚本 `--cleanup`（只删本轮创建物）。
7. 显式 Obsidian `vaultId`（如 `evoflow-docs`）会走 Vault 连接器；`kb_…` 或省略则按 owned 主库策略。
8. **凡会跑 AI 的步骤必须单独等待并审轨迹**（见下节）——禁止「启动后立刻 stop / 只看 HTTP 200 就算过」；`items.dispatch` **禁止** `wake_now=false`；轨迹指**任务内工具步骤**（`tasks.execution_trail` / `employees.trail`），不是子任务状态清单。

---

## AI 运行类步骤（强制）

以下会触发模型/多智能体执行，**不得与普通 CRUD 同等对待**：

| 触发 | 典型 API |
|------|----------|
| 工作流运行 | `workflow.run` → 轮询 `workflow.run_status` |
| 事项唤醒派发 | `items.dispatch` **必须** `wake_now=true`（禁止 false 冒充验收） |
| 定时自动化真触发 | `automation` 到点执行（验证时一般 pause，真触发须单独等） |
| 员工值班轮 | `employees.resume` 后心跳触发的巡检（若本轮刻意测） |

### 等待

1. 启动后拿到 `runId` / `taskId`，**进入独立等待循环**（与前后 CRUD 步骤隔离）。
2. 每隔数秒调 `workflow.run_status`（或 `tasks.get` 含 subtasks），记录：`status`、`progress`、各 step/subtask 状态。
3. **等到终态**（`completed` / `failed` / `cancelled` / `error`）再写本步结论；仅当超时预算耗尽才 `workflow.stop`，并在 `result` 标明 `timeout-stop` + 最后 progress/trail。
4. 推荐预算：短冒烟 ≥ 2–3 分钟；正式验证按应用复杂度 5–15 分钟，可配置。

### 审进度

- progress 应随时间非降（允许短暂平台）
- 子步骤应按依赖顺序推进（被依赖步先完成）
- 长时间 0% 且无 step 变化 → 记异常，查是否卡授权/缺模型/工具失败

### 审轨迹（trail）

用 `workflow.run_status` 返回的 `trail` / `steps`（或 `tasks.get` 的 subtasks）：

- 步骤数、名称、assigned_agent 是否与 `workflow.get` 的 plan/steps 一致
- 是否出现无意义空转、重复失败重试失控、跳过必经节点
- `error_text` / `result_summary` 是否对应该步目标
- 不合理 → `status=failed`，`detail` 写清轨迹问题（即使 run 最终 completed）

### 审提示词 / 目标表述

在 `workflow.get`（及 run 后的 step `description` / plan goal）检查：

- goal / step description 是否具体、可验收，有无空话或与事项标题无关
- 是否泄露密钥、错误引用不存在的路径/库
- 派发类：dispatch 后 Task 描述是否承接 item 标题与约束
- 不合理 → 可 `passed` 运行但 `result` 标 `prompt-concern:…`，或直接 `failed`（按严重度）

### 回填 verification.step

AI 等待结束后，对 `workflow.run_status`（及必要时 `tasks.get`）回填时，`result` 建议包含：

`final=completed progress=100 steps=3/3 trail_ok=true prompt_ok=true`

轨迹/提示词有问题时：`trail_ok=false:…` / `prompt_ok=false:…`。

---

## 调用方式

### 助手

```text
platform(action="verification.init", args_json="{\"title\":\"内容运营工作室一日-全量\",\"scenario\":\"full-chain-real\",\"confirm\":true}", confirm=true)
```

### 脚本 / curl

```http
POST /api/platform
{"action":"verification.init","args":{"title":"内容运营工作室一日-全量","scenario":"full-chain-real","confirm":true},"confirm":true}
```

```http
POST /api/platform
{"action":"verification.step","args":{"roundId":"svr_…","api":"items.create","status":"passed","request":{},"response":{},"result":"status=todo","durationMs":12,"confirm":true},"confirm":true}
```

---

## ID 接力（执行时内存 ctx）

```
model + agentCode
  → itemId → (dispatch) taskId
  → appId → runId
  → vaultId → notePath → search
  → experienceId
  → automationId → paused → (可选) delete
  → diagnostics + worklog + sessions.search
```

---

## 标准执行流程

### 0) 账本（verification 元接口）

| API | 作用 |
|-----|------|
| verification.catalog | 可选，确认清单 |
| verification.init / start | 开轮 + seed 待开始 |
| verification.step | 每业务步回填 |
| verification.get / list / update | 查进度 |
| verification.conclude | 收尾 |
| verification.delete | 勿删正在跑的主轮；另开一次性轮次才测 |

### 1) Act A — 环境就绪

真跑：`settings.list_models` → `get_default_model` → `get_model` → `assets.get_profile` → `get_web_search` → `test_web_search`  
→ `agents.list/get` → 必要时 `create` → **`agents.update`**  
→ `employees.list` → 必要时 `hire` → `get` → **`update` → `pause` → `resume`**  
→ `skills.list/get`（`enable` 可还原或 skip）  
→ `mcp.get` → **`mcp.set` 原样回写**  
写配置类 settings / skills.install|delete → **skipped**

### 2) Act B — 开单派活（真实唤醒）

`items.create`（标题含 `[验证]`）→ `get` → `update` → `list`  
→ **`employees.resume` 确保在岗** → **`items.dispatch(wake_now=true, force/interrupt 按需)`**  
→ **独立等待** 该 `taskId` 终态，并用 `tasks.execution_trail` / `employees.trail` 审**任务内工具步骤**（不是只看子任务状态列表）  
→ 再 `tasks.create`（行政覆盖）→ `list` / `set_state`（勿对手动打断刚跑完的派发任务）  
→ `employees.worklog` → **`stop` → `resume`（必须在唤醒等待之后）**

禁止 `wake_now=false` 冒充验收；禁止派发后立刻 stop。

### 3) Act C — 生产（AI 运行：单独等待 + 审轨迹/提示词）

`workflow.list` 选 **appId**（没有则整幕 skipped/failed + exception）  
→ `workflow.get`：**先审** plan/steps 的 goal、description（提示词/目标是否具体可验收）  
→ `workflow.run`（参数必须填真实 `theme` / `video_count` 等，禁止占位符裸跑）拿 **runId**  
→ **独立等待循环** `workflow.run_status`（看 `progress` + 步骤状态）直到终态  
→ **`tasks.execution_trail`** 审每个子任务 session 的工具调用序列是否合理  
→ 回填 `trail_ok` / `prompt_ok` / `tool_steps`；不合理可 failed

### 4) Act D — 沉淀

`knowledge.list` → 必要时 `create/enable` → `ingest` → `notes` → `note_get` → `search`  
→ `experience.save/get/list`  
→ `memory.agents/get`（clear/delete_fact 默认 skipped）  
→ `sessions.search`

### 5) Act E — 定时与审批

`automation.create` → `get` → **`update`** → `list` → `history` → **`set_status=paused`**  
→ `approvals.list` → 有单才 `approve`/`reject`，否则 skipped

### 6) Act F — 诊断

`diagnostics.sources` → `scan` → `timeline`  
（有 ERROR 写入 round.exceptions 摘要，不单凭日志判业务失败）

### 7) Act G — 清理（仅 `cleanup=true`）

逆序只删本轮对象：`automation.delete` → `experience.delete` → `knowledge.note_delete` →（自建库）`enable false` → `tasks.delete` → `items.delete` →（验证号）`employees.archive` / `agents.delete`

---

## 全量核对（78 业务 API，执行时勾完）

- **knowledge(8)** create, enable, ingest, list, note_delete, note_get, notes, search  
- **workflow(5)** get, list, run, run_status, stop  
- **settings(9)** list_models, get_default_model, get_model, get_web_search, test_web_search ｜ *skip:* set_default_model, patch_web_search, create_model, delete_model  
- **assets(2)** get_profile ｜ *skip:* update_profile  
- **agents(5)** list, get, create, update ｜ delete→G  
- **employees(9)** list, hire, get, update, pause, resume, stop, worklog ｜ archive→G  
- **tasks(5)** create, get, list, set_state ｜ delete→G  
- **items(6)** create, get, update, list, dispatch ｜ delete→G  
- **skills(5)** list, get, enable ｜ *skip/sandbox:* install, delete  
- **mcp(2)** get, set(原样回写)  
- **automation(7)** create, get, update, list, history, set_status ｜ delete→G  
- **approvals(3)** list ｜ approve/reject 有单才跑  
- **memory(4)** agents, get ｜ *skip:* clear, delete_fact  
- **sessions(1)** search  
- **experience(4)** save, get, list ｜ delete→G  
- **diagnostics(3)** sources, scan, timeline  

漏任一业务 API（未 passed/failed/skipped）→ **不得 conclude 为全绿**。

---

## step / conclude

| status | 何时 |
|--------|------|
| passed | 真调用且验收过 |
| failed | 业务失败/断言未过 |
| error | 异常/超时 |
| skipped | 故意不做，detail 写原因 |

```text
platform(action="verification.conclude", args_json="{\"roundId\":\"svr_…\",\"conclusion\":\"…\",\"confirm\":true}", confirm=true)
```

结论模板：

> round `svr_…`「内容运营工作室一日」：业务 78 — 通过 X / 失败 Y / 跳过 Z；ID：item=… task=… run=…；阻塞点：…

---

## 对用户回报

- 开轮：`roundId`、seed 步数  
- 进度：当前 Act + 刚完成的 api + passed/failed  
- 结束：结论一句 + 失败/跳过条数  

## 用户一句话

> 按 evoflow-system-verification 跑全平台真实串联「内容运营工作室一日」：init 全量待开始 → 按技能 Act A–F ID 接力真调用并 step → conclude；破坏性默认 skip。把 roundId 和结论给我。
