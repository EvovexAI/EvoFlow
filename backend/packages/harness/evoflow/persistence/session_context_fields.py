"""Flat columns for ``evoflow_chat_sessions`` (workspace / model / run mode)."""

from __future__ import annotations

import json
from typing import Any

WORKSPACE_GROUP_UNBOUND = "__unbound__"


def normalize_workspace_group_key(path: str | None) -> str:
    """Canonical workspace group key for sidebar grouping / filters."""
    p = str(path or "").strip().replace("\\", "/")
    while p.endswith("/"):
        p = p[:-1]
    return p.lower()


def normalize_workspace_root_for_storage(path: str | None) -> str | None:
    """Persist workspace roots with stable separators (case preserved for display)."""
    p = str(path or "").strip().replace("\\", "/")
    while p.endswith("/"):
        p = p[:-1]
    return p or None


# Keys stored in dedicated columns (not duplicated in context_json).
_FLAT_KEYS: tuple[str, ...] = (
    "local_workspace_root",
    "use_virtual_paths",
    "model_name",
    "primary_model_name",
    "session_mode",
    "thinking_enabled",
    "reasoning_effort",
    "is_plan_mode",
    "subagent_enabled",
    "include_search",
    "memory_enabled",
    "use_claude_code_chat",
    "collab_phase",
    "collab_task_id",
    "agent_id",
)


def _bool_to_int(v: Any) -> int | None:
    if v is None:
        return None
    return 1 if bool(v) else 0


def _int_to_bool(v: Any) -> bool | None:
    if v is None:
        return None
    return bool(int(v))


def is_workspace_user_pinned(context: dict[str, Any] | None) -> bool:
    """True when the user explicitly bound a workspace in EvoPanel (do not auto-overwrite)."""
    if not isinstance(context, dict):
        return False
    v = context.get("workspace_user_pinned")
    if v is True:
        return True
    if isinstance(v, (int, float)) and int(v) != 0:
        return True
    return str(v or "").strip().lower() in {"true", "1", "yes"}


def agent_id_from_session_key(session_key: str) -> str | None:
    sk = str(session_key or "").strip()
    parts = sk.split(":")
    if len(parts) >= 3 and parts[0] == "agent":
        return parts[1].strip() or None
    # Smart-employee duty sessions: proactive:{agent_code}
    if len(parts) >= 2 and parts[0] == "proactive":
        return parts[1].strip() or None
    return None


def flat_fields_from_context(
    context: dict[str, Any] | None,
    *,
    session_key: str = "",
    primary_model_name: str | None = None,
) -> dict[str, Any]:
    """Extract DB column values from session ``context`` dict."""
    ctx = context if isinstance(context, dict) else {}
    out: dict[str, Any] = {
        "local_workspace_root": normalize_workspace_root_for_storage(
            str(ctx.get("local_workspace_root") or "").strip() or None,
        ),
        "use_virtual_paths": _bool_to_int(ctx.get("use_virtual_paths")),
        "model_name": str(ctx.get("model_name") or "").strip() or None,
        "primary_model_name": str(ctx.get("primary_model_name") or primary_model_name or "").strip() or None,
        "session_mode": str(ctx.get("session_mode") or "").strip() or None,
        "thinking_enabled": _bool_to_int(ctx.get("thinking_enabled")),
        "reasoning_effort": str(ctx.get("reasoning_effort") or "").strip() or None,
        "is_plan_mode": _bool_to_int(ctx.get("is_plan_mode")),
        "subagent_enabled": _bool_to_int(ctx.get("subagent_enabled")),
        "include_search": _bool_to_int(ctx.get("include_search")),
        "memory_enabled": _bool_to_int(ctx.get("memory_enabled")),
        "use_claude_code_chat": _bool_to_int(ctx.get("use_claude_code_chat")),
        "collab_phase": str(ctx.get("collab_phase") or "").strip() or None,
        "collab_task_id": str(ctx.get("collab_task_id") or "").strip() or None,
        # Prefer explicit context agent_id (in-session role switch) over session_key
        # embedding. Fall back to agent_name only when it looks like an agent_code.
        "agent_id": (
            str(ctx.get("agent_id") or "").strip()
            or (
                an
                if (
                    (an := str(ctx.get("agent_name") or "").strip())
                    and an.replace("-", "").replace("_", "").isalnum()
                    and an.lower() == an
                )
                else ""
            )
            or agent_id_from_session_key(session_key)
            or None
        ),
    }
    return out


