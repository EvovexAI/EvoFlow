"""Write end-to-end collaboration lifecycle logs to a dedicated file."""

from __future__ import annotations

import json
import time
from collections.abc import Awaitable, Callable
from typing import Any

try:
    from typing import override
except ImportError:
    from typing import override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langchain.agents.middleware.types import ModelCallResult, ModelRequest, ModelResponse, ToolCallRequest
from langchain_core.messages import AIMessage, ToolMessage
from langgraph.types import Command

from evoflow.agents.middlewares.collab_cycle_trace_logging import write_cycle_trace
from evoflow.collab.thread_collab import load_merged_collab_phase
from evoflow.config.paths import get_paths


def _ctx(runtime_or_request: Any) -> dict[str, Any]:
    raw = getattr(runtime_or_request, "context", None)
    if isinstance(raw, dict):
        return raw
    return {}


def _effective_collab_phase_for_trace(c: dict[str, Any]) -> str:
    tid = str(c.get("thread_id") or "").strip()
    if tid:
        return load_merged_collab_phase(get_paths(), tid, c.get("collab_phase"))
    return str(c.get("collab_phase") or "")


def _msg_text(content: Any, max_len: int = 800) -> str:
    if isinstance(content, str):
        s = content
    elif isinstance(content, list):
        parts: list[str] = []
        for x in content:
            if isinstance(x, str):
                parts.append(x)
            elif isinstance(x, dict) and isinstance(x.get("text"), str):
                parts.append(x["text"])
        s = "".join(parts)
    else:
        s = str(content or "")
    s = s.strip()
    if len(s) > max_len:
        return s[: max_len - 3] + "..."
    return s


def _tool_names(tools: Any) -> list[str]:
    out: list[str] = []
    for t in tools or []:
        name = str(getattr(t, "name", "") or "").strip()
        if name:
            out.append(name)
    return sorted(set(out))


def _tool_call_names(tool_calls: Any) -> list[str]:
    out: list[str] = []
    for tc in tool_calls or []:
        if isinstance(tc, dict):
            name = str(tc.get("name", "")).strip()
        else:
            name = str(getattr(tc, "name", "")).strip()
        if name:
            out.append(name)
    return out


def _ai_message_from_model_call_result(result: Any) -> AIMessage | None:
    """Resolve the assistant turn from ``wrap_model_call`` return value.

    LangChain's ``ModelResponse`` exposes ``result: list[BaseMessage]``, not a bare
    ``AIMessage``. Older paths may return ``AIMessage`` directly.
    """
    if result is None:
        return None
    if isinstance(result, AIMessage):
        return result
    inner = getattr(result, "result", None)
    if isinstance(inner, AIMessage):
        return inner
    if isinstance(inner, list):
        for m in reversed(inner):
            if isinstance(m, AIMessage):
                return m
    return None


def _structured_response_preview(result: Any, max_len: int = 800) -> str:
    if result is None or not hasattr(result, "structured_response"):
        return ""
    sr = getattr(result, "structured_response", None)
    if sr is None:
        return ""
    try:
        s = json.dumps(sr, ensure_ascii=False) if not isinstance(sr, str) else sr
    except Exception:
        s = str(sr)
    s = s.strip()
    if len(s) > max_len:
        return s[: max_len - 3] + "..."
    return s


