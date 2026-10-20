"""Ambient employee / lead-agent actor for tool ACL (parallel to human principal_id).

Model-facing tools must not trust a self-reported ``agent_code`` argument.
Each run binds the actor into ``runtime.context`` / configurable and an ambient
``ContextVar`` so admin/tool layers can resolve who is operating without
threading a runtime handle everywhere.
"""

from __future__ import annotations

import contextvars
import logging
from typing import Any

logger = logging.getLogger(__name__)

_current_agent_actor_var: contextvars.ContextVar[str] = contextvars.ContextVar(
    "evoflow_current_agent_actor",
    default="",
)

# Non-employee / system lead codes that may mutate any Task (CLI, main session).
_PRIVILEGED_LEAD_CODES = frozenset({"", "user", "main", "lead_agent", "auto"})


def set_current_agent_actor(agent_code: str | None) -> str:
    """Bind the current run's agent actor (empty clears stale value from prior run)."""
    code = normalize_agent_actor(agent_code)
    _current_agent_actor_var.set(code)
    return code


def get_current_agent_actor() -> str:
    """Read the ambient agent actor (empty when unbound / CLI / legacy)."""
    return str(_current_agent_actor_var.get() or "").strip()


def normalize_agent_actor(raw: str | None) -> str:
    """Strip session suffixes (``proactive:`` / ``:task:`` / …) to a bare agent_code."""
    try:
        from evoflow.proactive.employee_prompting.identity import normalize_employee_agent_code

        return str(normalize_employee_agent_code(raw) or "").strip()
    except Exception:
        code = str(raw or "").strip()
        if code.startswith("proactive:"):
            code = code[len("proactive:") :].strip()
        for kind in ("task", "duty", "chat"):
            marker = f":{kind}:"
            if marker in code:
                return code.split(marker, 1)[0].strip()
        return code


def resolve_agent_actor_from_mapping(ctx: Any | None) -> str:
    """Resolve actor from a mapping / dataclass-like context.

    Prefer a real employee / 小V code over ``main``/``lead_agent``/``auto``, then
    fall back to ``session_key`` (``proactive:{code}``), then privileged lead codes.
    """
    if ctx is None:
        return ""

    def _get(key: str) -> Any:
        get = getattr(ctx, "get", None)
        if callable(get):
            try:
                return get(key)
            except Exception:
                return None
        return getattr(ctx, key, None)

    lead_fallback = ""
    for key in ("proactive_agent_code", "agent_id", "agent_name"):
        code = normalize_agent_actor(_get(key))
        if not code:
            continue
        if code.lower() in {"main", "lead_agent", "auto"}:
            lead_fallback = lead_fallback or code
            continue
        return code
    sk = str(_get("session_key") or "").strip()
    if sk:
        from_sk = normalize_agent_actor(sk)
        if from_sk:
            return from_sk
    return lead_fallback

def agent_actor_from_runtime(runtime: Any = None, context: Any = None) -> str:
    """Resolve actor: explicit context → runtime.context → LangGraph config → ambient."""
    if context is not None:
        code = resolve_agent_actor_from_mapping(context)
        if code:
            return code
    if runtime is not None:
        ctx = getattr(runtime, "context", None)
        code = resolve_agent_actor_from_mapping(ctx)
        if code:
            return code
        cfg = getattr(runtime, "config", None)
        if isinstance(cfg, dict):
            conf = cfg.get("configurable") if isinstance(cfg.get("configurable"), dict) else {}
            code = resolve_agent_actor_from_mapping(conf)
            if code:
                return code
    try:
        from langgraph.config import get_config

        conf = get_config()
        cfg = conf.get("configurable") if isinstance(conf, dict) else None
        if isinstance(cfg, dict):
            code = resolve_agent_actor_from_mapping(cfg)
            if code:
                return code
    except Exception:
        pass
    return get_current_agent_actor()


def is_privileged_task_actor(agent_code: str | None) -> bool:
    """True when actor may mutate any Task (system / human / 小V / main lead)."""
    code = normalize_agent_actor(agent_code)
    if code.lower() in _PRIVILEGED_LEAD_CODES or not code:
        return True
    try:
        from evoflow.agents.xiaomi.identity import is_xiaomi_agent

        if is_xiaomi_agent(code):
            return True
    except Exception:
        if code.lower() in {"xiaomi", "小v", "小蜜", "xiaov"}:
            return True
    return False


def stamp_raised_by(
    *,
    actor: str | None = None,
    raised_by_arg: str | None = None,
) -> str:
    """Resolve Task ``raised_by`` (派发人) from ambient operator — never trust model guess.

    - Named agent (employee / 小V / …): always the current actor.
    - Empty / ``main`` / ``lead_agent`` / ``auto`` (CLI or generic lead): use
      ``raised_by_arg`` if provided, else ``user``.
    Never falls back to ``assignee`` (that polluted historical rows).
    """
    who = normalize_agent_actor(actor if actor is not None else get_current_agent_actor())
    if who and who.lower() not in {"main", "lead_agent", "auto"}:
        return who
    return str(raised_by_arg or "").strip() or "user"


def assert_can_mutate_assigned_task(
    *,
    actor: str | None = None,
    assigned_to: str | None,
) -> None:
    """Raise ``ValidationError`` when a non-privileged employee mutates another's task.

    ``assigned_to`` is the target row's assignee (subtask preferred by callers).
    Empty ambient actor is privileged (CLI / tests / unauthenticated admin).
    """
    from evoflow.admin.errors import ValidationError

    who = normalize_agent_actor(actor if actor is not None else get_current_agent_actor())
    if is_privileged_task_actor(who):
        return
    owner = str(assigned_to or "").strip()
    if not owner:
        # Unassigned rows: only privileged actors may mutate.
        raise ValidationError(
            f"只能更新本岗 Task（assigned_to 为空的单仅系统/小V 可改）；当前 actor=`{who}`"
        )
    if who.lower() == owner.lower():
        return
    raise ValidationError(
        f"只能更新本岗 Task（assigned_to=`{owner}`）；当前 actor=`{who}`。"
        "禁止改他人/上级状态；跨岗请走 handlers / create+wake / 小V。"
    )


def bind_agent_actor_into_context(run_context: dict[str, Any]) -> dict[str, Any]:
    """Fill proactive_agent_code when missing and set ambient actor (idempotent)."""
    ctx = dict(run_context or {})
    # Prefer employee/session resolution over bare main/lead_agent labels.
    existing = resolve_agent_actor_from_mapping(ctx)
    if existing and not str(ctx.get("proactive_agent_code") or "").strip():
        # Keep main/lead as agent_name; only stamp proactive_agent_code for real codes.
        if existing.lower() not in {"main", "lead_agent", "auto"}:
            ctx["proactive_agent_code"] = existing
    set_current_agent_actor(existing)
    return ctx


__all__ = [
    "agent_actor_from_runtime",
    "assert_can_mutate_assigned_task",
    "bind_agent_actor_into_context",
    "get_current_agent_actor",
    "is_privileged_task_actor",
    "normalize_agent_actor",
    "resolve_agent_actor_from_mapping",
    "set_current_agent_actor",
    "stamp_raised_by",
]
