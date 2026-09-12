"""Runtime contract helpers for deep employee / workflow eval scenarios.

Snapshots system prompts, tool bindings, worker profiles; applies subtask
outcomes through the official ``apply_subtask_outcome_report`` path (not raw
project JSON mutation).
"""

from __future__ import annotations

import asyncio
from typing import Any

from evoflow.eval.scenarios._harness import Assertion, check
from evoflow.proactive.prompt import DUTY_CONTRACT_MARKER


EVAL_SCOPE = "config_and_official_outcome"


def ensure_agent(
    *,
    agent_code: str,
    agent_name: str,
    description: str = "eval",
    soul: str = "",
    system_prompt: str = "",
    tools: list[str] | None = None,
    skills: list[str] | None = None,
) -> dict[str, Any]:
    """Create agent and persist system_prompt (create_agent omits that field)."""
    from evoflow.admin import agents as agents_admin
    from evoflow.collab.agent_assignment import clear_assignable_agent_cache

    payload: dict[str, Any] = {
        "agent_code": agent_code,
        "agent_name": agent_name,
        "description": description,
        "soul": soul or f"Soul for {agent_code}",
        "tools": list(tools) if tools is not None else ["read"],
        "skills": list(skills) if skills is not None else [],
    }
    created = agents_admin.create_agent(payload)
    patch: dict[str, Any] = {}
    if system_prompt:
        patch["system_prompt"] = system_prompt
    if tools is not None:
        patch["tools"] = list(tools)
    if patch:
        agents_admin.update_agent(agent_code, patch)
    clear_assignable_agent_cache()
    return created


def snapshot_agent_runtime(agent_code: str) -> dict[str, Any]:
    """Read-back agent prompt / tools / skills / mcp for metrics + assertions."""
    from evoflow.admin import agents as agents_admin
    from evoflow.config.agents_config import load_agent_config
    from evoflow.session_tool_binding.agent_tools import resolve_agent_tool_names_for_agent

    code = str(agent_code or "").strip()
    got = agents_admin.get_agent(code) if code else {}
    cfg = None
    try:
        cfg = load_agent_config(code) if code else None
    except Exception:  # noqa: BLE001
        cfg = None

    system_prompt = ""
    soul = ""
    tools_cfg: list[str] | None = None
    skills: list[str] = []
    mcp: list[str] = []
    if isinstance(got, dict):
        system_prompt = str(got.get("system_prompt") or "")
        soul = str(got.get("soul") or got.get("soul_md") or "")
        raw_tools = got.get("tools")
        if raw_tools is not None:
            tools_cfg = [str(t).strip() for t in raw_tools if str(t or "").strip()]
        skills = [str(s).strip() for s in (got.get("skills") or []) if str(s or "").strip()]
        mcp = [str(m).strip() for m in (got.get("mcp_servers") or []) if str(m or "").strip()]
    if cfg is not None:
        if not system_prompt and cfg.system_prompt:
            system_prompt = str(cfg.system_prompt)
        if not soul and getattr(cfg, "soul_md", None):
            soul = str(cfg.soul_md or "")
        if tools_cfg is None and cfg.tools is not None:
            tools_cfg = [str(t).strip() for t in cfg.tools if str(t or "").strip()]
        if not skills and cfg.skills:
            skills = [str(s).strip() for s in cfg.skills if str(s or "").strip()]
        if not mcp and cfg.mcp_servers:
            mcp = [str(m).strip() for m in cfg.mcp_servers if str(m or "").strip()]

    resolved = sorted(resolve_agent_tool_names_for_agent(code)) if code else []
    return {
        "agent_code": code,
        "system_prompt": system_prompt,
        "system_prompt_preview": system_prompt[:240],
        "soul_preview": soul[:240],
        "tools_config": tools_cfg,
        "tools_resolved": resolved,
        "skills": skills,
        "mcp_servers": mcp,
    }


def build_duty_brief_text(agent_code: str) -> str:
    from evoflow.proactive.repositories import ProactiveRepository
    from evoflow.proactive.prompt import build_system_prompt

    role = ProactiveRepository.get_role(str(agent_code or "").strip())
    if role is None:
        return ""
    return build_system_prompt(role)


def expect_duty_brief(
    agent_code: str,
    *,
    must_contain: list[str] | None = None,
    require_marker: bool = True,
) -> Assertion:
    text = build_duty_brief_text(agent_code)
    needles = list(must_contain or [])
    missing = [n for n in needles if n and n not in text]
    marker_ok = (DUTY_CONTRACT_MARKER in text) if require_marker else True
    ok = bool(text) and marker_ok and not missing
    return check(
        f"duty_brief_{agent_code}",
        ok,
        inputs={"agent_code": agent_code, "must_contain": needles, "require_marker": require_marker},
        expected={"marker": DUTY_CONTRACT_MARKER if require_marker else None, "contains": needles},
        actual={
            "length": len(text),
            "has_marker": DUTY_CONTRACT_MARKER in text,
            "missing": missing,
            "preview": text[:320],
        },
        api="proactive.prompt.build_system_prompt",
    )


