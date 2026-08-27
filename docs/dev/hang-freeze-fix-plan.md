# EvoFlow 后台/挂屏卡死根因修复方案

> **版本**：v3-final
> **日期**：2026-08-11
> **方法论**：三条调用链逐行追踪（SSE 流生命周期 + SQLite 锁争用 + Proactive 调度死锁），
> 定位 3 个根因。v1 的 7 项修复作为防护层保留，本方案在其之上补齐根因级修复。

---

## 一、根因总结

### 三条级联故障链

```
级联1（用户感知最强）:
  用户切后台 → SSE断开 → cancel_on_disconnect=false → run继续跑
  → run完成但前端没收到最终帧 → 用户切回前台
  → tryReattach调getSessionRunStatus → 打的是/execution/state
  → 后端返回runStatus='done'但无recently_completed字段
  → 前端走 status.status==='idle' → return → 不刷新消息 → 永久卡死

级联2:
  proactive tick(60s) → 15-20次独立execute+commit → 每次持RLock 10-30ms
  → 累计150-600ms → 用户发消息INSERT等待RLock → busy_timeout不足
  → OperationalError → retry 8次指数退避 → 总延迟~10.65s

级联3:
  proactive超时 → cancel(wait=False) → LangGraph run可能没真停
  → 僵尸run占用worker池 → 新run排队 → 用户聊天也排队 → 卡死
  → zombie sweeper阈值600s+间隔120s = 最多12分钟才清理
```

### 根因与代码位置（逐行验证）

| # | 根因 | 代码位置 | 用户感知 |
|---|------|----------|----------|
| 1 | **SSE 断流后状态同步协议有盲区** | `ws-client.js` L77 `cancel_on_disconnect=false`<br>`events.py` L407 只查 `status=running`<br>`queries.py` L76-100 返回值无 `recently_completed`<br>`ws-client.js` L4630 `getSessionRunStatus` 不透传该字段 | 切后台回来永久卡在"等待中" |
| 2 | **SQLite 逐条 commit，锁窗口过大** | `db.py` L31 `_lock=threading.RLock()` 全局唯一<br>`repositories.py` L527-900 每个方法独立 `execute+commit`<br>单次 tick 15-20 次 commit，累计持锁 150-600ms | 发消息偶发延迟 0.5-5s |
| 3 | **僵尸 run 占用 worker 池** | `engine.py` L557 `cancel(wait=False)` 不保证终止<br>`run_status_reconcile.py` L35 阈值 600s<br>`engine.py` L497 `get_client()` 每次新建 | 僵尸存活期间用户聊天排队 |

### ⚠️ 之前修复中的致命缺陷

**R0-3 和 R2-2 的 `recently_completed`/`run_completed` 是死代码。**

| 前端实际调的 API | 后端处理函数 | 返回字段 | 问题 |
|-----------------|-------------|---------|------|
| `GET /api/chat/sessions/{key}/execution/state` | `build_session_execution_state()`<br>`queries.py` L51 | `runStatus`, `runId`, `executing` | **没有** `recently_completed` |
| ~~`GET /api/events/threads/{tid}/stream-status`~~ | `get_thread_stream_status()`<br>`events.py` L360 | `is_stream_active`, `recently_completed` ← 死代码 | **前端不调这个端点** |

**完整失败路径（逐行代码追踪）**：

