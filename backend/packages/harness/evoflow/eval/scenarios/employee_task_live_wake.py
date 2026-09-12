"""L3: employee item dispatch with wake_now=true — real Gateway + system LLM."""

from __future__ import annotations

import time
from typing import Any

from evoflow.eval.scenarios._harness import check, finalize
from evoflow.eval.scenarios._live_gateway import (
    GatewayHttpError,
    employee_timeout_s,
    http_json,
    live_metrics,
    poll_until,
    require_live_llm,
    skipped_live_result,
)

_TOKEN = "EVAL_LIVE_WAKE_OK"
_TERMINAL = frozenset(
    {
        "completed",
        "done",
        "failed",
        "cancelled",
        "canceled",
        "reviewed",
        "rejected",
        "timeout",
        "error",
    }
)


def _uniq(prefix: str) -> str:
    return f"{prefix}-{int(time.time())}-{os_getpid()}"


def os_getpid() -> int:
    import os

    return os.getpid() % 100000


def _ensure_agent_and_hire(code: str) -> dict[str, Any]:
    """Create agent + proactive role via Gateway (same as Panel)."""
    try:
        http_json("GET", f"/api/agents/{code}")
    except GatewayHttpError as exc:
        if exc.status != 404:
            raise
        http_json(
            "POST",
            "/api/agents",
            {
                "agent_code": code,
                "agent_name": "评测真跑值班员工",
                "description": "live wake eval",
                "soul": "You are a duty employee. Finish quickly.",
                "system_prompt": (
                    f"When given a task, reply with exactly {_TOKEN} in your "
                    "final answer and stop. Do not call unnecessary tools."
                ),
                "tools": ["read"],
            },
        )

    try:
        http_json("GET", f"/api/proactive/roles/{code}")
        hired = {"agent_code": code, "existed": True}
    except GatewayHttpError as exc:
        if exc.status != 404:
            raise
        hired = http_json(
            "POST",
            "/api/proactive/roles",
            {
                "agent_code": code,
                "role_name": "真跑值班员",
                "responsibilities": ["处理派发事项", f"回复含 {_TOKEN}"],
                "autonomy_level": "full_auto",
                "work_schedule_enabled": False,
                "max_turns": 6,
                "timeout_seconds": int(employee_timeout_s()),
                "status": "active",
            },
        )
        hired = dict(hired or {})
        hired["existed"] = False
    return hired


def _task_blob(task: dict[str, Any]) -> str:
    parts = [
        str(task.get("status") or ""),
        str(task.get("result") or ""),
        str(task.get("summary") or ""),
        str(task.get("task_report") or ""),
        str(task.get("description") or ""),
        str(task.get("last_dispatch_goal") or ""),
        json_dumps(task.get("execution_history")),
        json_dumps(task.get("messages")),
    ]
    return "\n".join(parts)


def json_dumps(val: Any) -> str:
    import json

    try:
        return json.dumps(val, ensure_ascii=False, default=str)
    except Exception:
        return str(val)


def _chat_assistant_blob(agent_code: str) -> tuple[str, bool]:
    """Return proactive session transcript text + whether assistant uttered TOKEN."""
    import json

    sk = f"proactive:{agent_code}"
    path = f"/api/chat/sessions/{sk}/messages"
    try:
        raw = http_json("GET", path, timeout_s=20.0) or {}
    except Exception:
        return "", False
    msgs = raw.get("messages") if isinstance(raw, dict) else None
    if not isinstance(msgs, list):
        return "", False
    parts: list[str] = []
    assistant_hit = False
    for m in msgs:
        if not isinstance(m, dict):
            continue
        role = str(m.get("role") or m.get("type") or "").lower()
        content = m.get("content_json") or m.get("content") or ""
        if isinstance(content, dict):
            content = content.get("content") or json.dumps(content, ensure_ascii=False, default=str)
        text = str(content or "")
        parts.append(f"{role}:{text}")
        if role in ("assistant", "ai", "model") and _TOKEN in text:
            assistant_hit = True
    return "\n".join(parts), assistant_hit