def context_from_flat_row(row: dict[str, Any]) -> dict[str, Any]:
    """Rebuild ``context`` for EvoPanel from flat DB columns (+ legacy context_json extras).

    Note: after the schema v75 migration ``activated_scenarios_json`` was dropped;
    ``session_mode`` is now the single source of truth and the scenario list is
    derived from it (plan→['plan'], agent→['agent'], else→[]).
    """
    ctx: dict[str, Any] = {}
    lwr = row.get("local_workspace_root")
    if lwr:
        ctx["local_workspace_root"] = str(lwr)
    uvp = row.get("use_virtual_paths")
    if uvp is not None:
        ctx["use_virtual_paths"] = _int_to_bool(uvp)
    mn = row.get("model_name")
    if mn:
        ctx["model_name"] = str(mn)
    pmn = row.get("primary_model_name")
    if pmn:
        ctx["primary_model_name"] = str(pmn)
    sm = row.get("session_mode")
    if sm:
        ctx["session_mode"] = str(sm)
    te = row.get("thinking_enabled")
    if te is not None:
        ctx["thinking_enabled"] = _int_to_bool(te)
    reff = row.get("reasoning_effort")
    if reff:
        ctx["reasoning_effort"] = str(reff)
    for key in ("is_plan_mode", "subagent_enabled", "include_search", "memory_enabled", "use_claude_code_chat"):
        v = row.get(key)
        if v is not None:
            ctx[key] = _int_to_bool(v)
    cp = row.get("collab_phase")
    if cp:
        ctx["collab_phase"] = str(cp)
    ct = row.get("collab_task_id")
    if ct:
        ctx["collab_task_id"] = str(ct)
    aid = row.get("agent_id")
    if aid:
        ctx["agent_id"] = str(aid)
        # Mirror into agent_name so clients that only read agent_name still see role switches
        # (session_key may remain agent:main:…).
        if "agent_name" not in ctx or not str(ctx.get("agent_name") or "").strip():
            ctx["agent_name"] = str(aid)
    # activated_scenarios is derived from session_mode (source of truth after v75).
    sm_mode = str(row.get("session_mode") or "").strip().lower()
    if sm_mode == "plan":
        ctx["activated_scenarios"] = ["plan"]
    elif sm_mode == "agent":
        ctx["activated_scenarios"] = ["agent"]

    legacy = row.get("context_json")
    if isinstance(legacy, str) and legacy.strip():
        try:
            extra = json.loads(legacy)
        except Exception:
            extra = None
        if isinstance(extra, dict):
            for k, v in extra.items():
                if k in _FLAT_KEYS:
                    continue
                if k not in ctx:
                    ctx[k] = v
    return ctx


def residual_context_json(context: dict[str, Any] | None) -> str:
    """Persist only keys that are not represented in flat columns."""
    ctx = context if isinstance(context, dict) else {}
    extra = {k: v for k, v in ctx.items() if k not in _FLAT_KEYS}
    return json.dumps(extra, ensure_ascii=False, separators=(",", ":"))


def migrate_session_context_json_to_flat(conn: Any) -> None:
    """One-time: copy legacy ``context_json`` into flat columns."""
    rows = conn.execute("SELECT session_key, context_json FROM evoflow_chat_sessions WHERE context_json IS NOT NULL").fetchall()
    primary = resolve_primary_model_name()
    for row in rows:
        sk = str(row[0] or "").strip()
        if not sk:
            continue
        try:
            ctx = json.loads(row[1] or "{}")
        except Exception:
            ctx = {}
        if not isinstance(ctx, dict):
            ctx = {}
        flat = flat_fields_from_context(ctx, session_key=sk, primary_model_name=primary)
        conn.execute(
            """
            UPDATE evoflow_chat_sessions SET
                local_workspace_root = COALESCE(?, local_workspace_root),
                use_virtual_paths = COALESCE(?, use_virtual_paths),
                model_name = COALESCE(?, model_name),
                primary_model_name = COALESCE(?, primary_model_name),
                session_mode = COALESCE(?, session_mode),
                thinking_enabled = COALESCE(?, thinking_enabled),
                reasoning_effort = COALESCE(?, reasoning_effort),
                is_plan_mode = COALESCE(?, is_plan_mode),
                subagent_enabled = COALESCE(?, subagent_enabled),
                include_search = COALESCE(?, include_search),
                memory_enabled = COALESCE(?, memory_enabled),
                use_claude_code_chat = COALESCE(?, use_claude_code_chat),
                collab_phase = COALESCE(?, collab_phase),
                collab_task_id = COALESCE(?, collab_task_id),
                agent_id = COALESCE(?, agent_id),
                context_json = ?
            WHERE session_key = ?
            """,
            (
                flat.get("local_workspace_root"),
                flat.get("use_virtual_paths"),
                flat.get("model_name"),
                flat.get("primary_model_name"),
                flat.get("session_mode"),
                flat.get("thinking_enabled"),
                flat.get("reasoning_effort"),
                flat.get("is_plan_mode"),
                flat.get("subagent_enabled"),
                flat.get("include_search"),
                flat.get("memory_enabled"),
                flat.get("use_claude_code_chat"),
                flat.get("collab_phase"),
                flat.get("collab_task_id"),
                flat.get("agent_id"),
                residual_context_json(ctx),
                sk,
            ),
        )


def resolve_primary_model_name() -> str | None:
    try:
        from evoflow.config.app_config import get_app_config

        cfg = get_app_config()
        raw = (cfg.primary_model or "").strip()
        if raw:
            return raw
        if cfg.models:
            return str(cfg.models[0].name or "").strip() or None
    except Exception:
        pass
    return None
