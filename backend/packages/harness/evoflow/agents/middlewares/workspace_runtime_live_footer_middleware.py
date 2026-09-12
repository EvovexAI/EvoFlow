"""Inject current system clock into the system ``<workspace>`` block.

Path / OS / shell stay in ``<workspace>``. The live clock is upserted there on each
model call (not as a HumanMessage), so the user turn stays clean.
"""

from __future__ import annotations

import logging
import re
from typing import Any

try:
    from typing import override
except ImportError:
    from typing import override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langchain.agents.middleware.types import ModelCallResult, ModelRequest
from langchain_core.messages import BaseMessage, HumanMessage, SystemMessage, ToolMessage

logger = logging.getLogger(__name__)

_RUNTIME_CLOCK_MESSAGE_NAME = "session_runtime_clock"
_CLOCK_LINE_RE = re.compile(
    r"(?im)^[ \t]*(?:时间|Time|当前系统时间|Current system time)\s*:[^\n]*\n?",
)
_CLOCK_XML_RE = re.compile(
    r"<session_runtime_clock>[\s\S]*?</session_runtime_clock>\s*",
    re.IGNORECASE,
)
_WORKSPACE_RE = re.compile(r"(?is)(<workspace>)(.*?)(</workspace>)")


def _is_runtime_clock_message(msg: Any) -> bool:
    return isinstance(msg, (SystemMessage, HumanMessage, ToolMessage)) and getattr(
        msg, "name", None
    ) == _RUNTIME_CLOCK_MESSAGE_NAME


def _strip_runtime_clock_messages(messages: list[Any]) -> list[Any]:
    return [m for m in messages if not _is_runtime_clock_message(m)]


def _messages_from_request(request: ModelRequest) -> list[BaseMessage]:
    from evoflow.agents.middlewares.model_request_messages import messages_from_model_request

    return messages_from_model_request(request)


def strip_runtime_clock_lines_from_system_prompt(text: str) -> str:
    """Remove clock lines / legacy ``<session_runtime_clock>`` from system text."""
    out = str(text or "")
    out = _CLOCK_LINE_RE.sub("", out)
    out = _CLOCK_XML_RE.sub("\n", out)
    return re.sub(r"\n{3,}", "\n\n", out).rstrip()


def _clock_line(*, prompt_language: str | None) -> str:
    from evoflow.agents.lead_agent.prompt import format_runtime_now_for_prompt, resolve_prompt_language

    lang = resolve_prompt_language(prompt_language)
    now = format_runtime_now_for_prompt(prompt_language=lang)
    if str(lang or "").lower().startswith("zh"):
        return f"时间: {now}"
    return f"Time: {now}"


def inject_runtime_clock_into_workspace(system_text: str, clock_line: str) -> str:
    """Upsert the clock line inside ``<workspace>`` (or append a workspace block)."""
    base = strip_runtime_clock_lines_from_system_prompt(system_text)
    line = str(clock_line or "").strip()
    if not line:
        return base

    match = _WORKSPACE_RE.search(base)
    if not match:
        block = f"<workspace>\n{line}\n</workspace>"
        return f"{base}\n\n{block}".strip() if base else block

    inner = match.group(2)
    # Prefer placing clock after the first non-empty line (workspace path).
    lines = inner.splitlines()
    insert_at = 0
    for i, ln in enumerate(lines):
        if ln.strip():
            insert_at = i + 1
            break
    lines.insert(insert_at, line)
    # Keep a blank line after path+clock when the rest of the block has content.
    rest = lines[insert_at + 1 :]
    if rest and rest[0].strip() and lines[insert_at].strip():
        lines.insert(insert_at + 1, "")
    new_inner = "\n".join(lines)
    if not new_inner.startswith("\n"):
        new_inner = "\n" + new_inner
    if not new_inner.endswith("\n"):
        new_inner = new_inner + "\n"
    return base[: match.start()] + match.group(1) + new_inner + match.group(3) + base[match.end() :]


class WorkspaceRuntimeLiveFooterMiddleware(AgentMiddleware[AgentState]):
    """Upsert live clock into system ``<workspace>``; strip leftover clock HumanMessages."""

    state_schema = AgentState

    def _patch_request(self, request: ModelRequest) -> ModelRequest:
        try:
            from evoflow.agents.middlewares.dynamic_system_prompt_middleware import (
                _merged_runtime_context,
                _resolve_prompt_meta,
            )
        except Exception:
            return request

        ctx = _merged_runtime_context(request)
        meta = _resolve_prompt_meta(ctx)
        pl = ctx.get("prompt_language")
        if isinstance(meta, dict) and meta.get("prompt_language"):
            pl = meta.get("prompt_language")

        line = _clock_line(prompt_language=pl if isinstance(pl, str) else None)
        sm = request.system_message
        if sm is None:
            messages = _strip_runtime_clock_messages(_messages_from_request(request))
            if len(messages) != len(_messages_from_request(request)):
                return request.override(messages=messages)
            return request

        raw = str(getattr(sm, "content", "") or "")
        patched = inject_runtime_clock_into_workspace(raw, line)
        messages = _strip_runtime_clock_messages(_messages_from_request(request))
        overrides: dict[str, Any] = {}
        if patched != raw:
            overrides["system_message"] = sm.model_copy(update={"content": patched})
            logger.debug(
                "WorkspaceRuntimeLiveFooter: injected clock into <workspace> chars=%d",
                len(line),
            )
        if len(messages) != len(_messages_from_request(request)):
            overrides["messages"] = messages
        if not overrides:
            return request
        return request.override(**overrides)

    @override
    def wrap_model_call(self, request: ModelRequest, handler) -> ModelCallResult:
        return handler(self._patch_request(request))

    @override
    async def awrap_model_call(self, request: ModelRequest, handler) -> ModelCallResult:
        return await handler(self._patch_request(request))
