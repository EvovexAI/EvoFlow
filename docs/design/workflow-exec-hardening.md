# Workflow execution hardening

Status: Phase A + B done. Phase C0 (write-path sync + light lease) done. Full Runtime split still open.

## Diagnosis

App workflow has no dedicated runtime. It reuses Lead-oriented collab
(claim / peer / lease / progress·outcome rituals). That causes:

1. Side channels (PeerWake) can rewrite step status outside claim.
2. Multi-writer state (`app_runs` / main task / subtasks) with read-time sync.
3. `__rollup__` as another LLM worker even when handoff already has reports.

## Done

### Phase A — stop the bleeding

| Gate | Change |
|------|--------|
| Terminal one-way | `task_tool` skips `status=executing` on terminal; `patch_collab_subtask` refuses terminal→active |
| PeerWake claim | `wake.py` + `delegate_…_peer_wake` skip terminal redispatch; completed targets auto-reply `task_report` |
| AppRun write-path (pipeline) | `_requeue` / fail / complete / retries-exhausted sync `evoflow_app_runs`; GET heal |
| Rollup prompt | Hard ban on peer-asking completed upstream for verbatim content |

### Phase B — shrink workflow contract

| Item | Change |
|------|--------|
| B1 ceremony | App/workflow/rollup → **light** reporting (outcome-only mandatory) |
| B2 rollup | `prefer_answer_node_rollup`: skip LLM `__rollup__` for answer_ref / single leaf |
| B2 handoff | Summary 2400 / binding str 3000 |
| B2 poll | Adaptive 0.5s → 1s → 3s + wall-clock deadline |

### Phase C0 — partial write-path (done)

| Item | Change |
|------|--------|
| Event-ish sync | `push_app_run_from_main_task` on `sync_main_task_from_subtasks` when app-sourced |
| Light lease | workflow light lease 120–300s (full stays 300–900s) |

## Still open (Phase C — larger)

Do **not** mix into hotfix PRs; plan as a dedicated milestone:

1. **`WorkflowScheduler` + `StepStateMachine`**  
   Single advance API; illegal transitions raise; retry is the only downgrade path.

2. **True Runtime split**  
   Workflow vs Collab share Step Runner only; workflow has no peer/checklist surface by construction.

3. **AppRun as external SSOT**  
   Event bus on every step terminal → run update (replace remaining GET heal reliance).

4. **Optional later**  
   File-path-only handoff for huge artifacts; further lease/watchdog tuning with metrics.

## Acceptance (regression)

Re-run a 2-step chain app (no custom rollup instruction):

- No `PeerWake_*` against completed steps
- No LLM `__rollup__` worker (answer_node_only copy)
- Light workers: essentially work → one `subtask_outcome_report`
- Run reaches `completed` / 100% without GET-only heal
