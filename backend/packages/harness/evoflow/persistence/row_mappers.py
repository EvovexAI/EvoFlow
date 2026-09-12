"""Map between SQLite rows and config / mission / automation dicts."""

from __future__ import annotations

import json
from typing import Any

from evoflow.config.model_config import (
    resolve_model_max_output_tokens,
    resolve_model_max_retries,
    resolve_model_request_timeout,
)
from evoflow.persistence.timestamps import iso_z_to_ms, ms_to_iso_z


def _json_dumps(obj: Any) -> str:
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


def _json_loads(raw: str | None) -> Any:
    if not raw:
        return None
    return json.loads(raw)


def _split_extra(doc: dict[str, Any], known: frozenset[str]) -> tuple[dict[str, Any], dict[str, Any]]:
    known_doc = {k: doc[k] for k in known if k in doc}
    extra = {k: v for k, v in doc.items() if k not in known}
    return known_doc, extra


def _bool_int(v: Any) -> int:
    return 1 if v else 0


def _int_or_none(v: Any) -> int | None:
    if v is None or v == "":
        return None
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def _float_or_none(v: Any) -> float | None:
    if v is None or v == "":
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _merge_extra(out: dict[str, Any], extra_json: str | None) -> dict[str, Any]:
    extra = _json_loads(extra_json)
    if isinstance(extra, dict):
        out.update(extra)
    return out


# --- Models ---

_MODEL_SCALAR_KEYS = frozenset(
    {
        "name",
        "vendor",
        "display_name",
        "description",
        "use",
        "model",
        "base_url",
        "api_key",
        "request_timeout",
        "max_retries",
        "max_tokens",
        "temperature",
        "use_responses_api",
        "output_version",
        "supports_thinking",
        "supports_reasoning_effort",
        "supports_vision",
        "when_thinking_enabled",
        "thinking",
    }
)


def model_doc_to_row(doc: dict[str, Any]) -> dict[str, Any]:
    known, extra = _split_extra(doc, _MODEL_SCALAR_KEYS)
    # context_length / input_context_length / output_context_length are
    # dedicated columns (v57); pull from doc so they never end up in extra_json.
    context_length = _int_or_none(doc.get("context_length"))
    input_context_length = _int_or_none(doc.get("input_context_length"))
    output_context_length = _int_or_none(doc.get("output_context_length"))
    # Clean any stale copies that might exist in extra (e.g. pre-v57 data).
    extra.pop("context_length", None)
    extra.pop("input_context_length", None)
    extra.pop("output_context_length", None)
    # Availability is a dedicated column set (v122); never store in extra_json.
    for key in (
        "availability_status",
        "unavailable_reason",
        "unavailable_code",
        "unavailable_at",
    ):
        extra.pop(key, None)
    status_raw = doc.get("availability_status")
    availability_status = str(status_raw or "").strip().lower() or "available"
    if availability_status not in ("available", "unavailable"):
        availability_status = "available"
    return {
        "name": str(known.get("name") or doc.get("name") or "").strip(),
        "vendor": known.get("vendor"),
        "display_name": known.get("display_name"),
        "description": known.get("description"),
        "use": str(known.get("use") or ""),
        "model": str(known.get("model") or ""),
        "base_url": known.get("base_url"),
        "api_key": known.get("api_key"),
        "request_timeout": _float_or_none(known.get("request_timeout")),
        "max_retries": _int_or_none(known.get("max_retries")),
        "max_tokens": _int_or_none(known.get("max_tokens")),
        "temperature": _float_or_none(known.get("temperature")),
        "use_responses_api": _bool_int(known.get("use_responses_api")) if known.get("use_responses_api") is not None else None,
        "output_version": known.get("output_version"),
        "supports_thinking": _bool_int(known.get("supports_thinking", False)),
        "supports_reasoning_effort": _bool_int(known.get("supports_reasoning_effort", False)),
        "supports_vision": _bool_int(known.get("supports_vision", False)),
        "when_thinking_enabled_json": _json_dumps(known.get("when_thinking_enabled") or {}),
        "thinking_json": _json_dumps(known.get("thinking") or {}),
        "context_length": context_length if (context_length is not None and context_length > 0) else None,
        "input_context_length": input_context_length if (input_context_length is not None and input_context_length > 0) else None,
        "output_context_length": output_context_length if (output_context_length is not None and output_context_length > 0) else None,
        "availability_status": availability_status,
        "unavailable_reason": (str(doc.get("unavailable_reason") or "").strip() or None),
        "unavailable_code": (str(doc.get("unavailable_code") or "").strip() or None),
        "unavailable_at": (str(doc.get("unavailable_at") or "").strip() or None),
        "extra_json": _json_dumps(extra),
    }