def _tool_calls_from_ai_message(ai: Any) -> list[Any]:
    """Prefer normalized ``tool_calls``; fall back to OpenAI-style ``additional_kwargs.tool_calls``.

    Some chat models populate raw function calls only under ``additional_kwargs`` until the
    message is merged into graph state, which makes ``after_model`` look richer than an immediate
    ``model_response`` snapshot unless we read both.
    """
    tcs = list(getattr(ai, "tool_calls", None) or [])
    if tcs:
        return tcs
    ak = getattr(ai, "additional_kwargs", None) or {}
    if not isinstance(ak, dict):
        return []
    raw = ak.get("tool_calls")
    if not isinstance(raw, list) or not raw:
        return []
    coerced: list[dict[str, Any]] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        fn = item.get("function")
        name = ""
        if isinstance(fn, dict):
            name = str(fn.get("name", "") or "").strip()
        tid = str(item.get("id", "") or "").strip()
        if not name:
            continue
        args: dict[str, Any] = {}
        if isinstance(fn, dict):
            arg_raw = fn.get("arguments", "{}")
            if isinstance(arg_raw, str) and arg_raw.strip():
                try:
                    parsed = json.loads(arg_raw)
                    if isinstance(parsed, dict):
                        args = parsed
                except Exception:
                    pass
            elif isinstance(arg_raw, dict):
                args = arg_raw
        coerced.append({"name": name, "args": args, "id": tid})
    return coerced


