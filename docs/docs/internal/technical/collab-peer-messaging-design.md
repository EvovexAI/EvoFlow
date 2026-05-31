# Collab 子任务私线通信（Peer Messaging）设计

> **范围**：仅 **通用 subagent / `task_tool`** 协作路径；**不包含** Claude/ACP `continue_subtask_session`。  
> **状态**：P0 已实现（v0.3）  
> **版本**：v0.3 — 2026-05-29（问询：进行中↔进行中、进行中→已完成；已完成不可发问）

---

## 1. 背景与目标

### 1.1 问题

当前协作模型是 **星型主控**：

- 子 agent **不能**调用 `supervisor`，也不能互相「群聊」。
- 跨工种临时问答只能：`subtask_outcome_report(blocked)` → Lead 中转 → `retry_subtask` / `continue_subtask_session`（后者本设计排除）。

用户需要：

1. **前端问开发、测试问开发、主控问开发** — 各自 **一条私线**，互不偷看。
2. **开发**只有一个 subtask 工人身份，靠 **存储续上下文**，每轮 `task_tool` 是短回合。
3. **公线交接**仍由 `subtask_outcome_report` → `task_report` + DAG 负责；私线不等于完成。

### 1.2 非目标（P0）

- 不做项目群聊频道。
- 不做 Claude/ACP 会话续聊。
- 不让 peer 消息替代 `task_report` 或解锁 DAG。
- 不做子 agent 之间任意广播。

### 1.3 设计原则

| 原则 | 说明 |
|------|------|
| **分线存储** | 线程键 `(from_party, to_subtask_id)`，禁止跨线注入 prompt |
| **短回合唤醒** | 每条私线触发目标 subtask 的独立 `task_tool` 回合 |
| **ACL** | 仅 `from`、`to`、Lead 可读；UI 按身份过滤 |
| **审计** | 全量落库 + SSE；可进 `execution_conversation` 镜像（带 `peer_thread_id`） |
| **问询方向** | **进行中→进行中**、**进行中→已完成** 均可；**已完成**不得再 `peer_send`；对 completed 的回复为咨询回合，不改终态 |

---

## 2. 架构模式

### 2.1 模式名：**Private Edge Threads over Storage（存储私线）**

```
                    ┌──────── Lead (__lead__) ────┐
                    │                             │
  前端 subtask ─────┼── thread(fe→dev) ──────────┼──► 开发 subtask
  测试 subtask ─────┼── thread(qa→dev) ──────────┘      (同一工人，多私线)
                    │
         公线 handoff: dev.task_report ──DAG──► 前端 (depends_on)
```

- **私线**：问答、协调、临时缺信息。
- **公线**：正式交付、`depends_on` 下游只读 `get_subtask_task_report()`。

### 2.2 与现有组件关系

```
collab_peer_send (worker tool)
    → peer_repository.append_message
    → peer_scheduler.schedule_wake(to_subtask, thread_key)
        → detached_poll_scheduler
        → collab_bridge.delegate_via_task_tool(..., peer_wake=...)
            → task_tool (新回合)
                → _build_subtask_enriched_prompt()
                → _build_peer_wake_prompt_block(thread_key ONLY)
```

Lead 侧复用同一存储，`from_party = "__lead__"`，通过 `supervisor` 新 action 或现有 `agent_message` 扩展（见 §5.3）。

---

## 3. 数据模型

### 3.1 身份与线程键

```text
from_party : subtask_id | "__lead__"
to_subtask_id : subtask_id
thread_key   : "{from_party}->{to_subtask_id}"   # 主键逻辑，存表时拆列
```

解析 `to` 时支持：`subtask_id` | `ref`（"1","2"）| 唯一 `name`（与 dependency 相同规则）。

### 3.2 表：`evoflow_collab_peer_messages`

**新表**（schema migration v29+），消息为 append-only。

