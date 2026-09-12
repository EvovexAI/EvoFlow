# 全平台串联验证案例（明细表）

> **技能正文（必读/执行入口）：** [`SKILL.md`](SKILL.md)  
> 本文是 Act 逐步表与核对清单的展开版；与 SKILL 冲突时以 **SKILL.md** 为准。

---

> 对照注册表（当前）：**16 域 / 87 接口** = 业务 **78** + `verification.*` 元接口 **9**。  
> `verification.*` 是记账工具本身（init/step/conclude…），不进业务故事，但开轮/回填/收尾必须调用。

---

## 覆盖结论（有没有漏）

| 结论 | 说明 |
|------|------|
| **故事是真实案例** | 「内容运营工作室一日」：开事项→雇人值班→派活→跑工作流→沉淀知识/经验→定时自动化→诊断 |
| **业务接口可全覆盖** | 78 个业务 API 都在下面 Act 里出现（执行或显式 skipped 并写明原因） |
| **先前稿漏了这些** | 已补进本文：`agents.update`；`employees.pause/resume/stop/update`；`tasks.create`；`automation.update`；`settings.get_model` 与写配置类的显式 skip 清单；`skills.enable/install/delete` |

**不是漏功能，而是故意不执行的**（须在 step 标 `skipped` + 原因）：

- 会改坏本机默认配置：`settings.set_default_model` / `assets.update_profile` / `patch_web_search` / `create_model` / `delete_model`
- 会改全局 MCP：`mcp.set`（可用「读回后原样 set」做无害往返，见 A 幕）
- 清空记忆：`memory.clear` / `memory.delete_fact`（除非本轮写入了可删的测试 fact）
- 无待批单据时：`approvals.approve` / `reject`
- 工作流已结束后：`workflow.stop`

---

## 设计原则

1. **一条故事，不是 N 个孤岛**  
2. **ID 接力**：`agentCode` → `itemId` → `taskId` → `runId` → `vaultId/notePath` → `experienceId` → `automationId`  
3. **先读后写，破坏性逆序清理或 skip**  
4. **验收写进 `verification.step.result`**，不要只记 HTTP 200  
5. **AI 运行单独等待**：`workflow.run` / `items.dispatch(wake_now)` 等启动后，必须独立轮询进度与 trail，审轨迹与提示词是否合理；禁止启动后立刻 stop 或只凭 HTTP 200 结案（详见 SKILL「AI 运行类步骤」）

---

## 主故事：内容运营工作室一日

### 开场变量

| 变量 | 来源 |
|------|------|
| `roundId` | `verification.init`（可 seed 全业务域；排除 verification 自身） |
| `model` | `settings.get_default_model` |
| `agentCode` | 已有员工，或 `agents.create` → `employees.hire` |
| `appId` | `workflow.list` 选一个可跑应用；没有则 C 幕整段 failed/skipped 并记 exception |

---

### Act 0 — 验证账本（verification 元接口，必跑）

| API | 何时 | 验收 |
|-----|------|------|
| verification.catalog | 开轮前可查清单 | total≥78（业务） |
| verification.init / start | 开轮 + seed 待开始 | roundId；pending=业务数 |
| verification.get / list / update | 中途看进度 | ok |
| verification.step | 每业务步回填 | 同 api upsert |
| verification.conclude | 收尾 | 结论+exceptions |
| verification.delete | 仅测删除能力时另开一次性轮次 | 可选；**不要删正在跑的主轮** |

---

### Act A — 环境就绪（settings / agents / employees / skills / mcp）

| 序 | API | 真实怎么做 | 产出/验收 |
|----|-----|------------|-----------|
| A1 | settings.list_models | 列出 | count≥1 |
| A2 | settings.get_default_model | 读默认 | **model** 非空 |
| A3 | settings.get_model | model=A2 | 配置可读 |
| A4 | assets.get_profile | 读画像 | ok |
| A5 | settings.get_web_search | 读搜索配置 | ok（脱敏） |
| A6 | settings.test_web_search | query=`AI短视频选题` | 通或明确 failed |
| A7 | agents.list | 列角色 | 有可用或准备 create |
| A8 | agents.get | 取一个 code | ok |
| A9 | agents.create | 无合适角色时：`verify-content-ops` | **agentCode** |
| A10 | agents.update | 给验证角色加一句备注/tag | updated |
| A11 | employees.list | 列岗位 | — |
| A12 | employees.hire | 无岗位则雇 A9/A8 | status=active |
| A13 | employees.get | agentCode | ok |
| A14 | employees.update | 改展示名/备注（可还原） | ok |
| A15 | employees.pause | 暂停 | paused |
| A16 | employees.resume | 恢复 | active（后面要派活） |
| A17 | skills.list | 列技能 | ok |
| A18 | skills.get | 取一个 | ok |
| A19 | skills.enable | 对**非关键**技能做一次 false→true 还原，或 skip | 不破坏默认工具集 |
| A20 | mcp.get | 读 MCP | **mcpSnapshot** |
| A21 | mcp.set | **原样写回** mcpSnapshot（无害往返） | 与 get 一致 |
| — | settings.set_default_model / assets.update_profile / patch_web_search / create_model / delete_model | **skipped**：污染本机 | — |
| — | skills.install / skills.delete | **skipped**（或仅临时 skill 沙箱） | — |

