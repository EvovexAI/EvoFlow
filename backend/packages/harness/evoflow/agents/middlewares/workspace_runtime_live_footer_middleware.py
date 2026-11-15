"""Inject current system clock + active model into the system ``<workspace>`` block.

Path / OS / shell stay in ``<workspace>``. The live clock and the resolved model
name are upserted there on each model call (not as a HumanMessage), so the user
turn stays clean. The model line lets the agent know which model it is running
as (and why its capabilities differ from a previous turn after a model switch).
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
# Live per-turn lines upserted into <workspace>: the clock and the current model.
_LIVE_LINE_RE = re.compile(
    r"(?im)^[ \t]*(?:时间|Time|当前系统时间|Current system time|模型|Model)\s*:[^\n]*\n?",
)
_CLOCK_XML_RE = re.compile(
    r"<session_runtime_clock>[\s\S]*?</session_runtime_clock>\s*",
    re.IGNORECASE,
)
_WORKSPACE_RE = re.compile(r"(?is)(<workspace>)(.*?)(</workspace>)")


def _is_runtime_clock_message(msg: Any) -> bool:
    return isinstance(msg, (SystemMessage, HumanMessage, ToolMessage)) and getattr(msg, "name", None) == _RUNTIME_CLOCK_MESSAGE_NAME


def _strip_runtime_clock_messages(messages: list[Any]) -> list[Any]:
    return [m for m in messages if not _is_runtime_clock_message(m)]


def _messages_from_request(request: ModelRequest) -> list[BaseMessage]:
    from evoflow.agents.middlewares.model_request_messages import messages_from_model_request

    return messages_from_model_request(request)


def strip_runtime_clock_lines_from_system_prompt(text: str) -> str:
    """Remove clock / model live lines and legacy ``<session_runtime_clock>`` from system text."""
    out = str(text or "")
    out = _LIVE_LINE_RE.sub("", out)
    out = _CLOCK_XML_RE.sub("\n", out)
    return re.sub(r"\n{3,}", "\n\n", out).rstrip()


def _clock_line(*, prompt_language: str | None) -> str:
    from evoflow.agents.lead_agent.prompt import format_runtime_now_for_prompt, resolve_prompt_language

    lang = resolve_prompt_language(prompt_language)
    now = format_runtime_now_for_prompt(prompt_language=lang)
    if str(lang or "").lower().startswith("zh"):
        return f"时间: {now}"
    return f"Time: {now}"


def _extract_model_name(model_obj: Any) -> str:
    """Best-effort model-name read from the chat-model instance about to run.

    LangChain chat models carry the name on ``model_name`` (ChatOpenAI/ChatAnthropic
    and our vendor subclasses); some providers only expose ``model``. Empty string on miss.
    """
    for attr in ("model_name", "model", "deployment_name"):
        v = getattr(model_obj, attr, None) if model_obj is not None else None
        if isinstance(v, str) and v.strip():
            return v.strip()
        if isinstance(v, (list, tuple)) and v:
            first = v[0]
            if isinstance(first, str) and first.strip():
                return first.strip()
    return ""


def _model_line(*, request: ModelRequest, prompt_language: str | None, ctx: dict[str, Any]) -> str:
    """``模型: <name>`` live line. Ground truth is the model instance in the request;
    falls back to the runtime context name (only present when the session pinned it)."""
    from evoflow.agents.lead_agent.prompt import resolve_prompt_language

    lang = resolve_prompt_language(prompt_language)
    name = _extract_model_name(getattr(request, "model", None))
    if not name:
        name = str(ctx.get("model_name") or "").strip()
    if not name or name.lower() == "default":
        return ""
    if str(lang or "").lower().startswith("zh"):
        return f"模型: {name}"
    return f"Model: {name}"


def inject_runtime_lines_into_workspace(system_text: str, lines: list[str]) -> str:
    """Upsert the live lines (clock / model) inside ``<workspace>`` (or append a block).

    Stale live lines are stripped first so a mid-session model switch rewrites the
    model line instead of stacking. Lines land right after the workspace path line.
    """
    base = strip_runtime_clock_lines_from_system_prompt(system_text)
    clean = [str(ln or "").strip() for ln in lines]
    clean = [ln for ln in clean if ln]
    if not clean:
        return base

    match = _WORKSPACE_RE.search(base)
    if not match:
        block = "<workspace>\n" + "\n".join(clean) + "\n</workspace>"
        return f"{base}\n\n{block}".strip() if base else block

    inner = match.group(2)
    # Prefer placing the live lines after the first non-empty line (workspace path).
    inner_lines = inner.splitlines()
    insert_at = 0
    for i, ln in enumerate(inner_lines):
        if ln.strip():
            insert_at = i + 1
            break
    inner_lines[insert_at:insert_at] = clean
    # Keep a blank line after path+live lines when the rest of the block has content.
    rest = inner_lines[insert_at + len(clean):]
    if rest and rest[0].strip() and inner_lines[insert_at + len(clean) - 1].strip():
        inner_lines.insert(insert_at + len(clean), "")
    new_inner = "\n".join(inner_lines)
    if not new_inner.startswith("\n"):
        new_inner = "\n" + new_inner
    if not new_inner.endswith("\n"):
        new_inner = new_inner + "\n"
    return base[: match.start()] + match.group(1) + new_inner + match.group(3) + base[match.end() :]


def inject_runtime_clock_into_workspace(system_text: str, clock_line: str) -> str:
    """Back-compat wrapper: upsert a single clock line (no model line)."""
    return inject_runtime_lines_into_workspace(system_text, [clock_line])


class WorkspaceRuntimeLiveFooterMiddleware(AgentMiddleware[AgentState]):
    """Upsert live clock + active model into system ``<workspace>``; strip leftover clock HumanMessages."""

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
        pl = pl if isinstance(pl, str) else None

        line = _clock_line(prompt_language=pl)
        model_line = _model_line(request=request, prompt_language=pl, ctx=ctx)
        live_lines = [line] + ([model_line] if model_line else [])
        sm = request.system_message
        if sm is None:
            messages = _strip_runtime_clock_messages(_messages_from_request(request))
            if len(messages) != len(_messages_from_request(request)):
                return request.override(messages=messages)
            return request

        raw = str(getattr(sm, "content", "") or "")
        patched = inject_runtime_lines_into_workspace(raw, live_lines)
        messages = _strip_runtime_clock_messages(_messages_from_request(request))
        overrides: dict[str, Any] = {}
        if patched != raw:
            overrides["system_message"] = sm.model_copy(update={"content": patched})
            logger.debug(
                "WorkspaceRuntimeLiveFooter: injected %d live line(s) into <workspace>",
                len(live_lines),
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