```sql
CREATE TABLE evoflow_collab_peer_messages (
    message_id       TEXT NOT NULL PRIMARY KEY,
    main_task_id     TEXT NOT NULL,
    thread_key       TEXT NOT NULL,          -- 冗余，便于查询
    from_party       TEXT NOT NULL,          -- subtask_id or __lead__
    to_subtask_id    TEXT NOT NULL,
    direction        TEXT NOT NULL DEFAULT 'question',
        -- question | reply | system
    body             TEXT NOT NULL,
    in_reply_to      TEXT,                   -- message_id, nullable
    status           TEXT NOT NULL DEFAULT 'pending',
        -- pending | delivered | answered | expired | cancelled
    visibility_json  TEXT NOT NULL DEFAULT '[]',
        -- 默认 ["from_party","to_subtask_id","__lead__"]，冗余 ACL 快照
    wake_scheduled   INTEGER NOT NULL DEFAULT 0,
    wake_round_id    TEXT,
    created_at       TEXT NOT NULL,
    answered_at      TEXT,
    expires_at       TEXT,
    extra_json       TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX idx_collab_peer_msg_main_thread
    ON evoflow_collab_peer_messages(main_task_id, thread_key, created_at);
CREATE INDEX idx_collab_peer_msg_to_pending
    ON evoflow_collab_peer_messages(main_task_id, to_subtask_id, status);
```

**删除策略**：随 `main_task_id` 级联删除（与现有 collab 表一致，`task_repositories.delete_collab_bundle`）。

### 3.3 子任务行扩展（`extra_json` / 内存 dict）

不新增 subtask 表列；在 subtask `extra_json` 增加可选字段：

```json
{
  "peer_state": {
    "outbound_pending": 1,
    "inbound_pending": 0,
    "last_peer_activity_at": "2026-05-29T12:00:00Z"
  }
}
```

**可选 UI 状态**（不替代 `status`）：

- 发问方等待回复：subtask `status` 保持 `executing`，`peer_state.outbound_pending > 0`。
- 或显式 `status=blocked` + `error=waiting_peer:{thread_key}`（P0 用 `peer_state` 即可，少改 DAG）。

### 3.4 `execution_conversation` 镜像（可选 P1）

追加一条结构化行，便于主会话审计：

```json
{
  "role": "peer",
  "collab_subtask_id": "<to_subtask_id>",
  "peer_thread_key": "Subtask_qa->Subtask_dev",
  "peer_message_id": "...",
  "content": "..."
}
```

**不**把 peer 内容混入其他 subtask 的 stream 镜像。

### 3.5 与 `task_report` / DAG

| 数据 | 用途 | 谁可读 |
|------|------|--------|
| `peer_messages` | 私线问答 | from, to, Lead |
| `task_report` | 正式交接 | DAG 下游、侧栏 outcome |
| `execution_conversation` | 工人执行审计 | Lead、本 subtask 回合 |

---

## 4. ACL 与隔离

### 4.1 读权限

```python
def can_read_peer_thread(*, reader: str, from_party: str, to_subtask_id: str) -> bool:
    # reader: subtask_id | "__lead__" | gateway user (lead session)
    if reader == "__lead__":
        return True
    if reader == from_party or reader == to_subtask_id:
        return True
    return False
```

### 4.2 Prompt 注入规则（**关键**）

唤醒 `to_subtask_id` 时，**仅**注入：

```text
thread_key == current_wake_thread_key
```

的最近 `N=20` 条消息（question + reply），加上固定指令块：

```text
[Peer thread: {from_party} → you]
...messages...
Instruction: 这是来自 {from_display_name} 的私线协作。请用 collab_peer_reply 回复。
不要假设你能看到其他角色与本任务的私线内容。
```

**禁止**：

- 注入 `fe->dev` 当唤醒原因是 `qa->dev`。
- 把全 main_task peer 历史塞进 prompt。

### 4.3 发问方读回复

`collab_peer_read` 只返回 **以本 subtask 为 `from_party` 或 `to_subtask_id`** 的线程；按 `thread_key` 分组。

---

## 5. 工具设计

### 5.1 工人工具（加入 `_COLLAB_SUBTASK_MANDATORY_TOOLS` 或 `worker_profile` 默认推荐集）

#### `collab_peer_send`

```text
collab_peer_send(
  to_subtask: str,           # id | ref | unique name
  message: str,
  main_task_id?: str,
  from_subtask_id?: str,     # runtime 默认当前 collab_subtask_id
  expect_reply: bool = true
) -> JSON
```

**行为**：

1. 校验：from 为当前 runtime subtask；to 存在且 ≠ from。
2. 校验 **发问方（from）**：
   - `cancelled` → 拒绝。
   - `completed` 且已有 `outcome_reported_at` → **拒绝**（已完成子任务不再向外询问；若需协调由 Lead `peer_send` 或 `retry_subtask`）。
   - `executing` / `pending` / `blocked` / `failed` 等未正式交卷态 → 允许发问。
