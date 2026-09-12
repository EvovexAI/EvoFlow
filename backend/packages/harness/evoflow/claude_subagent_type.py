"""Claude Code worker subagent ids (canonical ``claude-code`` + legacy aliases)."""

from __future__ import annotations

import logging
from typing import Final

logger = logging.getLogger(__name__)

CLAUDE_CODE_SUBAGENT_FAMILY: Final[frozenset[str]] = frozenset({"claude-code", "claude-session", "claude", "claude-session-tool"})

# Module-level cache for SDK availability check (avoids repeated import attempts).
_CLAUDE_SDK_AVAILABLE: bool | None = None


def is_claude_code_sdk_available() -> bool:
    """Check whether ``claude_agent_sdk`` is importable in the current process.

    The Claude Code worker subagent (``claude-code``) depends on ``claude_agent_sdk``.
    In deployments where the LangGraph runtime process does not have this package
    installed (while the Gateway process might), selecting ``claude-code`` leads to
    hard failures. This probe lets the registry and routing logic hide / fall back
    gracefully.

    The result is cached after the first call.
    """
    global _CLAUDE_SDK_AVAILABLE
    if _CLAUDE_SDK_AVAILABLE is not None:
        return _CLAUDE_SDK_AVAILABLE
    try:
        import claude_agent_sdk  # noqa: F401
        _CLAUDE_SDK_AVAILABLE = True
    except ImportError:
        _CLAUDE_SDK_AVAILABLE = False
        logger.info(
            "claude_agent_sdk not installed in this process — claude-code subagent "
            "will be hidden / fall back to general-purpose."
        )
    except Exception:
        _CLAUDE_SDK_AVAILABLE = False
        logger.warning("claude_agent_sdk import probe failed unexpectedly", exc_info=True)
    return _CLAUDE_SDK_AVAILABLE


def is_claude_code_subagent_type(name: str | None) -> bool:
    """True for the Claude Code worker (``claude-code`` or legacy ``claude-session`` / ``claude``)."""
    n = str(name or "").strip().lower().replace("_", "-")
    if not n:
        return False
    if n in CLAUDE_CODE_SUBAGENT_FAMILY:
        return True
    return n.startswith("claude-")


def collab_executor_allows_auto_outcome_without_report(*worker_types: str | None) -> bool:
    """Whether a collab subtask may auto-close on executor ``completed`` without ``subtask_outcome_report``.

    Returns False only when any provided type is Claude Code family. All built-in and custom
    registry agents (``agents/*/config.yaml`` names) otherwise return True.
    """
    for wt in worker_types:
        if wt and is_claude_code_subagent_type(wt):
            return False
    return True


def claude_subagent_lookup_keys(name: str) -> set[str]:
    """Expand ``name`` for config lookup (filesystem + built-in) including Claude family aliases."""
    raw = (name or "").strip()
    if not raw:
        return set()
    n = raw.lower().replace("_", "-")
    keys: set[str] = {raw}
    if n in CLAUDE_CODE_SUBAGENT_FAMILY:
        keys.update(CLAUDE_CODE_SUBAGENT_FAMILY)
    return keys


def effective_subagent_type(subagent_type: str | None) -> str | None:
    """Resolve the effective subagent type.

    Claude Code workers (``claude-code`` / legacy aliases) are no longer the default
    routing target for lead ``task`` / ``supervisor`` delegation. Remap to
    ``code-agent`` when that template exists, else ``general-purpose``.
    Other types (including ``None`` / empty) are returned unchanged.
    """
    st = str(subagent_type or "").strip().lower().replace("_", "-")
    if not st:
        return subagent_type
    if not is_claude_code_subagent_type(st):
        return subagent_type
    # Prefer in-process code worker; keep Claude Code only via explicit main-chat preset.
    fallback = "code-agent"
    try:
        from evoflow.subagents.registry import get_subagent_config

        if get_subagent_config(fallback) is None:
            fallback = "general-purpose"
    except Exception:
        fallback = "general-purpose"
    logger.info(
        "claude-code subagent requested — remapping to %s (Claude Code not used for task/subagent routing)",
        fallback,
    )
    return fallback