def model_row_to_doc(r: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {"name": r["name"], "use": r["use"], "model": r["model"]}
    for key in ("vendor", "display_name", "description", "base_url", "api_key", "output_version"):
        if r.get(key) not in (None, ""):
            out[key] = r[key]
    # Apply resolve functions so YAML-loaded models (NULL in DB) get sane defaults
    # consistent with ModelCreateRequest defaults.
    out["request_timeout"] = resolve_model_request_timeout(_float_or_none(r.get("request_timeout")))
    out["temperature"] = _float_or_none(r.get("temperature"))
    out["max_retries"] = resolve_model_max_retries(_int_or_none(r.get("max_retries")))
    out["max_tokens"] = resolve_model_max_output_tokens(_int_or_none(r.get("max_tokens")))
    if r.get("use_responses_api") is not None:
        out["use_responses_api"] = bool(r["use_responses_api"])
    for key in ("supports_thinking", "supports_reasoning_effort", "supports_vision"):
        if r.get(key):
            out[key] = True
    wte = _json_loads(r.get("when_thinking_enabled_json"))
    if isinstance(wte, dict) and wte:
        out["when_thinking_enabled"] = wte
    thinking = _json_loads(r.get("thinking_json"))
    if isinstance(thinking, dict) and thinking:
        out["thinking"] = thinking
    # Dedicated columns (v57); fall back to extra_json for pre-v57 rows.
    merged = _merge_extra(out, r.get("extra_json"))
    for key in ("context_length", "input_context_length", "output_context_length"):
        val = _int_or_none(r.get(key))
        if val is None:  # pre-v57: may still live in extra_json
            val = _int_or_none(merged.get(key))
        if val is not None and val > 0:
            out[key] = val
    # Dedicated availability columns (v122); strip any stale extra_json copies.
    for key in (
        "availability_status",
        "unavailable_reason",
        "unavailable_code",
        "unavailable_at",
    ):
        out.pop(key, None)
    status = str(r.get("availability_status") or "").strip().lower() or "available"
    if status not in ("available", "unavailable"):
        status = "available"
    out["availability_status"] = status
    for key in ("unavailable_reason", "unavailable_code", "unavailable_at"):
        val = r.get(key)
        if val not in (None, ""):
            out[key] = str(val)
    plan_type = str(r.get("plan_type") or "").strip()
    if plan_type and plan_type != "none":
        out["plan_type"] = plan_type
    plan_cfg = _json_loads(r.get("plan_config"))
    if isinstance(plan_cfg, dict) and plan_cfg:
        out["plan_config"] = plan_cfg
    return out


# --- Tools / tool groups ---

_TOOL_SCALAR_KEYS = frozenset({"name", "group", "use", "tool_type", "tool_type_label"})


def tool_doc_to_row(doc: dict[str, Any]) -> dict[str, Any]:
    known, extra = _split_extra(doc, _TOOL_SCALAR_KEYS)
    for key in ("tool_type", "tool_type_label"):
        val = known.get(key)
        if val:
            extra[key] = val
    return {
        "name": str(known.get("name") or "").strip(),
        "group_name": str(known.get("group") or ""),
        "use": str(known.get("use") or ""),
        "extra_json": _json_dumps(extra),
    }


def tool_row_to_doc(r: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {"name": r["name"], "group": r["group_name"], "use": r["use"]}
    return _merge_extra(out, r.get("extra_json"))


def tool_group_doc_to_row(doc: dict[str, Any]) -> dict[str, Any]:
    known, extra = _split_extra(doc, frozenset({"name"}))
    return {"name": str(known.get("name") or doc.get("name") or "").strip(), "extra_json": _json_dumps(extra)}


def tool_group_row_to_doc(r: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {"name": r["name"]}
    return _merge_extra(out, r.get("extra_json"))


# --- Skills ---


def skill_doc_to_row(name: str, doc: dict[str, Any], *, enabled: bool) -> dict[str, Any]:
    meta = doc.get("meta") if isinstance(doc.get("meta"), dict) else {}
    return {
        "name": name.strip(),
        "enabled": _bool_int(enabled if "enabled" not in doc else doc.get("enabled", enabled)),
        "skill_md": doc.get("skill_md"),
        "source_path": doc.get("source_path"),
        "category": doc.get("category"),
        "meta_json": _json_dumps(meta),
    }


def skill_row_to_doc(r: dict[str, Any]) -> dict[str, Any]:
    meta = _json_loads(r.get("meta_json"))
    out: dict[str, Any] = {"enabled": bool(r.get("enabled"))}
    for key in ("skill_md", "source_path", "category"):
        if r.get(key) not in (None, ""):
            out[key] = r[key]
    if isinstance(meta, dict) and meta:
        out["meta"] = meta
    return out


# --- MCP ---

_MCP_SCALAR_KEYS = frozenset({
    "enabled", "type", "command", "url", "description",
    "args", "env", "headers", "oauth", "cwd", "timeout",
})


def mcp_doc_to_row(name: str, doc: dict[str, Any]) -> dict[str, Any]:
    known, extra = _split_extra(doc, _MCP_SCALAR_KEYS)
    return {
        "name": name.strip(),
        "enabled": _bool_int(known.get("enabled", True)),
        "type": str(known.get("type") or "stdio"),
        "command": known.get("command"),
        "url": known.get("url"),
        "description": str(known.get("description") or ""),
        "args_json": _json_dumps(known.get("args") or []),
        "env_json": _json_dumps(known.get("env") or {}),
        "headers_json": _json_dumps(known.get("headers") or {}),
        "oauth_json": _json_dumps(known.get("oauth") or {}),
        "extra_json": _json_dumps(extra),
    }


def mcp_row_to_doc(r: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {
        "enabled": bool(r.get("enabled", 1)),
        "type": r.get("type") or "stdio",
        "description": r.get("description") or "",
    }
    for key in ("command", "url"):
        if r.get(key) not in (None, ""):
            out[key] = r[key]
    args = _json_loads(r.get("args_json"))
    if isinstance(args, list) and args:
        out["args"] = args
    env = _json_loads(r.get("env_json"))
    if isinstance(env, dict) and env:
        out["env"] = env
    headers = _json_loads(r.get("headers_json"))
    if isinstance(headers, dict) and headers:
        out["headers"] = headers
    oauth = _json_loads(r.get("oauth_json"))
    if isinstance(oauth, dict) and oauth:
        out["oauth"] = oauth
    return _merge_extra(out, r.get("extra_json"))


# --- Channel ---


def channel_doc_to_row(platform: str, doc: dict[str, Any]) -> dict[str, Any]:
    enabled = doc.get("enabled", True)
    known, extra = _split_extra(doc, frozenset({"enabled"}))
    return {
        "platform": platform.strip(),
        "enabled": _bool_int(enabled),
        "platform_json": _json_dumps({**known, **extra}),
    }


def channel_row_to_doc(r: dict[str, Any]) -> dict[str, Any]:
    doc = _json_loads(r.get("platform_json"))
    if not isinstance(doc, dict):
        doc = {}
    if "enabled" not in doc:
        doc["enabled"] = bool(r.get("enabled", 1))
    return doc


# --- Agents ---

_AGENT_SCALAR_KEYS = frozenset(
    {
        "agent_code",
        "name",
        "agent_name",
        "description",
        "model",
        "agent_type",
        "system_prompt",
        "max_turns",
        "prompt_language",
        "timeout_seconds",
        "command",
        "auto_approve_permissions",
        "tool_groups",
        "tools",
        "mcp_servers",
        "skills",
        "knowledge_vault_ids",
        "disallowed_tools",
        "args",
        "env",
        # NOTE: avatar 和 avatar_meta 不在此集合中，它们通过 extra_json 持久化
    }
)

_AGENT_LIST_KINDS = (
    "tool_groups",
    "tools",
    "mcp_servers",
    "skills",
    "knowledge_vault_ids",
    "disallowed_tools",
    "args",
)

# Persist explicit empty lists (``tools: []``) so reload does not collapse to
# missing → ``None`` (API/UI treat None as「全工具 / 全 MCP」).
_AGENT_EMPTY_LIST_SENTINEL = "__empty__"


def agent_doc_to_parts(agent_code: str, doc: dict[str, Any]) -> tuple[dict[str, Any], list[tuple[str, str, int]], list[tuple[str, str]]]:
    known, extra = _split_extra(doc, _AGENT_SCALAR_KEYS)
    code = str(known.get("agent_code") or known.get("name") or agent_code).lower()
    row = {
        "agent_code": code,
        "agent_name": known.get("agent_name"),
        "description": str(known.get("description") or ""),
        "model": known.get("model"),
        "agent_type": str(known.get("agent_type") or "custom"),
        "system_prompt": known.get("system_prompt"),
        "max_turns": _int_or_none(known.get("max_turns")) or 500,
        "prompt_language": known.get("prompt_language"),
        "timeout_seconds": _int_or_none(known.get("timeout_seconds")) or 900,
        "command": known.get("command"),
        "auto_approve_permissions": _bool_int(known.get("auto_approve_permissions", False)),
        "extra_json": _json_dumps(extra),
    }
    lists: list[tuple[str, str, int]] = []
    for kind in _AGENT_LIST_KINDS:
        # Key absent / None →「未限制」(load as missing → AgentConfig None).
        # Explicit [] → sentinel row so round-trip keeps empty whitelist.
        if kind not in known:
            continue
        raw = known.get(kind)
        if raw is None:
            continue
        if not isinstance(raw, list):
            continue
        if len(raw) == 0:
            lists.append((kind, _AGENT_EMPTY_LIST_SENTINEL, 0))
            continue
        for i, item in enumerate(raw):
            val = str(item).strip()
            if val and val != _AGENT_EMPTY_LIST_SENTINEL:
                lists.append((kind, val, i))
    env_items: list[tuple[str, str]] = []
    env = known.get("env")
    if isinstance(env, dict):
        for k, v in env.items():
            env_items.append((str(k), str(v)))
    return row, lists, env_items


def agent_parts_to_doc(row: dict[str, Any], lists: list[tuple[str, str, int]], env_items: list[tuple[str, str]]) -> dict[str, Any]:
    out: dict[str, Any] = {
        "agent_code": row["agent_code"],
        "agent_type": row.get("agent_type") or "custom",
        "description": row.get("description") or "",
        "max_turns": int(row.get("max_turns") or 500),
        "timeout_seconds": int(row.get("timeout_seconds") or 900),
    }
    if row.get("agent_name"):
        out["agent_name"] = row["agent_name"]
    if row.get("model"):
        out["model"] = row["model"]
    if row.get("system_prompt"):
        out["system_prompt"] = row["system_prompt"]
    if row.get("prompt_language"):
        out["prompt_language"] = row["prompt_language"]
    if row.get("command"):
        out["command"] = row["command"]
    if row.get("auto_approve_permissions"):
        out["auto_approve_permissions"] = True
    by_kind: dict[str, list[tuple[int, str]]] = {}
    for kind, val, sort_order in lists:
        by_kind.setdefault(kind, []).append((sort_order, val))
    for kind, pairs in by_kind.items():
        vals = [v for _, v in sorted(pairs, key=lambda x: x[0])]
        if vals == [_AGENT_EMPTY_LIST_SENTINEL]:
            out[kind] = []
        else:
            out[kind] = [v for v in vals if v != _AGENT_EMPTY_LIST_SENTINEL]
    if env_items:
        out["env"] = {k: v for k, v in env_items}
    return _merge_extra(out, row.get("extra_json"))


# --- Automations ---

_AUTOMATION_SCALAR_KEYS = frozenset(
    {
        "name",
        "prompt",
        "schedule",
        "rrule",
        "scheduled_at",
        "status",
        "schedule_type",
        "workspace",
        "valid_from",
        "valid_until",
        "max_duration_minutes",
        "feishu_push_enabled",
        "langgraph_run",
        "langgraph_thread_mode",
        "langgraph_thread_id",
        "langgraph_timeout_seconds",
        "once_fired",
        "created_at",
        "last_run",
        "last_status",
        "run_count",
        "memory_enabled",
    }
)


def automation_doc_to_row(task_id: str, doc: dict[str, Any]) -> dict[str, Any]:
    known, extra = _split_extra(doc, _AUTOMATION_SCALAR_KEYS)
    return {
        "task_id": task_id.strip(),
        "name": str(known.get("name") or ""),
        "prompt": str(known.get("prompt") or ""),
        "schedule": known.get("schedule"),
        "rrule": known.get("rrule"),
        "scheduled_at": known.get("scheduled_at"),
        "status": known.get("status"),
        "schedule_type": known.get("schedule_type"),
        "workspace": known.get("workspace"),
        "valid_from": known.get("valid_from"),
        "valid_until": known.get("valid_until"),
        "max_duration_minutes": _int_or_none(known.get("max_duration_minutes")),
        "feishu_push_enabled": _bool_int(known.get("feishu_push_enabled", False)),
        "langgraph_run": _bool_int(known.get("langgraph_run", True)),
        "langgraph_thread_mode": known.get("langgraph_thread_mode"),
        "langgraph_thread_id": known.get("langgraph_thread_id"),
        "langgraph_timeout_seconds": _int_or_none(known.get("langgraph_timeout_seconds")),
        "once_fired": _bool_int(known.get("once_fired", False)),
        "created_at": known.get("created_at"),
        "last_run": known.get("last_run"),
        "last_status": known.get("last_status"),
        "run_count": _int_or_none(known.get("run_count")),
        "extra_json": _json_dumps(extra),
    }


def automation_row_to_doc(r: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for key in (
        "name",
        "prompt",
        "schedule",
        "rrule",
        "scheduled_at",
        "status",
        "schedule_type",
        "workspace",
        "valid_from",
        "valid_until",
        "langgraph_thread_mode",
        "langgraph_thread_id",
        "created_at",
        "last_run",
        "last_status",
    ):
        if r.get(key) not in (None, ""):
            out[key] = r[key]
    if r.get("max_duration_minutes") is not None:
        out["max_duration_minutes"] = int(r["max_duration_minutes"])
    if r.get("langgraph_timeout_seconds") is not None:
        out["langgraph_timeout_seconds"] = int(r["langgraph_timeout_seconds"])
    if r.get("run_count") is not None:
        out["run_count"] = int(r["run_count"])
    out["feishu_push_enabled"] = bool(r.get("feishu_push_enabled"))
    out["langgraph_run"] = bool(r.get("langgraph_run", 1))
    if r.get("once_fired"):
        out["once_fired"] = True
    return _merge_extra(out, r.get("extra_json"))


_AUTOMATION_RUN_SCALAR_KEYS = frozenset(
    {
        "run_id",
        "started_at",
        "trigger_type",
        "status",
        "output",
        "error",
        "duration_seconds",
        "langgraph_thread_id",
        "langgraph_run",
    }
)


def automation_run_doc_to_row(doc: dict[str, Any]) -> dict[str, Any]:
    known, extra = _split_extra(doc, _AUTOMATION_RUN_SCALAR_KEYS)
    return {
        "run_id": known.get("run_id"),
        "started_at": known.get("started_at"),
        "trigger_type": known.get("trigger_type"),
        "status": known.get("status"),
        "output": known.get("output"),
        "error": known.get("error"),
        "duration_seconds": _int_or_none(known.get("duration_seconds")) or 0,
        "langgraph_thread_id": known.get("langgraph_thread_id"),
        "langgraph_run": _bool_int(known.get("langgraph_run", False)),
        "extra_json": _json_dumps(extra),
    }


def automation_run_row_to_doc(r: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for key in (
        "run_id",
        "started_at",
        "trigger_type",
        "status",
        "output",
        "error",
        "langgraph_thread_id",
    ):
        if r.get(key) not in (None, ""):
            out[key] = r[key]
    if r.get("duration_seconds") is not None:
        out["duration_seconds"] = int(r["duration_seconds"])
    if r.get("langgraph_run"):
        out["langgraph_run"] = True
    return _merge_extra(out, r.get("extra_json"))


# --- Mission state ---


def mission_state_to_rows(thread_id: str, wrapped: dict[str, Any]) -> tuple[dict[str, Any], list, list, list]:
    """Return main row, list items, scenarios, subproblems from wrapped storage doc."""
    state = wrapped.get("state") if isinstance(wrapped.get("state"), dict) else wrapped
    main = {
        "thread_id": thread_id,
        "wrapper_version": int(wrapped.get("version") or state.get("version") or 1),
        "wrapper_updated_at": str(wrapped.get("updated_at") or ""),
        "turn_id": str(state.get("turn_id") or ""),
        "state_ts": ms_to_iso_z(state.get("ts_ms") or state.get("state_ts")),
        "primary_objective": str(state.get("primary_objective") or ""),
        "objective_confidence": float(state.get("objective_confidence") or 0.0),
        "intent_hint": str(state.get("intent_hint") or "chat"),
        "change_type": str(state.get("change_type") or "update"),
        "version": int(state.get("version") or 1),
        "bound_plan_markdown": str(state.get("bound_plan_markdown") or ""),
        "bound_plan_at": ms_to_iso_z(state.get("bound_plan_ts_ms") or state.get("bound_plan_at")),
    }
    list_items: list[tuple[str, str, int]] = []
    for kind, key in (
        ("success_criteria", "success_criteria"),
        ("constraints", "constraints"),
        ("out_of_scope", "out_of_scope"),
        ("done_subproblems", "done_subproblems"),
    ):
        raw = state.get(key)
        if not isinstance(raw, list):
            continue
        for i, item in enumerate(raw):
            text = str(item or "").strip()
            if text:
                list_items.append((kind, text, i))
    scenarios: list[tuple[str, int]] = []
    for i, sc in enumerate(state.get("activated_scenarios") or []):
        s = str(sc or "").strip()
        if s:
            scenarios.append((s, i))
    subproblems: list[dict[str, Any]] = []
    for i, sp in enumerate(state.get("active_subproblems") or []):
        if isinstance(sp, dict):
            subproblems.append({**sp, "_sort": i})
    return main, list_items, scenarios, subproblems


def mission_rows_to_wrapped(
    main: dict[str, Any],
    list_items: list[tuple[str, str, int]],
    scenarios: list[tuple[str, int]],
    subproblems: list[dict[str, Any]],
) -> dict[str, Any]:
    state: dict[str, Any] = {
        "thread_id": main["thread_id"],
        "turn_id": main.get("turn_id") or "",
        "ts_ms": iso_z_to_ms(main.get("state_ts") or main.get("ts_ms")),
        "primary_objective": main.get("primary_objective") or "",
        "objective_confidence": float(main.get("objective_confidence") or 0),
        "intent_hint": main.get("intent_hint") or "chat",
        "change_type": main.get("change_type") or "update",
        "version": int(main.get("version") or 1),
        "bound_plan_markdown": main.get("bound_plan_markdown") or "",
        "bound_plan_ts_ms": iso_z_to_ms(main.get("bound_plan_at") or main.get("bound_plan_ts_ms")),
        "success_criteria": [],
        "constraints": [],
        "out_of_scope": [],
        "done_subproblems": [],
        "active_subproblems": [],
        "activated_scenarios": [],
    }
    by_kind: dict[str, list[tuple[int, str]]] = {}
    for kind, content, sort_order in list_items:
        by_kind.setdefault(kind, []).append((sort_order, content))
    for kind, pairs in by_kind.items():
        if kind in state:
            state[kind] = [c for _, c in sorted(pairs, key=lambda x: x[0])]
    state["activated_scenarios"] = [s for s, _ in sorted(scenarios, key=lambda x: x[1])]
    subs_sorted = sorted(subproblems, key=lambda s: int(s.get("_sort") or s.get("sort_order") or 0))
    active: list[dict[str, Any]] = []
    for sp in subs_sorted:
        tools_raw = sp.get("suggested_tools")
        if isinstance(tools_raw, str):
            tools = _json_loads(tools_raw) or []
        else:
            tools = list(tools_raw or [])
        active.append(
            {
                "id": sp.get("external_id") or sp.get("id") or "",
                "title": sp.get("title") or "",
                "status": sp.get("status") or "pending",
                "priority": int(sp.get("priority") or 3),
                "evidence": sp.get("evidence") or "",
                "suggested_tools": tools if isinstance(tools, list) else [],
            }
        )
    state["active_subproblems"] = active
    return {
        "thread_id": main["thread_id"],
        "updated_at": main.get("wrapper_updated_at") or "",
        "version": int(main.get("wrapper_version") or state["version"]),
        "state": state,
    }


# --- Mission retry ---


def mission_retry_doc_to_row(doc: dict[str, Any], next_run_ts_ms: int) -> dict[str, Any]:
    return {
        "thread_id": str(doc.get("thread_id") or ""),
        "mode": str(doc.get("mode") or "incremental"),
        "turn_id": str(doc.get("turn_id") or ""),
        "attempts": _int_or_none(doc.get("attempts")) or 0,
        "last_error": str(doc.get("last_error") or ""),
        "messages_json": _json_dumps(doc.get("messages") or []),
        "ts": ms_to_iso_z(_int_or_none(doc.get("ts_ms")) or 0),
        "next_run_at": ms_to_iso_z(int(next_run_ts_ms)),
    }


def mission_retry_row_to_doc(r: dict[str, Any]) -> dict[str, Any]:
    messages = _json_loads(r.get("messages_json"))
    return {
        "thread_id": r["thread_id"],
        "mode": r.get("mode") or "incremental",
        "turn_id": r.get("turn_id") or "",
        "attempts": int(r.get("attempts") or 0),
        "last_error": r.get("last_error") or "",
        "messages": messages if isinstance(messages, list) else [],
        "ts_ms": iso_z_to_ms(r.get("ts") or r.get("ts_ms")),
        "next_run_ts_ms": iso_z_to_ms(r.get("next_run_at") or r.get("next_run_ts_ms")),
    }