3. 校验 **接收方（to）**：
   - `cancelled` → 拒绝。
   - `completed` + `outcome_reported_at` → **允许接收**（唤醒为 **咨询模式**，见 §7.2）。
   - `executing` / `pending` / `blocked` / `failed` 等同样未交卷 → **允许接收**（唤醒为 **协作模式**：可 `peer_reply` 并继续本 subtask 工作，见 §7.2）。
4. 写入 `question` 消息 `status=pending`。
5. `peer_state.outbound_pending++`（from 侧）。
6. `schedule_wake(to, thread_key, reason=peer_question, mode=consultation|collaboration)`（to 已 completed → consultation，否则 collaboration）。
7. SSE `collab:peer_message`.
8. 返回 `{ ok, messageId, threadKey }`。

**限制**：每 subtask 同时 `pending` 出站 ≤ 3；`message` ≤ 4000 字符。

#### `collab_peer_reply`

```text
collab_peer_reply(
  in_reply_to: str,         # message_id
  message: str,
  main_task_id?: str,
  subtask_id?: str           # 当前工人（必须是 to 方）
) -> JSON
```

**行为**：

1. 校验：当前 subtask == 原消息的 `to_subtask_id`。
2. 写入 `reply`，原 question 标 `answered`。
3. `schedule_wake(from_party, thread_key, reason=peer_reply)` — 若 from 是 `__lead__` 则只 SSE 不唤醒。
4. SSE `collab:peer_reply`.

#### `collab_peer_read`

```text
collab_peer_read(
  thread_key?: str,         # 省略 = 本 subtask 相关全部线程
  since_message_id?: str,
  limit: int = 20
) -> JSON
```

返回 ACL 过滤后的线程列表。**不**触发唤醒。

### 5.2 唤醒专用（内部，非 LLM 工具）

#### `wake_collab_subtask_for_peer`

```python
async def wake_collab_subtask_for_peer(
    *,
    main_task_id: str,
    to_subtask_id: str,
    thread_key: str,
    trigger_message_id: str,
    reason: Literal["peer_question", "peer_reply"],
) -> None:
    ...
```

- 走 `detached_poll_scheduler` → `delegate_via_task_tool`.
- Runtime 注入：`peer_wake={ thread_key, trigger_message_id, reason }`.
- 若目标 `in_flight`（background_task RUNNING）：队列化 wake（`extra_json.peer_wake_queue`），当前回合结束后消费。

### 5.3 Lead / Supervisor 扩展

**方案（推荐）**：`supervisor` 新 action `peer_send`：

```text
supervisor(
  action=peer_send,
  task_id=...,
  subtask_id=...,      # to
  agent_message=...    # body
)
```

- 写入 `from_party=__lead__`。
- 唤醒逻辑与工人 `collab_peer_send` 相同。
- `get_status` / `list_subtasks` 增加 `peerSummary`：`{ inboundPending, outboundPending, threads: [...] }`（Lead 全量）。

**不**给 Lead 单独开 worker 工具；统一走 supervisor。

### 5.4 工具白名单

```python
_COLLAB_SUBTASK_MANDATORY_TOOLS = (
    "subtask_work_checklist",
    "subtask_outcome_report",
    "collab_peer_send",
    "collab_peer_read",
    "collab_peer_reply",
)
```

仍禁止：`supervisor`, `plan`, `task`（防递归委派）, `ask_clarification`。

---

## 6. 唤醒回合 Prompt 组装

在 `_build_subtask_enriched_prompt()` 之后追加（仅当 `runtime.peer_wake` 存在）：

```text
## 私线协作（本轮触发）

你被唤醒以处理来自 **{from_display}** 的消息（线程 `{thread_key}`）。
请用 `collab_peer_reply` 回答。

{若 to 方仍是 executing 等未交卷态：}
**协作模式**：对方也在执行中。请用 `collab_peer_reply` 回答；若问题涉及本 subtask 职责内的约定/接口，可在回复中说明，必要时边答边继续本 subtask 工作。
仍须遵守私线隔离；不要替对方 subtask 调用 `subtask_outcome_report`。

{若 to 方已是 completed：}
**咨询模式**：你本 subtask 已正式完成。仅根据既有 `task_report`、工作区与问题作答；
**不要**修改代码、不要再次调用 `subtask_outcome_report`、不要发起新的 `collab_peer_send`。
若对方需要实质性改动，在回复中说明「需 Lead 对开发子任务执行 retry_subtask」。

{format_peer_thread_block(thread_key, limit=20)}
```