`employees.stop`：放在派活前或清理前测一次「停当前轮」；若会影响 B 幕派活，则 B 后再测并 resume。

---

### Act B — 开单与派活（items / tasks / employees）

| 序 | API | 真实怎么做 | 产出/验收 |
|----|-----|------------|-----------|
| B1 | items.create | title=`[验证] AI工具提效短视频` | **itemId**, status=todo |
| B2 | items.get | itemId | 标题一致 |
| B3 | items.update | notes=`串联验收` | notes 更新 |
| B4 | items.list | q=`[验证]` | 含 itemId |
| B5 | items.dispatch | itemId + agentCode，**`wake_now=true`（强制真实唤醒）**；busy 可用 force/interrupt | **taskId**；进入独立 AI 等待 |
| B5b | tasks.execution_trail / employees.trail | 等派发任务终态后审**任务内工具步骤** | tool_steps>0；序列合理 |
| B6 | tasks.create | 另建一条同主题行政 Task | **taskId2** |
| B7 | tasks.get | taskId2（派发任务已在等待里 get 过） | ok |
| B8 | tasks.list | 过滤 | 含 taskId |
| B9 | tasks.set_state | 仅对 **taskId2** → executing | 状态变更 |
| B10 | employees.worklog | agentCode + 今天 | task_count 或 hint 可解释 |
| B11 | employees.stop | **必须在唤醒等待之后** | ok |
| B12 | employees.resume | 恢复值班 | active |

---

### Act C — 生产（workflow / AI 运行）

> **本幕是 AI 运行主路径**：与 Act B 的 CRUD 隔离。启动后进入**独立等待**，盯 `progress` + `trail`/`steps`，并审提示词/目标表述。

| 序 | API | 真实怎么做 | 产出/验收 |
|----|-----|------------|-----------|
| C1 | workflow.list | 搜 content/demo/短视频 | **appId**；没有→整幕 skipped/failed |
| C2 | workflow.get | 审 plan/steps 的 goal、description | schema ok；`prompt_ok`（空话/缺验收→concern 或 fail） |
| C3 | workflow.run | parameters 必填真实 theme/video_count 等 | **runId**（仅启动，不结案） |
| C4 | workflow.run_status | **单独轮询**至终态；打印 progress/步骤状态 | `final=… progress=…` |
| C4b | tasks.execution_trail | 审各子任务 session 的工具调用序列 | tool_steps>0；步骤合理 |
| C5 | workflow.stop | **仅超时仍在跑**时调用；已终态 → **skipped** | timeout-stop 须带最后 progress |

禁止 `wake_now=false`；禁止只看子任务 status 列表就算「轨迹通过」。

---

### Act D — 沉淀（knowledge / experience / memory / sessions）

| 序 | API | 真实怎么做 | 产出/验收 |
|----|-----|------------|-----------|
| D1 | knowledge.list | 选库 | **vaultId** |
| D2 | knowledge.create | 无合适库则建 `verify-content-ops` | vaultId |
| D3 | knowledge.enable | enabled=true | ok |
| D4 | knowledge.ingest | 正文含 item 标题 + run 摘要 | **notePath** |
| D5 | knowledge.notes | vaultId | 含新笔记 |
| D6 | knowledge.note_get | path | 关键词命中 |
| D7 | knowledge.search | `AI工具提效` | hits 相关 |
| D8 | experience.save | 引用 itemId/runId | **experienceId** |
| D9 | experience.get | id | ok |
| D10 | experience.list | query=验证 | 含该条 |
| D11 | memory.agents | 列 | ok |
| D12 | memory.get | main 或 agentCode | ok（空也算通） |
| D13 | sessions.search | `[验证]` 或短视频 | ok（无命中不 fail） |
| — | memory.clear / delete_fact | **skipped**（除非本轮可删测试事实） | — |