```
1. 用户发消息 → SSE流开始 → 用户切后台 → EventSource断开
   [ws-client.js L77: cancel_on_disconnect=false → 后端不知道]

2. 后端 run 继续跑 → Run 完成
   [session_run_lifecycle_middleware.py L173: mark_session_ended_from_agent → DB run_status='done']
   [stream_middle_layer.py L988: _broadcast_run_ended → 但前端收不到]

3. 用户切回前台 → visibilitychange → tryReattach()
   [ChatApp.tsx L7426: tryReattach()]
   [ChatApp.tsx L7430: shouldManualRefreshResumeStream → 如果turnPhase非busy则return]
   [ChatApp.tsx L7434: wsClient.getSessionRunStatus(sk)]

4. getSessionRunStatus 打 /execution/state
   [ws-client.js L4634: fetchJson('/api/chat/sessions/{key}/execution/state')]
   [queries.py L59: _read_chat_session_run_row(key) → 读SQLite]
   [queries.py L64: run_status_raw = 'done']
   [queries.py L76-100: 返回 {runStatus:'done', runId:null, executing:false}]
   [ws-client.js L4639: status = 'done' → toLowerCase → 'done']
   [ws-client.js L4640-4645: return {threadId, run:null, runId:null, status:'done'}]
   ⚠️ 没有透传 recently_completed 字段！

5. 前端处理返回值
   [ChatApp.tsx L7436: if (status.recently_completed) → undefined → 跳过] ← 死代码！
   [ChatApp.tsx L7454: if (status.status === 'idle' || !status.runId) return]
   → status.status='done' 不等于'idle'，但 runId=null → !status.runId=true → return！

6. 前端什么都不做 → 消息列表不刷新 → 永久卡死
```

---

## 二、v1+v2 已完成的修复（保留，不回滚）

| 修复项 | 文件 | 状态 | 层级 |
|--------|------|------|------|
| SSE 帧队列上限 200 | `sse-frame-batch.js` | ✅ | 防护层 |
| ChatApp visibilitychange reattach | `ChatApp.tsx` | ✅ | 防护层 |
| Proactive 超时 cancel | `engine.py` | ✅ 已改 wait=True+5s | 根因层(R1-2) |
| SQLite 只读连接池 mode=ro | `db.py` | ✅ | 防护层 |
| GlobalAssistant visibility 暂停 | `GlobalAssistant.js` | ✅ | 防护层 |
| Zombie sweeper 120s+分批100 | `zombie_run_sweeper.py` | ✅ | 防护层 |
| Windows 时钟跳变检测 | `asyncio_windows.py`+`runner.py` | ✅ | 防护层 |
| Zombie 阈值 600s→180s+90s快通道 | `run_status_reconcile.py` | ✅ | 根因层(R0-1) |
| busy_timeout 5s→10s | `db.py` | ✅ | 根因层(R1-1) |
| cancel wait=True+5s超时 | `engine.py` | ✅ | 根因层(R1-2) |
| httpx 客户端复用 | `engine.py`+`execution_bridge.py`+`runner.py` | ✅ | 根因层(R1-3) |
| SSE 上游心跳检测 120s | `stream_middle_layer.py` | ✅ | 根因层(R2-1) |
| `_in_txn` 方法骨架 | `repositories.py` | ✅ 骨架已有 | 根因层(R0-2) |
| `mark_run_completed` + `check_run_completed` | `live_run_repositories.py`+`middleware` | ✅ | 根因层(R2-2) |

---

## 三、待修复项（3 项关键缺口）

### R0-3-FIX：修复 reattach 状态查询盲区（★ 最高优先级）→ ✅ 已完成

> **状态**：已落地。`queries.py` 的 `build_session_execution_state` 已返回
> `recently_completed` / `recently_completed_run_id` / `recently_completed_status`（60s 窗口）；
> `ws-client.js` `getSessionRunStatus` 已透传三字段；`ChatApp.tsx` visibility reattach 已消费并刷新消息。
> 测试 `test_session_execution.py` 已同步 schemaVersion=4 并补回归断言（8 passed）。

**问题**：`recently_completed` 加在了前端不调的 `/stream-status` 上，是死代码。
前端实际调的是 `/execution/state`（`queries.py` L51 `build_session_execution_state()`）。

**修复策略**：在 `build_session_execution_state()` 返回值中增加 `recently_completed` 字段，
并在 `ws-client.js` 的 `getSessionRunStatus()` 中透传。