**正常 DAG 委派**（`start_execution`）**不**带 peer 块，除非显式 `include_peer_unread=false`（默认不带）。

---

## 7. 状态机与 DAG 交互

### 7.1 子任务 status（不新增枚举 P0）

| 场景 | status | 说明 |
|------|--------|------|
| 私线问答中 | `executing` | 默认 |
| 等对方回复 | `executing` + `peer_state.outbound_pending` | 侧栏可展示「等待回复」 |
| 正式完成 | `completed` + `outcome_reported_at` | 仅 `subtask_outcome_report` |
| 私线无法解决 | `blocked` | 仍可用，Lead 介入 |

### 7.2 子任务状态与 peer（已定稿）

| 发问方 from | 接收方 to | 是否允许 | 接收方 wake 模式 |
|-------------|-----------|----------|------------------|
| **进行中**（未 outcome） | **进行中**（未 outcome） | ✅ | **协作模式**：`peer_reply` + 可继续本 subtask 工作 |
| **进行中** | **已完成**（已 outcome） | ✅ | **咨询模式**：仅 `peer_reply`，不改终态 |
| **已完成** | 任意 | ❌ | — |
| **Lead** | 任意非 cancelled | ✅ | 同工人规则（to 已完成→咨询，to 进行中→协作） |

说明：

- **进行中→进行中**：典型并行场景（前端与后端同时执行），前端可先问「字段是否已定」；后端答完继续写 API。双方私线仍隔离（`fe→be` 与 `qa→be` 互不可见）。
- **进行中→已完成**：开发已交卷，前端/测试临时追问细节；开发只答不改。
- **已完成不再发问**：业务已结束；协调由 Lead 或对方主动来问。

协作模式下，接收方回复后 **不** 自动改变双方 `status`；各自仍须在本 subtask 收尾时自行 `subtask_outcome_report`。

实质性返工（已 completed 的要改代码）仍走 **`retry_subtask`**，不用 peer 重开终态。

### 7.3 DAG

- `is_upstream_subtask_dependency_met` **不变**。
- Peer **不**触发 `auto_delegate_collab_followup_wave`（仅 outcome success 触发）。

---

## 8. 调度、并发与可靠性

### 8.1 并发

| 情况 | 处理 |
|------|------|
| 目标已在跑 `task_tool` | peer wake 入队 `peer_wake_queue` |
| 同 thread 30s 内多次 send | debounce 合并为一次 wake |
| 发问方同时 4 条 pending | 拒绝第 4 条 |

### 8.2 超时

- `pending` question 超过 **30 分钟** → `expired`；SSE 通知发问方；Lead `monitor` 可见。
- 发问方 `collab_peer_read` 可见 `expired`，可重发。

### 8.3 失败

- wake 委派失败：消息标 `delivered` 但 `wake_error` 写入 `extra_json`；Lead monitor 推荐 `retry_subtask(to)`。

---

## 9. 事件与 API

### 9.1 SSE

| 事件 | 载荷 |
|------|------|
| `collab:peer_message` | `main_task_id`, `thread_key`, `message_id`, `from_party`, `to_subtask_id` |
| `collab:peer_reply` | 同上 + `in_reply_to` |

### 9.2 Gateway REST（P1 UI）

```http
GET /api/tasks/{main_task_id}/peer-threads
    ?viewer=lead|{subtask_id}
```

返回 ACL 过滤后的线程与消息（侧栏「协作私线」Tab）。

---

## 10. 模块划分（实现清单）

```text
evoflow/collab/peer/
  __init__.py
  models.py              # PeerMessage, PeerWakeRequest dataclasses
  thread_key.py          # build/parse thread_key, resolve to_subtask
  repository.py          # CRUD, ACL list, pending counts
  scheduler.py           # schedule_wake, debounce, queue
  prompt.py              # format_peer_thread_block
  wake.py                # wake_collab_subtask_for_peer

evoflow/tools/builtins/
  collab_peer_send_tool.py
  collab_peer_read_tool.py
  collab_peer_reply_tool.py

evoflow/persistence/
  schema_migration_v29.py
  peer_repositories.py

修改点：
  task_tool.py           # peer_wake runtime → prompt; mandatory tools
  execution.py           # _build_subtask_enriched_prompt + peer block
  supervisor_tool.py     # action=peer_send; get_status peerSummary
  task_repositories.py   # cascade delete peer messages
  sse_notify.py          # peer events
```

