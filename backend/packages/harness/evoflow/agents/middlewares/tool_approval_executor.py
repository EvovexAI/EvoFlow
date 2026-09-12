"""Execute one approved tool call outside the model loop (replay)."""

from __future__ import annotations

import asyncio
import inspect
import json
import logging
from dataclasses import dataclass
from typing import Any

from langchain_core.messages import ToolMessage
from langchain_core.tools import BaseTool

from evoflow.agents.lead_agent.runtime_context import LeadAgentRuntimeContext
from evoflow.agents.middlewares.tool_timeout_middleware import _timeout_for_tool
from evoflow.agents.tool_approval_denylist import is_dangerous
from evoflow.agents.tool_approval_trace_log import log_tool_approval_trace

logger = logging.getLogger(__name__)


@dataclass
class SimpleToolRuntime:
    """Minimal runtime for host_direct tools during approval replay."""

    context: LeadAgentRuntimeContext
    tool_call_id: str = ""
    state: dict[str, Any] | None = None
    config: dict[str, Any] | None = None
    store: Any = None

    def __post_init__(self) -> None:
        if self.state is None:
            self.state = {}
        if self.config is None:
            tid = str(getattr(self.context, "thread_id", None) or "").strip()
            self.config = {"configurable": {"thread_id": tid}} if tid else {}

    @staticmethod
    def stream_writer(_event: Any = None) -> None:
        return None


def _build_tool_runtime(ctx: LeadAgentRuntimeContext, *, tool_call_id: str) -> Any:
    """Prefer LangChain ToolRuntime so injected ``runtime`` params type-check."""
    tid = str(ctx.thread_id or "").strip()
    config = {"configurable": {"thread_id": tid}} if tid else {}
    try:
        from langchain.tools import ToolRuntime

        return ToolRuntime(
            state={},
            context=ctx,
            config=config,
            stream_writer=lambda _event: None,
            tool_call_id=tool_call_id,
            store=None,
        )
    except Exception:
        return SimpleToolRuntime(context=ctx, tool_call_id=tool_call_id, config=config)


def _tool_result_content(raw: Any) -> str:
    if raw is None:
        return ""
    if isinstance(raw, str):
        return raw
    if isinstance(raw, ToolMessage):
        return str(raw.content or "")
    if isinstance(raw, (dict, list)):
        return json.dumps(raw, ensure_ascii=False, default=str)
    return str(raw)


def _resolve_tools(ctx: LeadAgentRuntimeContext) -> dict[str, BaseTool]:
    from evoflow.tools import get_available_tools

    tools_mode = str(ctx.tools_mode or "").strip() or None
    subagent = bool(ctx.subagent_enabled) if ctx.subagent_enabled is not None else False
    include_search = True
    loaded = get_available_tools(
        model_name=ctx.model_name or ctx.primary_model_name,
        subagent_enabled=subagent,
        include_search=include_search,
        tools_mode=tools_mode,
    )
    return {str(getattr(t, "name", "") or ""): t for t in loaded if getattr(t, "name", None)}