**改动文件**：

| 文件 | 行号 | 改动 |
|------|------|------|
| `backend/.../session_execution/queries.py` | L76-100 | 返回 dict 增加 `recently_completed` + `recently_completed_run_id` |
| `evopanel/src/lib/ws-client.js` | L4630-4649 | `getSessionRunStatus` 透传 `recently_completed` 字段 |

**核心代码**：

```python
# queries.py - build_session_execution_state 返回值增加字段

# 在 return dict 中新增：
"recently_completed": _check_recently_completed(run_status_raw, turn_ended),
"recently_completed_run_id": run_id if _check_recently_completed(run_status_raw, turn_ended) else None,


def _check_recently_completed(run_status: str, turn_ended: str | None) -> bool:
    """run 在 60s 内从活跃变为终态 → 前端需刷新消息。"""
    if not turn_ended:
        return False
    if run_status in ("running", "pending"):
        return False
    try:
        from datetime import datetime, timezone
        dt = datetime.fromisoformat(turn_ended.replace("Z", "+00:00"))
        elapsed = (datetime.now(timezone.utc) - dt).total_seconds()
        return 0 <= elapsed <= 60
    except Exception:
        return False
```

```javascript
// ws-client.js - getSessionRunStatus 透传字段
async getSessionRunStatus(sessionKey) {
    const data = await fetchJson(`/api/chat/sessions/${encodeURIComponent(key)}/execution/state`)
    // ...existing logic...
    return {
        threadId: ...,
        run: null,
        runId,
        status,
        recently_completed: !!data?.recently_completed,
        recently_completed_run_id: data?.recently_completed_run_id || null,
    }
}
```

**前端 ChatApp.tsx**：已有 `if (status.recently_completed)` 分支（L7436），端点修好后自动生效。

**风险评估**：低。`_check_recently_completed` 是纯读操作，不影响现有逻辑。

**验收标准**：切后台 → 等 run 完成 → 切回前台，消息列表自动刷新。

---

### R0-2-FIX：think() 中实际使用 _in_txn 批量提交

**问题**：subagent 在 `repositories.py` 中加了 5 个 `_in_txn` 方法，但 `engine.py` 的 `think()` **没有调用它们来合并事务**。每次 tick 仍然是 15-20 次独立 commit。

**修复策略**：在 `engine.py` 的 `think()` 方法中，将 think 结果写入操作收集起来，用一次 `run_db_transaction` 批量提交。

**改动文件**：

| 文件 | 行号 | 改动 |
|------|------|------|
| `backend/.../proactive/engine.py` | think() 结果写入段（~L320-345, L560） | 用 `run_db_transaction` 包裹所有写入 |

**核心代码**：

```python
# engine.py - think 结果批量提交

def _persist_think_results(self, role, round_id, result):
    """将 think 产出的所有写操作合并为一次事务提交。"""
    from evoflow.persistence.db import run_db_transaction
    from evoflow.proactive.repositories import (
        ProactiveRepository, ProactiveMemoryRepository, ProactiveCostRepository
    )

    def _batch(db):
        # 1. heartbeat
        ProactiveRepository.update_heartbeat_in_txn(
            db, role.agent_code,
            last_heartbeat_at=utc_now_iso_z(),
            next_heartbeat_at=result.next_heartbeat_at,
        )
        # 2. initiatives
        for init in result.initiatives:
            ProactiveRepository.save_initiative_in_txn(db, init)
        # 3. memory
        if result.memory_text:
            ProactiveMemoryRepository.update_after_think_in_txn(
                db, role.agent_code, ...
            )
        # 4. cost log
        if result.cost:
            self._log_round_cost(role, round_id, ..., db=db)  # 已支持db参数

    run_db_transaction(_batch)
    # 15-20 次 commit → 1 次 commit，锁窗口缩减 ~90%
```

