"""Collab task → ZCode ``workflowRuns`` protocol projection (EvoFlow).

Maps ``GET /tasks`` shaped main+subtasks into ``WorkflowRunState`` so the V4
conversation snapshot / ``POST /api/v4/conversation/workflowRuns`` can feed the
same UI join path as ZCode DWF (``WorkflowRunDigest`` / digests).
"""

from __future__ import annotations

import logging
import re
import time
from typing import Any

logger = logging.getLogger(__name__)

_WORKFLOW_RUN_ACTIONS = frozenset(
    {
        "workflow.run",
        "workflow.resume",
        "workflow.recover",
        "workflow.run_status",
    }
)

_MAX_RUNS = 8


def is_workflow_progress_action(action: str) -> bool:
    return str(action or "").strip() in _WORKFLOW_RUN_ACTIONS


def _clip(value: Any, max_len: int) -> str:
    s = str(value or "").strip()
    if not s:
        return ""
    return s if len(s) <= max_len else s[:max_len]


def _norm_status(status: Any) -> str:
    s = str(status or "").strip().lower().replace("-", "_")
    if s in {"completed", "done", "success", "reviewed", "archived"}:
        return "completed"
    if s in {"failed", "error", "timed_out"}:
        return "errored"
    if s in {"cancelled", "canceled", "deleted"}:
        return "stopped"
    if s in {
        "executing",
        "in_progress",
        "running",
        "active",
        "verifying",
        "reflecting",
        "waiting_dispatch",
        "waiting_confirmation",
        "req_confirm",
        "waiting_user",
        "awaiting_close",
    }:
        return "running"
    return "pending"


def _site_id(sub: dict[str, Any], index: int) -> str:
    # Prefer real subtask id：对话卡 Agent 药丸 / 右栏节点详情都靠 siteId 联回 subtask。
    sid = _clip(sub.get("subtaskId") or sub.get("subtask_id") or sub.get("id"), 64)
    if sid:
        cleaned = re.sub(r"[^a-zA-Z0-9_-]", "", sid)[:64]
        return cleaned or f"s{index}"
    ref = _clip(sub.get("ref"), 32)
    if ref:
        return _clip(f"s{ref}", 64) or f"s{index}"
    return f"s{index}"


def _lane_id(sub: dict[str, Any], index: int) -> str:
    # Prefer assignedAgent / assigned_to code so chat pills can resolve AssignedAgentAvatar.
    code = _clip(sub.get("assignedAgent") or sub.get("assigned_to"), 48)
    if code:
        slug = re.sub(r"[^a-zA-Z0-9_-]", "", code)[:48]
        return _clip(slug or f"lane{index}", 64)
    display = _clip(
        sub.get("assignedAgentDisplay") or sub.get("assigned_agent_name"),
        48,
    )
    if display:
        slug = re.sub(r"[^a-zA-Z0-9\u4e00-\u9fff_-]", "", display)[:48]
        return _clip(slug or f"lane{index}", 64)
    return f"lane{index}"


def _station_label(sub: dict[str, Any], index: int) -> str:
    name = _clip(sub.get("name"), 128)
    if name:
        return name
    desc = _clip(sub.get("description"), 128)
    if desc:
        return desc
    ref = _clip(sub.get("ref"), 32)
    return f"步骤 {ref}" if ref else f"步骤 {index + 1}"


def _node_phase(status: Any) -> str:
    st = _norm_status(status)
    if st in {"completed", "errored", "stopped"}:
        return "settled"
    if st == "running":
        return "executing"
    return "queued"


def _node_outcome(status: Any) -> str | None:
    st = _norm_status(status)
    if st == "completed":
        return "ok"
    if st == "errored":
        return "failed"
    if st == "stopped":
        return "cancelled"
    return None


def _actor_status(status: Any) -> str:
    st = _norm_status(status)
    if st == "running":
        return "running"
    if st == "pending":
        return "waiting"
    return "completed"