def expect_tools_include(
    agent_code: str,
    required: list[str],
    *,
    forbidden: list[str] | None = None,
) -> Assertion:
    snap = snapshot_agent_runtime(agent_code)
    resolved = set(snap.get("tools_resolved") or [])
    req = [str(t).strip() for t in required if str(t or "").strip()]
    ban = [str(t).strip() for t in (forbidden or []) if str(t or "").strip()]
    missing = [t for t in req if t not in resolved]
    leaked = [t for t in ban if t in resolved]
    ok = not missing and not leaked
    return check(
        f"tools_contract_{agent_code}",
        ok,
        inputs={"agent_code": agent_code, "required": req, "forbidden": ban},
        expected={"required_subset": req, "forbidden_absent": ban},
        actual={
            "missing": missing,
            "leaked": leaked,
            "resolved_sample": sorted(resolved)[:40],
            "tools_config": snap.get("tools_config"),
        },
        api="resolve_agent_tool_names_for_agent",
    )


def expect_prompt_contains(
    agent_code: str,
    *,
    system_prompt_substr: str | None = None,
    soul_substr: str | None = None,
) -> Assertion:
    snap = snapshot_agent_runtime(agent_code)
    sp = str(snap.get("system_prompt") or "")
    soul = str(snap.get("soul_preview") or "")
    # soul may only be in get_agent full field — re-read if needed
    if soul_substr and soul_substr not in soul:
        from evoflow.admin import agents as agents_admin

        got = agents_admin.get_agent(agent_code)
        soul = str((got or {}).get("soul") or (got or {}).get("soul_md") or soul)
    ok_sp = True if not system_prompt_substr else system_prompt_substr in sp
    ok_soul = True if not soul_substr else soul_substr in soul
    return check(
        f"prompt_contract_{agent_code}",
        ok_sp and ok_soul,
        inputs={
            "agent_code": agent_code,
            "system_prompt_substr": system_prompt_substr,
            "soul_substr": soul_substr,
        },
        expected={"system_prompt_substr": system_prompt_substr, "soul_substr": soul_substr},
        actual={
            "system_prompt_preview": sp[:240],
            "soul_preview": soul[:240],
            "system_ok": ok_sp,
            "soul_ok": ok_soul,
        },
        api="agents_admin.get_agent",
    )


def expect_worker_profile(
    subtask: dict[str, Any],
    *,
    agent_code: str | None = None,
    tools: list[str] | None = None,
    instruction_substr: str | None = None,
    goal_substr: str | None = None,
) -> Assertion:
    wp = subtask.get("worker_profile") if isinstance(subtask.get("worker_profile"), dict) else {}
    ref = str(subtask.get("ref") or subtask.get("id") or "")
    base = str(wp.get("base_subagent") or subtask.get("assigned_to") or "")
    instr = str(wp.get("instruction") or subtask.get("instruction") or "")
    goal = str(subtask.get("goal") or wp.get("goal") or "")
    wp_tools = [str(t).strip() for t in (wp.get("tools") or []) if str(t or "").strip()]

    mismatches: dict[str, Any] = {}
    if agent_code is not None and base != agent_code and str(subtask.get("assigned_to") or "") != agent_code:
        mismatches["agent"] = {"expected": agent_code, "base_subagent": base, "assigned_to": subtask.get("assigned_to")}
    if tools is not None:
        exp = [str(t).strip() for t in tools if str(t or "").strip()]
        missing = [t for t in exp if t not in wp_tools]
        if missing:
            mismatches["tools"] = {"expected": exp, "actual": wp_tools, "missing": missing}
    if instruction_substr and instruction_substr not in instr:
        mismatches["instruction"] = {"expected_substr": instruction_substr, "actual": instr[:200]}
    if goal_substr and goal_substr not in goal:
        mismatches["goal"] = {"expected_substr": goal_substr, "actual": goal[:200]}

    return check(
        f"worker_profile_{ref or 'unknown'}",
        not mismatches,
        inputs={"ref": ref, "agent_code": agent_code, "tools": tools},
        expected={"agent_code": agent_code, "tools": tools, "instruction_substr": instruction_substr},
        actual={"worker_profile": wp, "goal": goal[:200], "mismatches": mismatches or None},
        api="subtask.worker_profile",
    )


def resolve_inherited_worker_tools(
    *,
    agent_code: str,
    profile_tools: list[str] | None,
) -> list[str]:
    """Mirror worker allowlist inheritance for eval (no live session)."""
    from evoflow.collab.worker_tool_allowlist import resolve_worker_tool_allowlist
    from evoflow.session_tool_binding.agent_tools import resolve_agent_tool_names_for_agent

    catalog = set(resolve_agent_tool_names_for_agent(agent_code))
    # Expand catalog a bit so intersection is meaningful when profile lists tools
    if profile_tools:
        catalog |= {str(t).strip() for t in profile_tools if str(t or "").strip()}
    return resolve_worker_tool_allowlist(
        profile_tools=profile_tools,
        assignee_agent_code=agent_code,
        base_subagent=agent_code,
        subagent_config_tools=None,
        catalog_names=catalog or {"read", "write", "web_search"},
        session_key=None,
        session_mode="agent",
    )