---

### Act E — 定时与审批（automation / approvals）

| 序 | API | 真实怎么做 | 产出/验收 |
|----|-----|------------|-----------|
| E1 | automation.create | name=`[验证]每日选题` cron=`0 10 * * *` | **automationId** |
| E2 | automation.get | id | 配置正确 |
| E3 | automation.update | 改 prompt 加「验证标记」 | updated |
| E4 | automation.list | — | 含 id |
| E5 | automation.history | id | ok（可空） |
| E6 | automation.set_status | **paused**（防真触发） | paused |
| E7 | approvals.list | — | ok |
| E8 | approvals.approve | 有 pending 才批 | 否则 skipped |
| E9 | approvals.reject | 另单或 skipped | 否则 skipped |

---

### Act F — 诊断（diagnostics）

| 序 | API | 真实怎么做 | 产出/验收 |
|----|-----|------------|-----------|
| F1 | diagnostics.sources | hours=24 | 列出源 |
| F2 | diagnostics.scan | hours=6 | 可解析；ERROR 写入 round.exceptions 摘要，不单凭有日志判业务失败 |
| F3 | diagnostics.timeline | format=both | 有 markdown |

---

### Act G — 清理（destructive，`cleanup=true` 时执行）

逆序，只删**本轮创建**的对象：

| 序 | API |
|----|-----|
| G1 | automation.delete |
| G2 | experience.delete |
| G3 | knowledge.note_delete |
| G4 | knowledge.enable false（自建库） |
| G5 | tasks.delete（taskId / taskId2） |
| G6 | items.delete |
| G7 | employees.archive（仅验证号） |
| G8 | agents.delete（仅验证号） |
| G9 | skills.delete（仅本轮 install 的临时包） |

---

## 全量核对表（78 业务 API，勿漏）

### knowledge（8）
create, enable, ingest, list, note_delete, note_get, notes, search → **全在 D/G**

### workflow（5）
get, list, run, run_status, stop → **全在 C**

### settings（11）
list_models, get_default_model, get_model, assets.get_profile, get_web_search, test_web_search → **A 执行**  
set_default_model, assets.update_profile, patch_web_search, create_model, delete_model → **A 显式 skipped**

### agents（5）
list, get, create, update → **A**；delete → **G**

### employees（9）
list, hire, get, update, pause, resume, stop, worklog → **A/B**；archive → **G**

### tasks（5）
create, get, list, set_state → **B**；delete → **G**

### items（6）
create, get, update, list, dispatch → **B**；delete → **G**

### skills（5）
list, get, enable → **A**；install/delete → **skip 或沙箱 G**

### mcp（2）
get → **A**；set → **A 原样回写**

### automation（7）
create, get, update, list, history, set_status → **E**；delete → **G**

### approvals（3）
list → **E**；approve/reject → **有单执行否则 skip**

### memory（4）
agents, get → **D**；clear, delete_fact → **skip（默认）**

### sessions（1）
search → **D**

### experience（4）
save, get, list → **D**；delete → **G**

### diagnostics（3）
sources, scan, timeline → **F**

### verification（9）
catalog, init, start, list, get, step, update, conclude, delete → **Act 0（账本）**

---

## ID 接力

```
model + agentCode
    → itemId → (dispatch) taskId
    → appId → runId
    → vaultId → notePath → search
    → experienceId
    → automationId → paused → delete
    → diagnostics + worklog + sessions.search
```

---

## 两档执行

| 档 | 范围 |
|----|------|
| **真实串联（推荐先跑）** | 上表全部「执行」行 + skip 行记 skipped；cleanup 可选 |
| **含破坏性收尾** | `cleanup=true` 跑完 Act G |

开轮：

```json
{
  "action": "verification.init",
  "args": {
    "title": "内容运营工作室一日-全量",
    "scenario": "full-chain-real",
    "confirm": true
  },
  "confirm": true
}
```

（不传 `domains` = seed 除 verification 外全部业务接口为待开始。）

---

## 结论模板

> round `svr_…` 故事「内容运营工作室一日」：业务 78 接口 — 通过 X / 失败 Y / 跳过 Z；ID 链 item=… task=… run=…；阻塞点：…
