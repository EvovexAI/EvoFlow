"""Per-run memory behavior overrides via LangGraph ``runtime.context``.

Canonical gate: ``memory_enabled``.

Resolution (``resolve_memory_enabled``):

1. Global ``config.memory.enabled`` off → False
2. Session column / runtime ``memory_enabled`` if explicitly set → that value
3. Else employee (``proactive:{code}…``) → role ``config_json.memory_enabled``
   (legacy ``inject_memory`` / ``inject_assets`` false maps to off; default True)
4. Else → True

Also honors optional fine-grained:

- ``memory_injection_enabled``: override injection only (when master on).
- ``memory_updates_enabled``: override async write queue (when master on).

Architecture: Entity Asset Hub (``assets`` tool + inbox notes + experience/craft) **is** the
memory write surface. The same ``memory_enabled`` gate controls ``<memory_assets>`` injection
and tool mounting — main chat and employee chat.
"""

from __future__ import annotations

import re
from typing import Any

from langgraph.runtime import Runtime

from evoflow.agents.lead_agent.runtime_context import runtime_context_mapping
from evoflow.config.memory_config import get_memory_config

ASSETS_TOOL_NAME = "assets"

_MEMORY_BLOCK_RE = re.compile(r"<memory>\s*[\s\S]*?</memory>\s*", re.IGNORECASE)
_MEMORY_ASSETS_BLOCK_RE = re.compile(r"<memory_assets>\s*[\s\S]*?</memory_assets>\s*", re.IGNORECASE)
_MEMORY_POLICY_BLOCK_RE = re.compile(r"<memory_policy>\s*[\s\S]*?</memory_policy>\s*", re.IGNORECASE)
_ENTITY_ASSETS_BLOCK_RE = re.compile(r"<entity_assets>\s*[\s\S]*?</entity_assets>\s*", re.IGNORECASE)
_WORKSPACE_MEMORY_BLOCK_RE = re.compile(r"<workspace_memory>\s*[\s\S]*?</workspace_memory>\s*", re.IGNORECASE)
_PERSON_MEMORY_BLOCK_RE = re.compile(r"<person_memory>\s*[\s\S]*?</person_memory>\s*", re.IGNORECASE)
_MEMORY_COMMENT_BLOCK_RE = re.compile(
    r"(?:<!--\s*█\s*MEMORY CONTENT[\s\S]*?<!--\s*█\s*END MEMORY CONTENT\s*█\s*-->|<!--\s*(?:memory:\s*reference only|ref memory)\s*-->\s*)",
    re.IGNORECASE,
)
_WORKSPACE_MEMORY_COMMENT_BLOCK_RE = re.compile(
    r"<!--\s*█\s*WORKSPACE MEMORY[\s\S]*?<!--\s*█\s*END WORKSPACE MEMORY\s*█\s*-->\s*",
    re.IGNORECASE,
)
_PERSON_MEMORY_COMMENT_BLOCK_RE = re.compile(
    r"<!--\s*█\s*PERSON MEMORY[\s\S]*?<!--\s*█\s*END PERSON MEMORY\s*█\s*-->\s*",
    re.IGNORECASE,
)
_PERSON_CRAFT_COMMENT_BLOCK_RE = re.compile(
    r"<!--\s*█\s*PERSON CRAFT[\s\S]*?<!--\s*█\s*END PERSON CRAFT\s*█\s*-->\s*",
    re.IGNORECASE,
)


def _ctx_dict(runtime: Runtime | None) -> dict[str, Any]:
    """Normalize ``Runtime.context`` (dict or ``LeadAgentRuntimeContext`` dataclass)."""
    return runtime_context_mapping(runtime)


def _coerce_bool(value: Any) -> bool | None:
    if value is None:
        return None
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(int(value))
    s = str(value).strip().lower()
    if s in {"1", "true", "yes", "on"}:
        return True
    if s in {"0", "false", "no", "off"}:
        return False
    return None


def role_memory_enabled_from_config(cfg: Any) -> bool:
    """Effective role-level memory default (True unless explicitly off).

    Prefers ``memory_enabled`` when present. Legacy dicts without that key:
    ``inject_memory=false`` or ``inject_assets=false`` → off.
    ``ProactiveRoleConfig.from_json`` migrates legacy into ``memory_enabled``.
    """
    if cfg is None:
        return True
    if isinstance(cfg, dict):
        if "memory_enabled" in cfg and cfg.get("memory_enabled") is not None:
            coerced = _coerce_bool(cfg.get("memory_enabled"))
            return True if coerced is None else coerced
        if cfg.get("inject_memory") is False or cfg.get("inject_assets") is False:
            return False
        return True
    # Dataclass: ``memory_enabled`` is always set (default True) after from_json migration.
    mem = getattr(cfg, "memory_enabled", None)
    if mem is not None:
        coerced = _coerce_bool(mem)
        return True if coerced is None else coerced
    if getattr(cfg, "inject_memory", None) is False or getattr(cfg, "inject_assets", None) is False:
        return False
    return True


