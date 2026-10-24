# Workflow crash / node-break resume

Status: **P0+P1 landed** — reconciler + API / platform / CLI.  
Depends on: [workflow-exec-hardening.md](./workflow-exec-hardening.md) (C0–C7 Runtime / Scheduler / Step Runner).

### Shipped surfaces

| Surface | Entry |
|---------|--------|
| Module | `evoflow.collab.workflow_reconciler` + `runner_epoch` |
| Boot/tick | `app.gateway.workflow_reconcile_runner` (`EVOFLOW_WORKFLOW_RECONCILE=0` to disable) |
| HTTP | `POST /api/apps/runs/{run_id}/recover`, `POST /api/tasks/{task_id}/recover` |
| Platform | `workflow.recover` (`runId` \| `taskId`) |
| CLI | `evoflow workflow recover <run_id>` / `--task-id` |

## Problem

用户期望：

1. 某个节点失败或卡死 → 能从**该节点**再跑，成功后下游继续。
2. Gateway / 进程重启 → 不丢上下文，从库里读状态，**接着派发**，而不是整单重开。

共识（产品侧）：

- **内存里的 monitor / detached poll 可以丢**。进程重启后重建即可。
- **上下文不丢**：主任务、子任务 DAG、`done` outcome、handoff、`evoflow_app_runs` 已在 DB / project storage。
- 续跑是 **「按库状态再驱动一轮 Scheduler」**，不是「恢复 Python 协程」。

## What already exists (reuse)

| Piece | Role |
|-------|------|
| Project storage + task bundle | Subtask status / depends_on / outcome SSOT |
| `evoflow_app_runs` + `app_run_events` | Run mirror (write-path) |
| `workflow_runtime.start / continue_after_step / retry_wave / dispatch_for_task` | DAG entry |
| `workflow_scheduler.advance_dag` | Claim runnable wave |
| `step_runner.run_steps` | Claim + delegate |
| `resume_run` | Only `paused` / `interrupted` → pending → `start` |
| Monitor auto-retry | Failed → pending (cap) then `retry_wave` |
| `task_reclaim` | Day-scale zombie → pause / complete (too slow for crash) |

Gap: **no boot / short-TTL reconciler** that turns “dead `executing` after restart” into a clean `retry_wave` / `start` using only DB state.

## Design principles

1. **DB is the scheduler input** — every recover pass is: load run → classify rows → mutate status (state machine) → `advance_dag`.
2. **Idempotent recover** — same pass twice must not double-delegate healthy workers (claim + lease / `background_active` already guard).
3. **Do not wipe the DAG** — unattended full requeue that clears all subtasks is out of scope for crash resume.
4. **Completed + outcome stays completed** — never re-run success nodes; only unlock dependents via followup.
5. **Failed node = retry that node**, not skip (unless product later adds explicit skip). Soft-blocked dependents stay waiting.
6. **Memory monitors optional** — after recover schedules `run_steps`, existing monitor can re-attach; if not, next reconciler tick covers stalls.

## Architecture

```
                    ┌─────────────────────────────────────┐
                    │  Persistence (already)               │
                    │  task bundle / subtasks / outcomes   │
                    │  evoflow_app_runs                    │
                    └─────────────────┬───────────────────┘
                                      │ read
                                      ▼
┌──────────────┐   tick/boot    ┌─────────────────────────┐
│ Gateway boot │───────────────►│ WorkflowReconciler      │
│ + interval   │                │ (NEW, collab/)          │
└──────────────┘                │  scan → classify → heal │
                                └───────────┬─────────────┘
                                            │ status fixes
                                            │ (state machine)
                                            ▼
                                ┌─────────────────────────┐
                                │ workflow_runtime        │
                                │  start / retry_wave     │
                                │  continue_after_step    │
                                └───────────┬─────────────┘
                                            ▼
                                workflow_scheduler → step_runner
```

**Do not** invent a second dispatcher. Reconciler only **normalizes DB rows**, then calls existing Runtime APIs.

## Subtask classification (per run)

For each non-terminal App / workflow-bound main task (and its `app_run` if linked):

| Row state | Meaning after process death | Heal action |
|-----------|----------------------------|-------------|
| `completed` + outcome | Done | Keep; may unlock dependents via followup |
| `failed` / `timed_out` / `error` | Failed node | If under retry budget → `pending` + count++; else leave failed (downstream soft-block / skip policy unchanged) |
| `paused` | Explicit pause or old reclaim | Same as today’s `resume_run` path (pending → start) |
| `pending` / `waiting_dispatch` / `planned` | Never started or waiting deps | No status change; `start` / followup will claim if deps met |
| `executing` / `running` / `in_progress` + **live lease / bg worker** | Healthy | Leave alone |
| `executing`-like + **lease expired / no bg / process epoch mismatch** | **Zombie after crash** | → `pending` (or `interrupted` then pending), `allow_terminal_downgrade` N/A; clear stale claim fields; then `retry_wave` |

Main / `app_run` status:

