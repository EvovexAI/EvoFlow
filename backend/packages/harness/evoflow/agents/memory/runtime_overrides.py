"""Per-run memory behavior overrides via LangGraph ``runtime.context``.

Keys (all optional):

- ``memory_enabled``: if ``False``, disable injection and async memory updates for this run.
- ``memory_injection_enabled``: override ``memory.injection_enabled`` from config (when master ``memory.enabled`` is on).
- ``memory_updates_enabled``: override whether ``MemoryMiddleware`` queues writes (when master ``memory.enabled`` is on).
"""

from __future__ import annotations

import re
from typing import Any

from langgraph.runtime import Runtime

from evoflow.agents.lead_agent.runtime_context import runtime_context_mapping
from evoflow.config.memory_config import get_memory_config

_MEMORY_BLOCK_RE = re.compile(r"<memory>\s*[\s\S]*?</memory>\s*", re.IGNORECASE)
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


def memory_updates_block_reason(runtime: Runtime | None) -> str | None:
    """若本 run 不应入队记忆更新，返回中文原因；否则 ``None``。"""
    cfg = get_memory_config()
    if not cfg.enabled:
        return "config.memory.enabled=false（总开关关闭）"
    ctx = _ctx_dict(runtime)
    if ctx.get("memory_enabled") is False:
        return "runtime.context.memory_enabled=false（本会话关闭记忆）"
    if ctx.get("memory_updates_enabled") is False:
        return "runtime.context.memory_updates_enabled=false（本会话关闭异步写入）"
    return None


def _ctx_dict(runtime: Runtime | None) -> dict[str, Any]:
    """Normalize ``Runtime.context`` (dict or ``LeadAgentRuntimeContext`` dataclass)."""
    return runtime_context_mapping(runtime)


def effective_memory_injection_enabled(runtime: Runtime | None) -> bool:
    """Whether built-in ``<memory>...</memory>`` prompt injection should apply for this run."""
    cfg = get_memory_config()
    if not cfg.enabled:
        return False
    ctx = _ctx_dict(runtime)
    if ctx.get("memory_enabled") is False:
        return False
    if ctx.get("memory_injection_enabled") is False:
        return False
    if ctx.get("memory_injection_enabled") is True:
        return True
    return bool(cfg.injection_enabled)


def effective_memory_updates_enabled(runtime: Runtime | None) -> bool:
    """Whether conversation turns should be queued for memory.json updates."""
    cfg = get_memory_config()
    if not cfg.enabled:
        return False
    ctx = _ctx_dict(runtime)
    if ctx.get("memory_enabled") is False:
        return False
    if ctx.get("memory_updates_enabled") is False:
        return False
    if ctx.get("memory_updates_enabled") is True:
        return True
    return True


def strip_memory_xml_blocks(text: str) -> str:
    """Remove memory / workspace_memory / person_memory / craft sections from a system prompt."""
    if not text:
        return text
    cleaned = _WORKSPACE_MEMORY_COMMENT_BLOCK_RE.sub("", text)
    cleaned = _MEMORY_COMMENT_BLOCK_RE.sub("", cleaned)
    cleaned = _PERSON_MEMORY_COMMENT_BLOCK_RE.sub("", cleaned)
    cleaned = _PERSON_CRAFT_COMMENT_BLOCK_RE.sub("", cleaned)
    cleaned = _MEMORY_BLOCK_RE.sub("", cleaned)
    cleaned = _WORKSPACE_MEMORY_BLOCK_RE.sub("", cleaned)
    return _PERSON_MEMORY_BLOCK_RE.sub("", cleaned)