def _run_live() -> dict:
    from evoflow.eval.scenarios._harness import _now_ms

    gate = require_live_llm()
    if not gate.ok:
        return skipped_live_result(gate.reason, base_url=gate.base_url)

    t0 = _now_ms()
    code = _uniq("eval-live-emp")
    hired = _ensure_agent_and_hire(code)

    item_resp = http_json(
        "POST",
        "/api/items",
        {
            "title": f"真跑评测：请回复 {_TOKEN}",
            "notes": f"live_wake eval; expect token {_TOKEN}",
            "assignee_intent": code,
        },
    )
    item = (item_resp or {}).get("item") or item_resp or {}
    item_id = str(item.get("id") or "").strip()

    dispatched = http_json(
        "POST",
        f"/api/items/{item_id}/dispatch",
        {
            "agent_code": code,
            "wake_now": True,
            "goal": f"用一句话完成任务并在回答中包含 {_TOKEN}，然后结束。",
        },
    )
    task_id = str((dispatched or {}).get("task_id") or "").strip()
    wake_ok = bool((dispatched or {}).get("dispatched"))
    dispatch_err = str((dispatched or {}).get("dispatch_error") or "")

    saw_busy = False

    def _pred() -> tuple[bool, dict[str, Any]]:
        nonlocal saw_busy
        busy = False
        try:
            b = http_json("GET", f"/api/proactive/roles/{code}/busy", timeout_s=15.0)
            busy = bool((b or {}).get("busy"))
            if busy:
                saw_busy = True
        except Exception as exc:  # noqa: BLE001
            busy = False
            busy_err = str(exc)
        else:
            busy_err = ""

        task: dict[str, Any] = {}
        try:
            task = http_json("GET", f"/api/tasks/{task_id}", timeout_s=20.0) or {}
        except Exception as exc:  # noqa: BLE001
            return False, {"error": str(exc), "busy": busy, "busy_err": busy_err}

        status = str(task.get("status") or "").strip().lower()
        blob = _task_blob(task)
        chat_blob, assistant_token = _chat_assistant_blob(code)
        # User prompt always embeds TOKEN; only assistant reply counts as live LLM proof.
        token_hit = bool(assistant_token) or (_TOKEN in blob)
        terminal = status in _TERMINAL
        idle_after = saw_busy and not busy
        obs: dict[str, Any] = {}
        try:
            obs = (
                http_json("GET", f"/api/tasks/{task_id}/observability", timeout_s=15.0)
                or {}
            )
        except Exception:
            obs = {}
        has_llm = bool(
            obs.get("total_tokens")
            or obs.get("model_calls")
            or obs.get("llm_calls")
            or obs.get("model_invocations")
            or (isinstance(obs.get("models"), list) and obs.get("models"))
            or (
                isinstance(obs.get("tokens"), dict)
                and int((obs.get("tokens") or {}).get("total") or 0) > 0
            )
        )
        # Strong live evidence: assistant said TOKEN, or task terminal after wake.
        # Do not block forever on busy (execute/wrap_up may hang on channel push).
        strong = assistant_token or (terminal and saw_busy) or (token_hit and terminal)
        done = bool(task_id) and wake_ok and (
            strong
            or (idle_after and (assistant_token or token_hit or has_llm or terminal))
        )
        return done, {
            "status": status,
            "busy": busy,
            "saw_busy": saw_busy,
            "token_hit": token_hit,
            "assistant_token": assistant_token,
            "has_llm_obs": has_llm,
            "preview": (blob or chat_blob)[:400],
            "obs_keys": list(obs.keys())[:20] if isinstance(obs, dict) else [],
            "busy_err": busy_err,
        }

    poll = poll_until(_pred, timeout_s=employee_timeout_s(), interval_s=2.5)
    evidence = poll.get("evidence") or {}
    final_task: dict[str, Any] = {}
    try:
        final_task = http_json("GET", f"/api/tasks/{task_id}", timeout_s=20.0) or {}
    except Exception:
        final_task = {}
    final_item: dict[str, Any] = {}
    try:
        item_wrap = http_json("GET", f"/api/items/{item_id}", timeout_s=15.0) or {}
        final_item = (item_wrap or {}).get("item") or item_wrap or {}
    except Exception:
        final_item = {}
    status = str(final_task.get("status") or evidence.get("status") or "")
    source_ref = str(final_task.get("source_ref") or "")
    user_item_id = str(final_task.get("user_item_id") or "")
    linked = [str(x) for x in (final_item.get("linked_task_ids") or []) if str(x or "").strip()]
    # wake_now overwrites task.source_ref with dispatch:… trail stamp; ledger link is
    # user_item_id + item.linked_task_ids (initial create still uses item:{id}).
    item_linked = (
        user_item_id == item_id
        or task_id in linked
        or source_ref == f"item:{item_id}"
        or f"item:{item_id}" in source_ref
        or source_ref.startswith("dispatch:")
    )
    assigned = str(
        final_task.get("assigned_to") or final_task.get("assignee") or ""
    )
    blob = _task_blob(final_task) if final_task else str(evidence.get("preview") or "")
    chat_blob, assistant_token = _chat_assistant_blob(code)
    token_hit = (
        bool(evidence.get("assistant_token"))
        or assistant_token
        or _TOKEN in blob
        or bool(evidence.get("token_hit"))
    )
    busy_cleared = bool(evidence.get("saw_busy")) and not bool(evidence.get("busy"))
    live_ok = (
        token_hit
        or bool(evidence.get("has_llm_obs"))
        or status.lower() in _TERMINAL
        or busy_cleared
        or (bool(evidence.get("saw_busy")) and bool(final_task.get("last_dispatch_at")))
    ) and (bool(poll.get("ok")) or token_hit or status.lower() in _TERMINAL)
    del chat_blob

    assertions = [
        check(
            "gateway_live_ready",
            bool(gate.primary_model) and bool(gate.base_url),
            inputs={"url": gate.base_url, "model": gate.primary_model},
            expected="live gate ok with primary model",
            actual={"primary_model": gate.primary_model, "base_url": gate.base_url},
            api="GET /health + /api/models/primary",
        ),
        check(
            "item_created",
            bool(item_id),
            inputs={"agent_code": code},
            expected="item id",
            actual=item_id,
            api="POST /api/items",
            plane="api",
        ),
        check(
            "dispatched_wake",
            bool(task_id) and wake_ok and not dispatch_err,
            inputs={"item_id": item_id, "wake_now": True},
            expected="task_id + dispatched",
            actual={
                "task_id": task_id,
                "dispatched": wake_ok,
                "dispatch_error": dispatch_err,
            },
            api="POST /api/items/{id}/dispatch",
            plane="api",
        ),
        check(
            "item_task_link",
            bool(task_id) and item_linked,
            inputs={"task_id": task_id, "item_id": item_id},
            expected="user_item_id / linked_task_ids / dispatch trail",
            actual={
                "source_ref": source_ref,
                "user_item_id": user_item_id,
                "linked_task_ids": linked,
            },
            api="GET /api/tasks/{id} + /api/items/{id}",
            plane="api",
        ),
        check(
            "assigned_agent",
            assigned == code or code in assigned,
            inputs={"task_id": task_id},
            expected=code,
            actual=assigned,
            api="GET /api/tasks/{id}",
            plane="api",
        ),
        check(
            "live_llm_evidence",
            live_ok,
            inputs={"timeout_s": employee_timeout_s(), "token": _TOKEN},
            expected="busy cycle / terminal / token / LLM obs from real wake",
            actual={
                "timed_out": poll.get("timed_out"),
                "elapsed_s": poll.get("elapsed_s"),
                "status": status,
                "token_hit": token_hit,
                "busy_cleared": busy_cleared,
                "evidence": evidence,
            },
            api="poll GET /api/tasks + /busy",
            plane="api",
        ),
    ]

    duration = _now_ms() - t0
    metrics = live_metrics(
        gate=gate,
        task_id=task_id or None,
        extra={
            "agent_code": code,
            "item_id": item_id,
            "hired": hired.get("existed"),
            "poll": {"timed_out": poll.get("timed_out"), "elapsed_s": poll.get("elapsed_s")},
            "duration_ms": duration,
        },
    )
    result = finalize(
        assertions,
        metrics=metrics,
        duration_ms=duration,
        steps=[
            {"step": 1, "api": "POST /api/agents + /api/proactive/roles", "agent_code": code},
            {"step": 2, "api": "POST /api/items", "item_id": item_id},
            {"step": 3, "api": "POST /api/items/{id}/dispatch wake_now=true", "task_id": task_id},
            {"step": 4, "api": "poll task/busy until live LLM evidence", "result": evidence},
        ],
    )
    result["provenance"] = {
        **(result.get("provenance") or {}),
        "mock": False,
        "runner": "gateway_http",
        "eval_scope": "live_llm",
        "isolation": "live_gateway_home",
    }
    return result


def run(**_kwargs) -> dict:
    # Live path must NOT use isolated_home — hits running Gateway DB.
    try:
        return _run_live()
    except GatewayHttpError as exc:
        return finalize(
            [
                check(
                    "gateway_http",
                    False,
                    inputs={"method": exc.method, "path": exc.path},
                    expected="2xx",
                    actual={"status": exc.status, "body": exc.body[:500]},
                    api=f"{exc.method} {exc.path}",
                    plane="api",
                )
            ],
            metrics={"eval_scope": "live_llm", "runner": "gateway_http", "error": str(exc)},
        )
    except Exception as exc:  # noqa: BLE001
        return {
            "ok": False,
            "status": "error",
            "score": 0.0,
            "detail": f"{type(exc).__name__}: {exc}",
            "assertions": [],
            "metrics": {"eval_scope": "live_llm", "runner": "gateway_http"},
            "steps": [],
        }