---

## 11. 典型流程

### 11.1 测试问开发

```text
1. 测试 worker: collab_peer_send(to="dev", message="登录 401 如何复现？")
2. repo 写入 thread(qa→dev)
3. scheduler wake(dev, thread_key=qa→dev)
4. 开发 worker 回合: prompt 仅含 qa→dev 历史
5. 开发: collab_peer_reply(in_reply_to=..., message="需要 Authorization: Bearer ...")
6. scheduler wake(qa, thread_key=qa→dev)
7. 测试: collab_peer_read() 看到回复，继续写用例
8. 测试完成: subtask_outcome_report(failed|completed, ...)
```

前端 **看不到** 步骤 1–7 的 qa→dev 内容。

### 11.2 进行中前端问进行中后端（并行）

```text
1. 前后端均已 start_execution，均未 outcome
2. 前端: collab_peer_send(to="backend", message="列表接口 path 和分页字段定了吗？")
3. 后端 wake（协作模式）: collab_peer_reply(...); 继续实现 API
4. 前端 peer_read 后继续做页面；互不阻塞对方 subtask 终态
```

### 11.3 进行中前端问已完成开发

```text
1. 开发已 subtask_outcome_report(completed)，DAG 已满足
2. 前端(executing): collab_peer_send(to="dev", message="users 接口分页参数？")
3. 开发 wake（consultation 模式）: 仅 collab_peer_reply，不改代码、不 outcome
4. 前端 collab_peer_read 拿到回复后继续页面工作
5. 前端完成后自行 subtask_outcome_report(completed)
```

开发 **不能** 再 `collab_peer_send` 问前端；若发现前端理解错了，回复里说明，或等 Lead 协调。

### 11.4 主控问开发

```text
supervisor(peer_send, subtask_id=dev, agent_message="测试失败日志：...")
→ from_party=__lead__
→ 开发 wake；回复后 SSE 通知 Lead，不唤醒其他 subtask
```

---

## 12. 测试计划

| 用例 | 断言 |
|------|------|
| fe→dev 与 qa→dev 各一条线 | dev wake prompt 不含另一条线 |
| fe peer_read | 只见 fe↔dev |
| qa peer_read | 只见 qa↔dev |
| Lead list | 见全部 |
| **进行中 fe → 进行中 be** | 允许；协作模式 |
| **进行中 fe → 已完成 dev** | 允许；dev 咨询模式仅 reply |
| **已完成 dev → peer_send** | 拒绝 |
| pending 超 30min | expired |
| in_flight wake | 入队后消费 |
| peer 不触发 follow-up wave | DAG 不变 |
| outcome 仍解锁下游 | 与现网一致 |

---

## 13. 分阶段交付

| 阶段 | 内容 |
|------|------|
| **P0** | 表 + repository + 三工人工具 + wake + prompt 隔离 + supervisor `peer_send` + SSE |
| **P1** | Gateway peer-threads API + 侧栏 UI + execution_conversation 镜像 |
| **P2** | Lead monitor 推荐、expired 自动策略、咨询回合工具白名单收紧 |

---

## 14. 已定决策

1. **进行中↔进行中**、**进行中→已完成** 均可 `peer_send`；**已完成**工人不再对外 `peer_send`（Lead 除外）。
2. 对已完成方的 wake 为 **咨询回合**：只 `collab_peer_reply`，终态与 DAG 不变。
3. 实质性返工走 **`retry_subtask`**，不用 peer 重开 completed。
4. Peer **不**写入 task memory；`to_subtask` 解析与 DAG `ref` 规则共用。

---

## 15. 评审检查表

- [ ] 私线隔离：prompt 与 read API 双端校验
- [ ] 不影响 `subtask_outcome_report` / DAG / follow-up
- [ ] 进行中可互问；已完成不可发问；对 completed 仅咨询回合
- [ ] 咨询回合不改 completed / outcome / DAG
- [ ] 仅 task_tool 路径，无 Claude/ACP 分支
- [ ] Lead 可审计、工人不可横向偷看
- [ ] 表结构可随 main_task 删除级联

**评审通过后按 §10 模块顺序开发 P0。**