**注意事项**：
- `think()` 中写操作分散在 L320-345（memory 更新）和 L560（cost log），需要提取到统一方法
- `_log_round_cost` 已支持 `db` 参数（subagent 已改），在 `_batch` 内传入即可
- 需要确认 `save_initiative` 在 think 流程中的调用点，提取到 `_batch` 中

**验收标准**：单次 proactive tick 的 commit 次数从 15-20 降到 ≤2。

---

### R2-2-FIX：run_completed 也需要加到 /execution/state

**问题**：subagent 在 `live_run_repositories.py` 中加了 `mark_run_completed` / `check_run_completed`，在 `events.py` 的 `/stream-status` 中加了 `run_completed` 字段。但前端不调 `/stream-status`，调的是 `/execution/state`。

**修复策略**：在 `build_session_execution_state()` 中也查询 `check_run_completed`，作为 R0-3 的双保险。

**改动文件**：

| 文件 | 行号 | 改动 |
|------|------|------|
| `backend/.../session_execution/queries.py` | L76-100 | 返回 dict 增加 `run_completed` + `run_completed_run_id` |

**核心代码**：

```python
# queries.py - build_session_execution_state 增加 run_completed 查询

# 在返回 dict 中新增：
"run_completed": _check_db_run_completed(thread_id),
"run_completed_run_id": None,  # 由 _check_db_run_completed 填充


def _check_db_run_completed(thread_id: str) -> bool:
    """DB 持久化补偿：检查 live_runs 表是否有 completed 标记。"""
    if not thread_id:
        return False
    try:
        from evoflow.persistence.live_run_repositories import check_run_completed
        result = check_run_completed(thread_id)
        return bool(result)
    except Exception:
        return False
```

**风险评估**：低。作为 R0-3 的补充保障，即使 `current_turn_ended_at` 未被正确写入，DB 标记也能兜底。

---

## 四、完整修复清单（按优先级）

### R0 - 立即修复（根因级）

| 序号 | 修复项 | 改动文件 | 状态 | 工时 |
|------|--------|----------|------|------|
| R0-1 | zombie 阈值 600→180 + 90s 快通道 | `run_status_reconcile.py` | ✅ 已完成 | - |
| R0-2 | proactive 写操作批量提交 | `repositories.py` ✅骨架 + `engine.py` ❌待接 | **部分完成** | 2h |
| **R0-3-FIX** | **修复 reattach 状态查询盲区** | `queries.py` + `ws-client.js` | **✅ 已完成** | 1h |

### R1 - 短期优化

| 序号 | 修复项 | 改动文件 | 状态 | 工时 |
|------|--------|----------|------|------|
| R1-1 | busy_timeout 5s→10s | `db.py` | ✅ 已完成 | - |
| R1-2 | cancel wait=True + 5s 超时 | `engine.py` | ✅ 已完成 | - |
| R1-3 | httpx 客户端复用 | `engine.py`+`execution_bridge.py`+`runner.py` | ✅ 已完成 | - |

### R2 - 中期改进

| 序号 | 修复项 | 改动文件 | 状态 | 工时 |
|------|--------|----------|------|------|
| R2-1 | SSE 上游心跳 120s | `stream_middle_layer.py` | ✅ 已完成 | - |
| R2-2 | 最终帧持久化补偿 | `live_run_repositories.py`+`middleware` ✅ + `queries.py` ❌待接 | **部分完成** | 0.5h |

---

## 五、实施顺序

### 第一步：R0-3-FIX（1h，最高优先级）

这是用户感知最强的卡死场景。修复后"切后台回来永久卡死"问题直接消除。

1. `queries.py` L76-100：返回值增加 `recently_completed` + `recently_completed_run_id`
2. `queries.py` 新增 `_check_recently_completed()` 辅助函数
3. `ws-client.js` L4640-4645：`getSessionRunStatus` 透传 `recently_completed` 字段
4. `ChatApp.tsx` L7436：已有处理逻辑，无需改

