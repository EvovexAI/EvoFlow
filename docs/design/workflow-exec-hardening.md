# Workflow execution hardening

Status: Phase A landed (止血). Phase B/C are follow-ups.

## Diagnosis

App workflow has no dedicated runtime. It reuses Lead-oriented collab
(claim / peer / lease / progress·outcome rituals). That causes:

1. Side channels (PeerWake) can rewrite step status outside claim.
2. Multi-writer state (`app_runs` / main task / subtasks) with read-time sync.
3. `__rollup__` as another LLM worker even when handoff already has reports.

## Phase A (done) — stop the bleeding

| Gate | Change |
|------|--------|
| Terminal one-way | `task_tool` skips `status=executing` on terminal; `patch_collab_subtask` refuses terminal→active |
| PeerWake claim | `wake.py` + `delegate_collab_subtask_peer_wake` skip terminal redispatch; completed targets auto-reply `task_report` |
| AppRun write-path | `_requeue` / fail / complete / retries-exhausted sync `evoflow_app_runs`; `pending`→`running` on GET sync; conservative `_heal_run_invariant` |
| Rollup prompt | Hard ban on peer-asking completed upstream for verbatim content |

Acceptance: re-run a 2-step + rollup app → `completed` / 100% without Step stuck in `executing`; no `PeerWake_*` against completed steps.

## Phase B — shrink workflow contract

- Workflow workers: no peer tools; short steps optional checklist / mid progress.
- Prefer `answer_node_only` when `answer_from_ref` is set (skip LLM rollup).
- Richer handoff limits or file-path handoff so rollup need not chase verbatim.

## Phase C — split runtime

- `WorkflowScheduler` + `StepStateMachine` (terminal one-way, idempotent claim).
- Collab keeps peer / steering; share only the step runner.
- AppRun becomes external SSOT; event-driven progress (not GET-only sync).

## Out of scope for Phase A

Adaptive poll intervals and ceremony-tool grading (behavior churn; separate PR).