def find_main_and_subtasks(task_id: str) -> tuple[Any, dict[str, Any], list[dict[str, Any]]]:
    from evoflow.collab.storage import find_main_task, get_project_storage

    storage = get_project_storage()
    # bypass_cache: workers/outcome writers must not leave eval reading stale rows
    found = find_main_task(storage, task_id, bypass_cache=True)
    if not found:
        return storage, {}, []
    _proj, task = found
    subs = [s for s in (task.get("subtasks") or []) if isinstance(s, dict)]
    return storage, task, subs


def apply_official_subtask_outcomes(
    task_id: str,
    reports_by_ref: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    """Apply terminal outcomes via ``apply_subtask_outcome_report`` then sync main.

    ``reports_by_ref`` maps step ref (or subtask id) →
    ``{outcome, summary, error?}``.
    """
    from evoflow.collab.subtask_outcome import apply_subtask_outcome_report
    from evoflow.collab.task_progress import sync_main_task_from_subtasks

    storage, task, subs = find_main_and_subtasks(task_id)
    if not task:
        return {"ok": False, "error": "main task not found", "applied": []}

    applied: list[dict[str, Any]] = []

    async def _apply_all() -> None:
        for st in subs:
            ref = str(st.get("ref") or "").strip()
            sid = str(st.get("id") or "").strip()
            key = ref if ref in reports_by_ref else (sid if sid in reports_by_ref else "")
            if not key:
                continue
            spec = reports_by_ref[key]
            outcome = str(spec.get("outcome") or "completed")
            summary = str(spec.get("summary") or f"eval outcome for {key}")
            error = spec.get("error")
            res = await apply_subtask_outcome_report(
                main_task_id=task_id,
                subtask_id=sid,
                outcome=outcome,
                summary=summary,
                error=str(error) if error else None,
                reported_by="eval_official_outcome",
                storage=storage,
            )
            applied.append({"ref": ref, "subtask_id": sid, **res})

    asyncio.run(_apply_all())
    sync = sync_main_task_from_subtasks(storage, task_id)
    storage2, task2, subs2 = find_main_and_subtasks(task_id)
    del storage2
    return {
        "ok": all(a.get("ok") for a in applied) if applied else False,
        "applied": applied,
        "sync": sync,
        "status": str((task2 or {}).get("status") or ""),
        "subtasks": [
            {
                "ref": s.get("ref"),
                "id": s.get("id"),
                "status": s.get("status"),
                "outcome_reported_at": s.get("outcome_reported_at"),
                "task_report": (s.get("task_report") or "")[:200],
            }
            for s in subs2
        ],
        "rollup_applied_at": (task2 or {}).get("rollup_applied_at"),
    }


def timeline_task_statuses(task_id: str) -> list[dict[str, Any]]:
    _storage, task, subs = find_main_and_subtasks(task_id)
    out = [
        {
            "scope": "main",
            "task_id": task_id,
            "status": task.get("status"),
            "progress": task.get("progress"),
            "execution_authorized": task.get("execution_authorized"),
        }
    ]
    for s in subs:
        out.append(
            {
                "scope": "subtask",
                "ref": s.get("ref"),
                "id": s.get("id"),
                "status": s.get("status"),
                "outcome_reported_at": s.get("outcome_reported_at"),
                "assigned_to": s.get("assigned_to"),
            }
        )
    return out


def runtime_contract_metrics(
    *,
    agent_codes: list[str] | None = None,
    task_id: str | None = None,
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    agents = {}
    for code in agent_codes or []:
        agents[code] = snapshot_agent_runtime(code)
        brief = build_duty_brief_text(code)
        agents[code]["duty_brief_preview"] = brief[:320]
        agents[code]["duty_brief_has_marker"] = DUTY_CONTRACT_MARKER in brief
    payload: dict[str, Any] = {
        "eval_scope": EVAL_SCOPE,
        "runtime_contract": {
            "agents": agents,
            "task_timeline": timeline_task_statuses(task_id) if task_id else [],
        },
    }
    if extra:
        payload["runtime_contract"].update(extra)
    return payload


__all__ = [
    "EVAL_SCOPE",
    "ensure_agent",
    "snapshot_agent_runtime",
    "build_duty_brief_text",
    "expect_duty_brief",
    "expect_tools_include",
    "expect_prompt_contains",
    "expect_worker_profile",
    "resolve_inherited_worker_tools",
    "find_main_and_subtasks",
    "apply_official_subtask_outcomes",
    "timeline_task_statuses",
    "runtime_contract_metrics",
]