def _sort_subs(subs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    def key(row: dict[str, Any]) -> tuple[int, str]:
        ref = str(row.get("ref") or "").strip()
        try:
            return (int(ref), str(row.get("subtaskId") or row.get("id") or ""))
        except ValueError:
            return (10_000, str(row.get("subtaskId") or row.get("id") or ref))

    return sorted(subs, key=key)


def extract_workflow_progress_from_platform_result(
    *,
    action: str,
    content: str,
    display: dict[str, Any] | None,
) -> dict[str, Any] | None:
    """Pull mainTaskId / name / runId from platform tool result + platform_ui display."""
    if not is_workflow_progress_action(action):
        return None

    main_task_id = ""
    name = ""
    run_id = ""
    app_id = ""

    if isinstance(display, dict) and display.get("kind") == "platform_ui":
        name = _clip(display.get("title") or display.get("entityLabel"), 160)
        actions = display.get("actions")
        if isinstance(actions, list):
            for row in actions:
                if not isinstance(row, dict):
                    continue
                open_stage = row.get("openStage") if isinstance(row.get("openStage"), dict) else None
                if not open_stage or str(open_stage.get("kind") or "").strip() != "collab-workflow":
                    continue
                data = open_stage.get("data") if isinstance(open_stage.get("data"), dict) else {}
                main_task_id = _clip(
                    data.get("mainTaskId")
                    or data.get("main_task_id")
                    or data.get("taskId")
                    or data.get("task_id"),
                    128,
                )
                name = _clip(open_stage.get("title") or row.get("label") or name, 160) or name
                if main_task_id:
                    break

    blob: dict[str, Any] | None = None
    text = str(content or "").strip()
    if text.startswith("{"):
        try:
            import json

            parsed = json.loads(text)
            if isinstance(parsed, dict):
                blob = parsed
        except (TypeError, ValueError):
            blob = None

    if blob:
        if not main_task_id:
            run = blob.get("run") if isinstance(blob.get("run"), dict) else {}
            main_task_id = _clip(
                blob.get("task_id")
                or blob.get("taskId")
                or run.get("task_id")
                or run.get("taskId"),
                128,
            )
            ui = blob.get("ui") if isinstance(blob.get("ui"), dict) else None
            if not main_task_id and ui and isinstance(ui.get("actions"), list):
                for row in ui["actions"]:
                    if not isinstance(row, dict):
                        continue
                    open_stage = (
                        row.get("openStage") if isinstance(row.get("openStage"), dict) else None
                    )
                    if not open_stage or str(open_stage.get("kind") or "").strip() != "collab-workflow":
                        continue
                    data = open_stage.get("data") if isinstance(open_stage.get("data"), dict) else {}
                    main_task_id = _clip(
                        data.get("mainTaskId")
                        or data.get("main_task_id")
                        or data.get("taskId")
                        or data.get("task_id"),
                        128,
                    )
                    if main_task_id:
                        break
        run = blob.get("run") if isinstance(blob.get("run"), dict) else {}
        app = blob.get("app") if isinstance(blob.get("app"), dict) else {}
        run_id = _clip(
            blob.get("runId")
            or blob.get("run_id")
            or run.get("run_id")
            or run.get("runId")
            or run.get("id"),
            128,
        )
        app_id = _clip(blob.get("appId") or blob.get("app_id") or run.get("app_id") or app.get("id"), 128)
        if not name:
            name = _clip(
                blob.get("name") or blob.get("app_name") or app.get("name") or run.get("app_name"),
                160,
            )

    if not main_task_id:
        return None
    return {
        "mainTaskId": main_task_id,
        "runId": run_id or main_task_id,
        "name": name or "工作流",
        "appId": app_id,
    }


def load_collab_bundle(main_task_id: str) -> tuple[dict[str, Any] | None, list[dict[str, Any]]]:
    """Load main task + subtasks from task storage (best-effort)."""
    tid = str(main_task_id or "").strip()
    if not tid:
        return None, []
    try:
        from evoflow.admin import tasks as tasks_admin

        data = tasks_admin.get_task(tid)
    except Exception:
        logger.debug("workflow_runs_projection: get_task failed task=%s", tid, exc_info=True)
        return None, []
    if not isinstance(data, dict):
        return None, []
    task = data.get("task") if isinstance(data.get("task"), dict) else data
    if not isinstance(task, dict):
        return None, []
    main = {
        "taskId": _clip(task.get("id") or task.get("taskId") or tid, 128) or tid,
        "name": _clip(task.get("name") or task.get("title"), 160),
        "status": _clip(task.get("status"), 64),
        "progress": task.get("progress"),
    }
    raw_subs = task.get("subtasks") if isinstance(task.get("subtasks"), list) else []
    if not raw_subs and isinstance(data.get("subtasks"), list):
        raw_subs = data["subtasks"]
    subs: list[dict[str, Any]] = []
    for row in raw_subs:
        if not isinstance(row, dict):
            continue
        sid = _clip(row.get("subtaskId") or row.get("subtask_id") or row.get("id"), 128)
        if not sid:
            continue
        sub_thread = _clip(
            row.get("subtaskThreadId")
            or row.get("subtask_thread_id")
            or row.get("external_session_id")
            or row.get("externalSessionId"),
            128,
        )
        item: dict[str, Any] = {
            "subtaskId": sid,
            "ref": _clip(row.get("ref"), 32),
            "name": _clip(row.get("name"), 128),
            "description": _clip(row.get("description"), 240),
            "status": _clip(row.get("status"), 64),
            "assignedAgent": _clip(
                row.get("assignedAgent") or row.get("assigned_to") or row.get("assignedTo"),
                128,
            ),
            "assignedAgentDisplay": _clip(
                row.get("assignedAgentDisplay")
                or row.get("assignedAgentName")
                or row.get("assigned_agent_name"),
                128,
            ),
        }
        if sub_thread:
            item["subtaskThreadId"] = sub_thread
        subs.append(item)
    return main, subs


def project_collab_to_workflow_run(
    *,
    main_task: dict[str, Any] | None,
    subtasks: list[dict[str, Any]] | None,
    tool_call_id: str = "",
    run_id: str = "",
    name: str = "",
    last_event_sequence: int | None = None,
) -> dict[str, Any] | None:
    """Build a ``WorkflowRunState``-shaped dict (protocol-compatible)."""
    main_task_id = _clip((main_task or {}).get("taskId") or run_id, 128)
    if not main_task_id:
        return None
    rid = _clip(run_id or main_task_id, 128) or main_task_id
    status = _norm_status((main_task or {}).get("status"))
    stations = _sort_subs([s for s in (subtasks or []) if isinstance(s, dict)])

    actors: list[dict[str, Any]] = []
    nodes: list[dict[str, Any]] = []
    phases: list[dict[str, Any]] = []
    phase_names: list[str] = []

    for index, sub in enumerate(stations):
        sid = _site_id(sub, index)
        lid = _lane_id(sub, index)
        label = _station_label(sub, index)
        phase_name = label
        agent_name = _clip(
            sub.get("assignedAgentDisplay") or sub.get("assignedAgent") or label or f"agent-{index + 1}",
            128,
        ) or f"agent-{index + 1}"

        actor: dict[str, Any] = {
            "siteId": lid,
            "ordinal": index,
            "name": agent_name,
            "status": _actor_status(sub.get("status")),
            "phaseName": phase_name,
        }
        # ≡ collab subtask_thread_id：对话卡 Agent 药丸与右侧画布节点打开同源
        sub_thread = _clip(sub.get("subtaskThreadId") or sub.get("subtask_thread_id"), 128)
        if sub_thread:
            actor["sessionId"] = sub_thread
        actors.append(actor)
        node: dict[str, Any] = {
            "siteId": sid,
            "ordinal": index,
            "kind": "ask",
            "phase": _node_phase(sub.get("status")),
            "actorSiteId": lid,
            "actorOrdinal": index,
            "phaseName": phase_name,
        }
        outcome = _node_outcome(sub.get("status"))
        if outcome:
            node["outcome"] = outcome
        desc = _clip(sub.get("description"), 240)
        if desc:
            node["instructionsHead"] = desc
        nodes.append(node)
        phases.append({"name": phase_name, "rounds": 1})
        phase_names.append(phase_name)

    settled = sum(1 for n in nodes if n.get("phase") == "settled")
    current_phase = None
    if phase_names:
        exec_idx = next((i for i, n in enumerate(nodes) if n.get("phase") == "executing"), -1)
        if exec_idx >= 0:
            current_phase = phase_names[exec_idx]
        elif settled > 0:
            current_phase = phase_names[min(settled, len(phase_names)) - 1]
        else:
            current_phase = phase_names[0]

    out: dict[str, Any] = {
        "runId": rid,
        "status": status,
        "usage": {"spentTokens": 0, "nodesUsed": len(nodes)},
        "actors": actors,
        "nodes": nodes,
        "lastEventSequence": int(last_event_sequence or int(time.time() * 1000)),
    }
    tcid = _clip(tool_call_id, 128)
    if tcid:
        out["toolCallId"] = tcid
    if phases:
        out["phases"] = phases
        out["phaseNames"] = phase_names
    if current_phase:
        out["currentPhase"] = current_phase
    # Keep display name on a side channel for journal summary (not part of WorkflowRunState).
    display_name = _clip(name or (main_task or {}).get("name"), 160) or "工作流"
    out["_label"] = display_name
    out["_mainTaskId"] = main_task_id
    return out


def upsert_run_list(
    runs: list[dict[str, Any]],
    new_run: dict[str, Any],
    *,
    max_runs: int = _MAX_RUNS,
) -> list[dict[str, Any]]:
    """Replace same runId or prepend; cap at max_runs (drop oldest terminal first)."""
    rid = str(new_run.get("runId") or "").strip()
    if not rid:
        return runs
    cleaned = [dict(r) for r in runs if str(r.get("runId") or "").strip() != rid]
    cleaned.insert(0, new_run)
    while len(cleaned) > max_runs:
        # Drop oldest terminal first
        drop_i = None
        for i in range(len(cleaned) - 1, -1, -1):
            st = str(cleaned[i].get("status") or "")
            if st in {"completed", "errored", "stopped"}:
                drop_i = i
                break
        if drop_i is None:
            drop_i = len(cleaned) - 1
        cleaned.pop(drop_i)
    return cleaned


def to_journal_summary(run: dict[str, Any]) -> dict[str, Any]:
    """Shape for ``v4ConversationWorkflowRunSummarySchema``."""
    status = str(run.get("status") or "pending")
    if status not in {"completed", "errored", "pending", "running", "stopped"}:
        status = "pending"
    out: dict[str, Any] = {
        "runId": str(run.get("runId") or ""),
        "status": status,
        "resumable": False,
    }
    tcid = str(run.get("toolCallId") or "").strip()
    if tcid:
        out["toolCallId"] = tcid
    label = str(run.get("_label") or "").strip()
    if label:
        out["label"] = label[:160]
    seq = run.get("lastEventSequence")
    if isinstance(seq, int) and seq >= 0:
        out["updatedAt"] = seq
    return out


def strip_internal_keys(run: dict[str, Any]) -> dict[str, Any]:
    """Drop EvoFlow-only keys before putting into snapshot.workflowRuns."""
    return {k: v for k, v in run.items() if not str(k).startswith("_")}