class CollabCycleTraceMiddleware(AgentMiddleware[AgentState]):
    state_schema = AgentState

    def _log(self, event: str, payload: dict[str, Any]) -> None:
        write_cycle_trace(event, payload)

    @override
    def before_model(self, state: AgentState, runtime) -> dict[str, Any] | None:
        messages = state.get("messages") or []
        last = messages[-1] if messages else None
        c = _ctx(runtime)
        tid = str(c.get("thread_id") or "").strip()
        self._log(
            "before_model",
            {
                "thread_id": tid,
                "collab_phase": _effective_collab_phase_for_trace(c),
                "message_count": len(messages),
                "last_message_type": getattr(last, "type", type(last).__name__ if last is not None else ""),
                "last_user_preview": _msg_text(getattr(last, "content", "")) if getattr(last, "type", "") == "human" else "",
            },
        )
        return None

    @override
    async def abefore_model(self, state: AgentState, runtime) -> dict[str, Any] | None:
        return self.before_model(state, runtime)

    @override
    def wrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], ModelResponse],
    ) -> ModelCallResult:
        c = _ctx(request.runtime)
        start = time.time()
        req_tools = _tool_names(request.tools)
        self._log(
            "model_request",
            {
                "thread_id": str(c.get("thread_id") or ""),
                "collab_phase": _effective_collab_phase_for_trace(c),
                "model_request_tools_count": len(req_tools),
                "model_request_tools": req_tools,
            },
        )
        result = handler(request)
        elapsed_ms = round((time.time() - start) * 1000, 2)
        ai = _ai_message_from_model_call_result(result)
        tool_calls = _tool_calls_from_ai_message(ai) if ai is not None else []
        invalid_calls = list(getattr(ai, "invalid_tool_calls", None) or []) if ai is not None else []
        preview = _msg_text(getattr(ai, "content", "")) if ai is not None else ""
        if not preview:
            preview = _structured_response_preview(result)
        self._log(
            "model_response",
            {
                "thread_id": str(c.get("thread_id") or ""),
                "collab_phase": _effective_collab_phase_for_trace(c),
                "elapsed_ms": elapsed_ms,
                "response_tool_calls": _tool_call_names(tool_calls),
                "response_tool_calls_count": len(tool_calls),
                "invalid_tool_calls_count": len(invalid_calls),
                "ai_preview": preview,
            },
        )
        return result

    @override
    async def awrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], Awaitable[ModelResponse]],
    ) -> ModelCallResult:
        c = _ctx(request.runtime)
        start = time.time()
        req_tools = _tool_names(request.tools)
        self._log(
            "model_request",
            {
                "thread_id": str(c.get("thread_id") or ""),
                "collab_phase": _effective_collab_phase_for_trace(c),
                "model_request_tools_count": len(req_tools),
                "model_request_tools": req_tools,
                "async": True,
            },
        )
        result = await handler(request)
        elapsed_ms = round((time.time() - start) * 1000, 2)
        ai = _ai_message_from_model_call_result(result)
        tool_calls = _tool_calls_from_ai_message(ai) if ai is not None else []
        invalid_calls = list(getattr(ai, "invalid_tool_calls", None) or []) if ai is not None else []
        preview = _msg_text(getattr(ai, "content", "")) if ai is not None else ""
        if not preview:
            preview = _structured_response_preview(result)
        self._log(
            "model_response",
            {
                "thread_id": str(c.get("thread_id") or ""),
                "collab_phase": _effective_collab_phase_for_trace(c),
                "elapsed_ms": elapsed_ms,
                "response_tool_calls": _tool_call_names(tool_calls),
                "response_tool_calls_count": len(tool_calls),
                "invalid_tool_calls_count": len(invalid_calls),
                "ai_preview": preview,
                "async": True,
            },
        )
        return result

    @override
    def after_model(self, state: AgentState, runtime) -> dict[str, Any] | None:
        c = _ctx(runtime)
        messages = state.get("messages") or []
        last = messages[-1] if messages else None
        if isinstance(last, AIMessage):
            tc = list(getattr(last, "tool_calls", None) or [])
            self._log(
                "after_model",
                {
                    "thread_id": str(c.get("thread_id") or ""),
                    "collab_phase": _effective_collab_phase_for_trace(c),
                    "final_ai_tool_calls": _tool_call_names(tc),
                    "final_ai_tool_calls_count": len(tc),
                    "final_ai_preview": _msg_text(getattr(last, "content", "")),
                },
            )
        return None

    @override
    async def aafter_model(self, state: AgentState, runtime) -> dict[str, Any] | None:
        return self.after_model(state, runtime)

    @override
    def wrap_tool_call(
        self,
        request: ToolCallRequest,
        handler: Callable[[ToolCallRequest], ToolMessage | Command],
    ) -> ToolMessage | Command:
        c = _ctx(request.runtime)
        tool_call = request.tool_call or {}
        name = str(tool_call.get("name") or "")
        tool_call_id = str(tool_call.get("id") or "")
        start = time.time()
        self._log(
            "tool_start",
            {
                "thread_id": str(c.get("thread_id") or ""),
                "collab_phase": _effective_collab_phase_for_trace(c),
                "tool_name": name,
                "tool_call_id": tool_call_id,
            },
        )
        result = handler(request)
        elapsed_ms = round((time.time() - start) * 1000, 2)
        self._log(
            "tool_end",
            {
                "thread_id": str(c.get("thread_id") or ""),
                "collab_phase": _effective_collab_phase_for_trace(c),
                "tool_name": name,
                "tool_call_id": tool_call_id,
                "elapsed_ms": elapsed_ms,
                "result_type": type(result).__name__,
                "result_preview": _msg_text(getattr(result, "content", result)),
            },
        )
        return result

    @override
    async def awrap_tool_call(
        self,
        request: ToolCallRequest,
        handler: Callable[[ToolCallRequest], Awaitable[ToolMessage | Command]],
    ) -> ToolMessage | Command:
        c = _ctx(request.runtime)
        tool_call = request.tool_call or {}
        name = str(tool_call.get("name") or "")
        tool_call_id = str(tool_call.get("id") or "")
        start = time.time()
        self._log(
            "tool_start",
            {
                "thread_id": str(c.get("thread_id") or ""),
                "collab_phase": _effective_collab_phase_for_trace(c),
                "tool_name": name,
                "tool_call_id": tool_call_id,
                "async": True,
            },
        )
        result = await handler(request)
        elapsed_ms = round((time.time() - start) * 1000, 2)
        self._log(
            "tool_end",
            {
                "thread_id": str(c.get("thread_id") or ""),
                "collab_phase": _effective_collab_phase_for_trace(c),
                "tool_name": name,
                "tool_call_id": tool_call_id,
                "elapsed_ms": elapsed_ms,
                "result_type": type(result).__name__,
                "result_preview": _msg_text(getattr(result, "content", result)),
                "async": True,
            },
        )
        return result