async def aexecute_approved_tool_entry(
    entry: dict[str, Any],
    *,
    runtime_context: dict[str, Any] | LeadAgentRuntimeContext | None = None,
) -> ToolMessage:
    tool_name = str(entry.get("tool_name") or "").strip()
    tc_id = str(entry.get("tool_call_id") or "").strip()
    args = dict(entry.get("args") or {}) if isinstance(entry.get("args"), dict) else {}
    _ctx_tid = ""
    if isinstance(runtime_context, LeadAgentRuntimeContext):
        _ctx_tid = str(runtime_context.thread_id or "")
    elif isinstance(runtime_context, dict):
        _ctx_tid = str(runtime_context.get("thread_id") or "")

    log_tool_approval_trace(
        "工具执行层·aexecute_approved_tool_entry开始",
        thread_id=_ctx_tid, side="工具执行",
        event_data={
            "tool_call_id": tc_id,
            "tool_name": tool_name,
            "args_preview": str(args)[:200],
            "entry_status": str(entry.get("status") or ""),
            "runtime_context_type": type(runtime_context).__name__,
        },
    )

    if isinstance(runtime_context, LeadAgentRuntimeContext):
        ctx = runtime_context
    else:
        ctx = LeadAgentRuntimeContext.from_mapping(runtime_context if isinstance(runtime_context, dict) else {})

    tools_by_name = _resolve_tools(ctx)
    tool = tools_by_name.get(tool_name)
    if tool is None:
        log_tool_approval_trace(
            "工具执行层·工具未找到，返回错误",
            thread_id=_ctx_tid, side="工具执行",
            event_data={"tool_call_id": tc_id, "tool_name": tool_name,
                        "available_count": len(tools_by_name)},
        )
        return ToolMessage(
            content=json.dumps(
                {
                    "_evoflow_tool": {"status": "error"},
                    "message": f"工具 {tool_name} 不可用，无法执行已批准的调用。",
                },
                ensure_ascii=False,
            ),
            tool_call_id=tc_id,
            name=tool_name or "tool",
        )

    # Defense in depth: re-check denylist at replay time
    blocked, reason = is_dangerous(tool_name, args)
    if blocked:
        log_tool_approval_trace(
            "工具执行层·被安全策略阻止",
            thread_id=_ctx_tid, side="工具执行",
            event_data={"tool_call_id": tc_id, "tool_name": tool_name, "reason": reason},
        )
        return ToolMessage(
            content=json.dumps(
                {
                    "_evoflow_tool": {"status": "blocked"},
                    "message": f"此工具调用已被安全策略阻止：{reason}。",
                },
                ensure_ascii=False,
            ),
            tool_call_id=tc_id,
            name=tool_name,
        )

    runtime = _build_tool_runtime(ctx, tool_call_id=tc_id)
    timeout = _timeout_for_tool(tool_name)
    log_tool_approval_trace(
        "工具执行层·开始执行工具",
        thread_id=_ctx_tid, side="工具执行",
        event_data={"tool_call_id": tc_id, "tool_name": tool_name, "timeout_s": timeout},
    )
    try:
        raw = await asyncio.wait_for(_ainvoke_tool(tool, args, runtime=runtime), timeout=timeout)
        content = _tool_result_content(raw)
        log_tool_approval_trace(
            "工具执行层·执行成功",
            thread_id=_ctx_tid, side="工具执行",
            event_data={"tool_call_id": tc_id, "tool_name": tool_name,
                        "result_preview": content[:300]},
        )
        envelope = {
            "_evoflow_tool": {"status": "ok"},
            "message": content,
        }
        return ToolMessage(
            content=json.dumps(envelope, ensure_ascii=False),
            tool_call_id=tc_id,
            name=tool_name,
        )
    except TimeoutError:
        logger.error("Tool approval replay timed out: %s (%s) after %ds", tool_name, tc_id, timeout)
        log_tool_approval_trace(
            "工具执行层·执行超时",
            thread_id=_ctx_tid, side="工具执行",
            event_data={"tool_call_id": tc_id, "tool_name": tool_name, "timeout_s": timeout},
        )
        return ToolMessage(
            content=json.dumps(
                {
                    "_evoflow_tool": {"status": "error"},
                    "message": f"执行超时（{timeout}秒），请尝试更简单的操作。",
                },
                ensure_ascii=False,
            ),
            tool_call_id=tc_id,
            name=tool_name,
        )
    except Exception as exc:
        logger.exception("tool approval replay failed: %s (%s)", tool_name, tc_id)
        log_tool_approval_trace(
            "工具执行层·执行异常",
            thread_id=_ctx_tid, side="工具执行",
            event_data={"tool_call_id": tc_id, "tool_name": tool_name, "error": str(exc)},
        )
        return ToolMessage(
            content=json.dumps(
                {
                    "_evoflow_tool": {"status": "error"},
                    "message": f"执行失败：{exc}",
                },
                ensure_ascii=False,
            ),
            tool_call_id=tc_id,
            name=tool_name,
        )


async def _ainvoke_tool(tool: BaseTool, args: dict[str, Any], *, runtime: Any) -> Any:
    """Invoke tool for approval replay.

    Host-direct tools require injected ``runtime`` / ``tool_call_id``. ``ainvoke`` cannot
    inject ``ToolRuntime``, so prefer calling the underlying ``func``/``coroutine`` when
    those parameters exist.
    """
    invoke_args = dict(args)
    tc_id = str(getattr(runtime, "tool_call_id", "") or "").strip() or "replay"
    fn = getattr(tool, "coroutine", None) or getattr(tool, "func", None)
    if fn is not None:
        try:
            sig = inspect.signature(fn)
        except (TypeError, ValueError):
            sig = None
        if sig is not None and ("runtime" in sig.parameters or "tool_call_id" in sig.parameters):
            kwargs = dict(invoke_args)
            if "runtime" in sig.parameters:
                kwargs["runtime"] = runtime
            if "tool_call_id" in sig.parameters:
                kwargs["tool_call_id"] = tc_id
            if inspect.iscoroutinefunction(fn):
                return await fn(**kwargs)
            return await asyncio.to_thread(fn, **kwargs)

    tool_call_payload = {
        "type": "tool_call",
        "name": str(getattr(tool, "name", "") or ""),
        "args": invoke_args,
        "id": tc_id,
    }
    config = getattr(runtime, "config", None) or {
        "configurable": {"thread_id": getattr(getattr(runtime, "context", None), "thread_id", None)}
    }
    if hasattr(tool, "ainvoke"):
        return await tool.ainvoke(tool_call_payload, config=config)
    if fn is None:
        raise RuntimeError(f"no invoker on tool {tool.name}")
    if inspect.iscoroutinefunction(fn):
        return await fn(**invoke_args)
    return await asyncio.to_thread(fn, **invoke_args)


def execute_approved_tool_entry(
    entry: dict[str, Any],
    *,
    runtime_context: dict[str, Any] | LeadAgentRuntimeContext | None = None,
) -> ToolMessage:
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = None
    if loop is not None and loop.is_running():
        raise RuntimeError("execute_approved_tool_entry cannot run inside active loop; use aexecute_approved_tool_entry")
    # Use a fresh loop but properly shut down async generators first.
    _loop = asyncio.new_event_loop()
    asyncio.set_event_loop(_loop)
    try:
        return _loop.run_until_complete(
            aexecute_approved_tool_entry(entry, runtime_context=runtime_context)
        )
    finally:
        try:
            _loop.run_until_complete(_loop.shutdown_asyncgens())
        except Exception:
            pass
        try:
            _loop.run_until_complete(_loop.shutdown_default_executor())
        except Exception:
            pass
        _loop.close()
        asyncio.set_event_loop(None)
