"""L3: workflow app run via Gateway HTTP — real worker LLM, no outcome inject."""

from __future__ import annotations

import time
from typing import Any

from evoflow.eval.scenarios._harness import check, finalize
from evoflow.eval.scenarios._live_gateway import (
    GatewayHttpError,
    http_json,
    live_metrics,
    poll_until,
    require_live_llm,
    skipped_live_result,
    workflow_timeout_s,
)

_TOKEN = "EVAL_LIVE_WF_OK"
_MAIN_TERMINAL = frozenset({"completed", "done", "reviewed", "failed", "cancelled", "canceled", "error"})
_STEP_DONE = frozenset({"completed", "done", "reviewed", "failed", "cancelled", "canceled"})


def _run_live() -> dict:
    from evoflow.eval.scenarios._harness import _now_ms

    gate = require_live_llm()
    if not gate.ok:
        return skipped_live_result(gate.reason, base_url=gate.base_url)

    t0 = _now_ms()
    stamp = f"{int(time.time())}"
    app_name = f"评测真跑工作流 {stamp}"

    created = http_json(
        "POST",
        "/api/apps",
        {
            "name": app_name,
            "description": "live workflow eval — real LLM workers",
            "category": "eval",
            "execution_mode": "workflow",
            "icon": "🧪",
            "parameters": [
                {"name": "topic", "type": "string", "label": "主题", "default": "live"},
            ],
            "steps": [
                {
                    "ref": "1",
                    "type": "agentStep",
                    "title": "收集",
                    "assigned_agent": "general-purpose",
                    "goal": "收集 {{topic}}",
                    "instruction": (
                        f"用一两句话处理主题 {{{{topic}}}}，并在总结中包含 {_TOKEN}_S1，然后结束。"
                    ),
                    "depends_on": [],
                },
                {
                    "ref": "2",
                    "type": "agentStep",
                    "title": "摘要",
                    "assigned_agent": "general-purpose",
                    "goal": "摘要 {{topic}}",
                    "instruction": (
                        f"基于上一步写一句摘要，并包含 {_TOKEN}_S2，然后结束。"
                    ),
                    "depends_on": ["1"],
                },
            ],
        },
    )
    app_id = str((created or {}).get("id") or (created or {}).get("app_id") or "").strip()
    if not app_id:
        raise RuntimeError(f"create app missing id: {created!r}")

    published = http_json("POST", f"/api/apps/{app_id}/publish", {})
    pub_status = str((published or {}).get("status") or "")

    run_resp = http_json(
        "POST",
        f"/api/apps/{app_id}/run",
        {
            "parameters": {"topic": f"真跑主题-{stamp}"},
            "execution_mode": "workflow",
            "run_kind": "debug",
            "trigger_kind": "api",
        },
        timeout_s=120.0,
    )
    task_id = str((run_resp or {}).get("task_id") or "").strip()
    run_id = str(
        (run_resp or {}).get("run_id")
        or ((run_resp or {}).get("run") or {}).get("id")
        or ""
    ).strip()

    def _pred() -> tuple[bool, dict[str, Any]]:
        task: dict[str, Any] = {}
        try:
            task = http_json("GET", f"/api/tasks/{task_id}", timeout_s=30.0) or {}
        except Exception as exc:  # noqa: BLE001
            return False, {"error": str(exc)}

        status = str(task.get("status") or "").strip().lower()
        subs = list(task.get("subtasks") or [])
        if not subs:
            try:
                subs = list(
                    http_json("GET", f"/api/tasks/{task_id}/subtasks", timeout_s=20.0) or []
                )
            except Exception:
                subs = []

        reported = []
        for s in subs:
            if not isinstance(s, dict):
                continue
            report = str(
                s.get("task_report") or s.get("result") or s.get("summary") or ""
            )
            st = str(s.get("status") or "").strip().lower()
            reported_at = s.get("outcome_reported_at")
            if reported_at or st in _STEP_DONE or len(report) > 20:
                reported.append(
                    {
                        "ref": s.get("ref"),
                        "id": s.get("id"),
                        "status": st,
                        "report_len": len(report),
                        "preview": report[:160],
                        "token_s1": f"{_TOKEN}_S1" in report,
                        "token_s2": f"{_TOKEN}_S2" in report,
                    }
                )

        main_done = status in _MAIN_TERMINAL
        # At least one step must show real worker output (not inject)
        has_worker_output = len(reported) >= 1
        # Prefer both steps progressing when DAG finishes
        enough = len(reported) >= 2 or (main_done and has_worker_output)
        done = bool(task_id) and enough and (main_done or len(reported) >= 2)
        return done, {
            "status": status,
            "subtask_count": len(subs),
            "reported": reported,
            "rollup_applied_at": task.get("rollup_applied_at"),
        }

    poll = poll_until(_pred, timeout_s=workflow_timeout_s(), interval_s=3.0)
    evidence = poll.get("evidence") or {}

    final_task: dict[str, Any] = {}
    try:
        final_task = http_json("GET", f"/api/tasks/{task_id}", timeout_s=30.0) or {}
    except Exception:
        final_task = {}
    status = str(final_task.get("status") or evidence.get("status") or "")
    subs = list(final_task.get("subtasks") or evidence.get("reported") and [] or [])
    if not final_task.get("subtasks"):
        try:
            subs = list(http_json("GET", f"/api/tasks/{task_id}/subtasks", timeout_s=20.0) or [])
        except Exception:
            subs = []

    reports_with_body = []
    token_hits = 0
    for s in subs:
        if not isinstance(s, dict):
            continue
        report = str(s.get("task_report") or s.get("result") or s.get("summary") or "")
        if len(report) > 8 or s.get("outcome_reported_at"):
            reports_with_body.append(s.get("ref") or s.get("id"))
        if _TOKEN in report:
            token_hits += 1

    # Fallback to poll evidence previews
    if not reports_with_body:
        for row in evidence.get("reported") or []:
            if isinstance(row, dict) and int(row.get("report_len") or 0) > 8:
                reports_with_body.append(row.get("ref") or row.get("id"))
            if isinstance(row, dict) and (row.get("token_s1") or row.get("token_s2")):
                token_hits += 1

    assertions = [
        check(
            "gateway_live_ready",
            bool(gate.primary_model) and bool(gate.base_url),
            inputs={"url": gate.base_url, "model": gate.primary_model},
            expected="live gate ok with primary model",
            actual={"primary_model": gate.primary_model, "base_url": gate.base_url},
            api="GET /health",
        ),
        check(
            "app_created_published",
            bool(app_id) and (pub_status in ("published", "active") or bool(published)),
            inputs={"app_id": app_id},
            expected="published app",
            actual={"app_id": app_id, "status": pub_status},
            api="POST /api/apps + /publish",
            plane="api",
        ),
        check(
            "workflow_started",
            bool(task_id),
            inputs={"app_id": app_id, "run_id": run_id},
            expected="task_id from run",
            actual={"task_id": task_id, "run_id": run_id},
            api="POST /api/apps/{id}/run",
            plane="api",
        ),
        check(
            "live_worker_reports",
            len(reports_with_body) >= 1 and bool(poll.get("ok")),
            inputs={"token": _TOKEN, "timeout_s": workflow_timeout_s()},
            expected=">=1 subtask with real report (no inject)",
            actual={
                "reported_refs": reports_with_body,
                "token_hits": token_hits,
                "timed_out": poll.get("timed_out"),
                "elapsed_s": poll.get("elapsed_s"),
                "evidence": evidence,
            },
            api="poll GET /api/tasks/{id}/subtasks",
            plane="api",
        ),
        check(
            "main_terminal_or_steps_done",
            status.lower() in _MAIN_TERMINAL or len(reports_with_body) >= 2,
            inputs={"task_id": task_id},
            expected="main completed/failed or both steps reported",
            actual={"status": status, "reported": len(reports_with_body)},
            api="GET /api/tasks/{id}",
            plane="api",
        ),
    ]

    duration = _now_ms() - t0
    metrics = live_metrics(
        gate=gate,
        task_id=task_id or None,
        extra={
            "app_id": app_id,
            "run_id": run_id,
            "poll": {"timed_out": poll.get("timed_out"), "elapsed_s": poll.get("elapsed_s")},
            "duration_ms": duration,
            "inject_outcome": False,
        },
    )
    result = finalize(
        assertions,
        metrics=metrics,
        duration_ms=duration,
        steps=[
            {"step": 1, "api": "POST /api/apps", "app_id": app_id},
            {"step": 2, "api": "POST /api/apps/{id}/publish"},
            {"step": 3, "api": "POST /api/apps/{id}/run", "task_id": task_id, "run_id": run_id},
            {"step": 4, "api": "poll tasks/subtasks for live worker reports"},
        ],
    )
    result["provenance"] = {
        **(result.get("provenance") or {}),
        "mock": False,
        "runner": "gateway_http",
        "eval_scope": "live_llm",
        "isolation": "live_gateway_home",
        "inject_outcome": False,
    }
    return result


def run(**_kwargs) -> dict:
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