- Any zombie or requeued failed under budget → ensure main/`app_run` is `running` / `executing` (not left `failed` unless all retries exhausted).
- All success → existing rollup / complete path.
- Retries exhausted → existing fail path.

## Reconciler API (proposed)

Module: `evoflow.collab.workflow_reconciler`

```text
reconcile_task(task_id, *, reason=boot|tick|manual) -> ReconcileReport
reconcile_open_workflows(*, limit, reason) -> list[ReconcileReport]
```

Report (for logs / admin):

- `task_id`, `app_run_id?`
- `healed`: `[{subtask_id, from, to, why}]`
- `action`: `noop | start | retry_wave | continue_after_step | none_exhausted`
- `skipped_live`: subtasks still holding a valid lease

Entry points:

1. **Gateway lifespan** (after core routers / storage ready): `reconcile_open_workflows(reason=boot)`.
2. **Short interval tick** (e.g. 30–60s, same process as unattended tick or dedicated): catch zombies without waiting for day-scale `task_reclaim`.
3. **Manual / API**: `POST /api/apps/runs/{id}/recover` or extend resume to accept `failed` + recover semantics (prefer separate `recover` to keep `resume` = pause-only).

## Lease / liveness (needed for safe zombie detect)

Today claim marks `executing` but restart cannot tell “worker still alive” vs “dead”.

Minimal contract (prefer extend existing lease, not new table):

- On claim / delegate: stamp `lease_expires_at` (light workflow already 120–300s) + optional `runner_epoch` (gateway boot id).
- Heartbeat optional later; **v1**: expired lease ⇒ zombie.
- Boot: any `executing` whose `runner_epoch != current` ⇒ zombie (fast path without waiting TTL).

`task_reclaim` stays as **slow safety net** (days); reconciler is **seconds–minutes**.

## Control flow (one reconcile pass)

```text
load main + subs + app_run?
if not workflow-bound → skip (Lead chat optional later)
for each sub:
  classify → maybe rewrite status via SubtaskStateMachine
emit app_run if rows changed
if any healed to pending from zombie/failed(under budget):
  await workflow_runtime.retry_wave(task_id)
elif main paused/interrupted and user/boot recover:
  mirror resume_run (pending paused rows) → start
elif all deps satisfied for some pending and nothing executing:
  await workflow_runtime.start(task_id)   # or continue_after_step if last success just unlocked
else:
  noop
```

Follow-up after a **successful** `done` remains today’s `continue_after_step` / scheduler followup — reconciler does not replace that; it only **re-arms** the DAG when memory dispatch was lost.

## Explicit product behaviors

| User / ops intent | Mechanism |
|-------------------|-----------|
| 服务重启后自动接着跑 | Boot reconciler |
| 节点失败自动再试 | Existing monitor budget **or** reconciler same budget (single SSOT counter on subtask) |
| 暂停后继续 | Existing `resume_run` |
| 失败后人工「从这步再跑」 | API `recover` / `retry_subtask` → pending → `retry_wave` |
| 跳过失败节点往下跑 | **Out of v1** (needs product rule + DAG skip semantics) |
| 节点内部 LLM 半句话续写 | **Out of v1** (session thread may exist; not required for DAG continue) |

## Non-goals (v1)

- Reconstruct in-memory monitor state byte-for-byte.
- Mid-tool transactional checkpoint inside one worker turn.
- Skip-failed-and-continue.
- Full-task wipe requeue as “resume”.

## Phased delivery

### P0 — Reconciler + zombie heal (unblocks restart)

1. `runner_epoch` on gateway + stamp on claim.
2. `workflow_reconciler.reconcile_*`.
3. Boot + 30–60s tick.
4. Tests: 2-step chain, kill after step1 `done`, restart → step2 claims; kill mid step2 `executing` → pending → re-run step2 → complete.

### P1 — Unified retry budget + API

1. One `retry_count` / `retry_budget` field read by monitor + reconciler.
2. `POST …/recover` for app runs (`failed` / zombie / interrupted).
3. UI: “从断点继续” → recover (not new run).

### P2 — Polish

1. Metrics: zombies healed, double-claim prevented.
2. Narrow `task_reclaim` overlap docs.
3. Optional Lead-collab reconcile (same module, feature flag).

## Acceptance

- Kill gateway after step1 completed → restart → step2 runs without manual new run.
- Kill mid step2 → restart within lease/epoch rules → step2 re-dispatched once → downstream/rollup completes.
- Successful steps never re-executed.
- Second reconcile while worker live → `noop` / `skipped_live`.
- Regression: hardening 2-step light ceremony still holds (no PeerWake on completed, light `done`).

## Open questions (decide before code)

1. Boot recover **automatic** for all open App runs, or only `source_app_id` / unattended?
2. Zombie policy: always re-run node from scratch, or try `continue_subtask_session` when thread_id exists? (**Recommend v1: always re-run node**; session continue as P2.)
3. Should `resume_run` absorb recover, or keep pause-only + new `recover`? (**Recommend separate `recover`.**)