def _session_memory_override(session_key: str | None) -> bool | None:
    """Read flat session column; None means inherit role/default."""
    sk = str(session_key or "").strip()
    if not sk:
        return None
    try:
        from evoflow.persistence import session_repositories as sess_repo

        row = sess_repo.get_session_row_for_ui(sk) or {}
        if "memoryEnabled" in row and row.get("memoryEnabled") is not None:
            return bool(row.get("memoryEnabled"))
        ctx = row.get("context") if isinstance(row.get("context"), dict) else {}
        if isinstance(ctx, dict) and "memory_enabled" in ctx and ctx.get("memory_enabled") is not None:
            return bool(ctx.get("memory_enabled"))
    except Exception:
        return None
    return None


def _role_memory_for_session(session_key: str | None, agent_code: str | None = None) -> bool | None:
    """If proactive session (or explicit agent_code), return role default; else None."""
    code = str(agent_code or "").strip()
    sk = str(session_key or "").strip()
    if not code and sk:
        try:
            from evoflow.proactive.chat_session import (
                is_proactive_session_key,
                proactive_agent_code_from_session_key,
            )

            if is_proactive_session_key(sk):
                code = proactive_agent_code_from_session_key(sk)
        except Exception:
            code = ""
    if not code:
        return None
    try:
        from evoflow.proactive.repositories import ProactiveRepository

        role = ProactiveRepository.get_role(code)
        if role is None:
            return True
        return role_memory_enabled_from_config(getattr(role, "config", None))
    except Exception:
        return True


def resolve_memory_enabled(
    *,
    session_key: str | None = None,
    runtime: Runtime | None = None,
    runtime_ctx: dict[str, Any] | None = None,
    agent_code: str | None = None,
) -> bool:
    """Single source of truth for the memory gate (injection + assets tool)."""
    cfg = get_memory_config()
    if not cfg.enabled:
        return False

    ctx = dict(runtime_ctx or {})
    if runtime is not None:
        ctx = {**_ctx_dict(runtime), **ctx}

    # Explicit runtime/session pin wins (False or True).
    if "memory_enabled" in ctx and ctx.get("memory_enabled") is not None:
        coerced = _coerce_bool(ctx.get("memory_enabled"))
        if coerced is not None:
            return coerced

    sk = str(session_key or ctx.get("session_key") or "").strip() or None
    sess = _session_memory_override(sk)
    if sess is not None:
        return sess

    code = str(agent_code or ctx.get("agent_id") or ctx.get("agent_name") or "").strip() or None
    role_default = _role_memory_for_session(sk, code)
    if role_default is not None:
        return role_default

    return True


def memory_updates_block_reason(runtime: Runtime | None) -> str | None:
    """若本 run 不应入队记忆更新，返回中文原因；否则 ``None``。"""
    cfg = get_memory_config()
    if not cfg.enabled:
        return "config.memory.enabled=false（总开关关闭）"
    if not resolve_memory_enabled(runtime=runtime):
        return "memory_enabled=false（本会话/岗位关闭记忆）"
    ctx = _ctx_dict(runtime)
    if ctx.get("memory_updates_enabled") is False:
        return "runtime.context.memory_updates_enabled=false（本会话关闭异步写入）"
    return None


def effective_memory_injection_enabled(runtime: Runtime | None) -> bool:
    """Whether ``<memory_assets>`` prompt injection should apply for this run."""
    if not resolve_memory_enabled(runtime=runtime):
        return False
    cfg = get_memory_config()
    ctx = _ctx_dict(runtime)
    if ctx.get("memory_injection_enabled") is False:
        return False
    if ctx.get("memory_injection_enabled") is True:
        return True
    return bool(cfg.injection_enabled)


def effective_assets_tool_enabled(runtime: Runtime | None) -> bool:
    """Whether the ``assets`` tool must be bound for this run (same gate as memory)."""
    return resolve_memory_enabled(runtime=runtime)


def effective_memory_updates_enabled(runtime: Runtime | None) -> bool:
    """Whether conversation turns should be queued for memory.json updates."""
    if not resolve_memory_enabled(runtime=runtime):
        return False
    ctx = _ctx_dict(runtime)
    if ctx.get("memory_updates_enabled") is False:
        return False
    return True


def strip_memory_xml_blocks(text: str) -> str:
    """Remove ``<memory_assets>`` (and legacy memory / policy / entity_assets) from a system prompt."""
    if not text:
        return text
    cleaned = _WORKSPACE_MEMORY_COMMENT_BLOCK_RE.sub("", text)
    cleaned = _MEMORY_COMMENT_BLOCK_RE.sub("", cleaned)
    cleaned = _PERSON_MEMORY_COMMENT_BLOCK_RE.sub("", cleaned)
    cleaned = _PERSON_CRAFT_COMMENT_BLOCK_RE.sub("", cleaned)
    cleaned = _MEMORY_ASSETS_BLOCK_RE.sub("", cleaned)
    cleaned = _MEMORY_POLICY_BLOCK_RE.sub("", cleaned)
    cleaned = _ENTITY_ASSETS_BLOCK_RE.sub("", cleaned)
    cleaned = _MEMORY_BLOCK_RE.sub("", cleaned)
    cleaned = _WORKSPACE_MEMORY_BLOCK_RE.sub("", cleaned)
    return _PERSON_MEMORY_BLOCK_RE.sub("", cleaned)