### 第二步：R0-2-FIX（2h）

消除 proactive tick 期间的 SQLite 锁争用。

1. 读取 `engine.py` think() 完整流程，定位所有写操作调用点
2. 提取到 `_persist_think_results()` 方法，用 `run_db_transaction` 包裹
3. 确保所有 `_in_txn` 方法不自行 commit

### 第三步：R2-2-FIX（0.5h）

DB 持久化补偿，作为 R0-3 的双保险。

1. `queries.py` 返回值增加 `run_completed` 字段
2. 新增 `_check_db_run_completed()` 辅助函数

---

## 六、验收测试

| 场景 | 预期行为 | 验证方法 |
|------|----------|----------|
| 切后台 30s 后切回 | 消息列表自动刷新，无卡死 | 手动测试 + 检查 `execution/state` 返回 `recently_completed` |
| 切后台期间 run 完成 | 切回后看到完整结果 | 手动测试 |
| Proactive tick 期间发消息 | 延迟 <100ms | 日志统计 commit 次数 |
| Proactive 超时后 | run 在 5s 内被 cancel | 检查 LangGraph runs 列表 |
| 僵尸 run 存活时间 | ≤5 分钟被清理 | zombie sweeper 日志 |
| 连续 10 次 proactive tick | httpx 连接数不增长 | `netstat` 监控 |

---

## 七、附录：关键代码位置速查

| 根因 | 文件 | 行号 | 关键标识 |
|------|------|------|----------|
| ★ 前端调的 API | `evopanel/src/lib/ws-client.js` | L4634 | `/execution/state` |
| ★ 后端处理函数 | `backend/.../session_execution/queries.py` | L51 | `build_session_execution_state` |
| ★ 返回值无 recently_completed | `backend/.../session_execution/queries.py` | L76-100 | return dict |
| 前端 reattach 逻辑 | `evopanel/src/react/ChatApp.tsx` | L7426 | `tryReattach()` |
| 前端 recently_completed 处理 | `evopanel/src/react/ChatApp.tsx` | L7436 | `if (status.recently_completed)` |
| cancel_on_disconnect=false | `evopanel/src/lib/ws-client.js` | L77 | `cancel_on_disconnect=false` |
| 只查 running 状态 | `backend/app/gateway/routers/events.py` | L407 | `status=running` |
| after_agent 标记 ended | `backend/.../session_run_lifecycle_middleware.py` | L173 | `mark_session_ended_from_agent` |
| 全局 RLock | `backend/.../persistence/db.py` | L31 | `_lock = threading.RLock()` |
| busy_timeout | `backend/.../persistence/db.py` | L38 | `_DEFAULT_BUSY_TIMEOUT_MS` |
| run_db_transaction | `backend/.../persistence/db.py` | ~L220 | `def run_db_transaction` |
| 逐条 commit | `backend/.../proactive/repositories.py` | L527-900 | `get_db().commit()` |
| _in_txn 方法（已有骨架） | `backend/.../proactive/repositories.py` | L452,551,819,846,897 | `*_in_txn` |
| cancel | `backend/.../proactive/engine.py` | L557 | `client.runs.cancel` |
| get_client 每次新建 | `backend/.../proactive/engine.py` | L497 | `get_client(url=...)` |
| zombie 阈值 | `backend/app/gateway/run_status_reconcile.py` | L35 | `_STARTUP_STALE_RUN_MAX_AGE_S` |
| zombie 间隔 | `backend/app/gateway/zombie_run_sweeper.py` | L19 | `_DEFAULT_INTERVAL_S` |
| mark_run_completed | `backend/.../persistence/live_run_repositories.py` | subagent新增 | `mark_run_completed` |
| SSE 上游心跳 | `backend/app/gateway/streaming/stream_middle_layer.py` | L49-53 | `_UPSTREAM_SILENCE_TIMEOUT_S` |
