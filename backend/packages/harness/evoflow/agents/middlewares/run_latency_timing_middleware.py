"""Wall-clock tracing for pre-model work and wrap_model_call entry."""

from __future__ import annotations

import time
from typing import Any

try:
    from typing import override
except ImportError:
    from typing import override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langchain.agents.middleware.types import ModelCallResult, ModelRequest, ToolCallRequest
from langchain_core.messages import ToolMessage
from langgraph.runtime import Runtime
from langgraph.types import Command

from evoflow.observability.agent_activity_stream import emit_agent_activity
from evoflow.observability.run_latency_trace import (
    begin_model_cycle,
    bump_model_call_seq,
    clear_model_cycle,
    current_model_cycle_thread_id,
    mark_wrap_model_enter,
    read_configurable_trace_fields,
    write_run_latency_event,
)


def _resolve_thread_id(*, runtime: Any | None = None) -> str:
    tid, _, _ = read_configurable_trace_fields()
    if tid:
        return tid
    if runtime is not None:
        ctx = getattr(runtime, "context", None)
        if isinstance(ctx, dict):
            tid = str(ctx.get("thread_id") or "").strip()
            if tid:
                return tid
    tid = current_model_cycle_thread_id()
    if tid:
        return tid
    return ""


class RunLatencyCycleMiddleware(AgentMiddleware[AgentState]):
    """Start per-model-cycle wall clock at ``before_model`` (after checkpoint load)."""

    state_schema = AgentState

    @override
    def before_model(self, state: AgentState, runtime: Runtime) -> dict[str, Any] | None:
        tid, trace_id, user_ts = read_configurable_trace_fields()
        if not tid:
            ctx = getattr(runtime, "context", None) if runtime is not None else None
            if isinstance(ctx, dict):
                tid = str(ctx.get("thread_id") or "").strip()
        if not tid:
            return None
        messages = state.get("messages") or []
        run_id = None
        try:
            from langgraph.config import get_config

            cfg = get_config().get("configurable") or {}
            if isinstance(cfg, dict):
                run_id = str(cfg.get("run_id") or "").strip() or None
        except Exception:
            pass
        model_call_seq = bump_model_call_seq(tid, run_id)
        begin_model_cycle(
            thread_id=tid,
            trace_id=trace_id,
            user_input_ts_ms=user_ts,
            model_call_seq=model_call_seq,
            message_count=len(messages) if isinstance(messages, list) else None,
        )
        # before_model：图已跑起来但还没打到厂商 — 用「准备中…」（勿标「生成中」）。
        # 「生成中…」只在 wrap_model_call（真正发起模型请求）时推送。
        try:
            emit_agent_activity(tid, kind="pre_model", detail="准备中…", force=True)
        except Exception:
            # 活动事件只是 UI 提示，失败不应影响正常推理
            pass
        return None

    @override
    async def abefore_model(self, state: AgentState, runtime: Runtime) -> dict[str, Any] | None:
        return self.before_model(state, runtime)


class RunLatencyWrapMiddleware(AgentMiddleware[AgentState]):
    """Flush pre-model breakdown at ``wrap_model_call`` and note handler return."""

    state_schema = AgentState

    @override
    def wrap_model_call(self, request: ModelRequest, handler) -> ModelCallResult:
        mark_wrap_model_enter()
        tid = _resolve_thread_id(runtime=getattr(request, "runtime", None))
        if tid:
            emit_agent_activity(tid, kind="model", detail="生成中…", force=True)
        t0 = time.perf_counter()
        try:
            return handler(request)
        finally:
            tid, trace_id, _ = read_configurable_trace_fields()
            if tid:
                write_run_latency_event(
                    tid,
                    "model_handler_returned",
                    {"handler_ms": round((time.perf_counter() - t0) * 1000.0, 2)},
                    trace_id=trace_id,
                )
            clear_model_cycle()

    @override
    async def awrap_model_call(self, request: ModelRequest, handler) -> ModelCallResult:
        mark_wrap_model_enter()
        tid = _resolve_thread_id(runtime=getattr(request, "runtime", None))
        if tid:
            emit_agent_activity(tid, kind="model", detail="生成中…", force=True)
        t0 = time.perf_counter()
        try:
            return await handler(request)
        finally:
            tid, trace_id, _ = read_configurable_trace_fields()
            if tid:
                write_run_latency_event(
                    tid,
                    "model_handler_returned",
                    {"handler_ms": round((time.perf_counter() - t0) * 1000.0, 2)},
                    trace_id=trace_id,
                )
            clear_model_cycle()


class LiveActivityToolMiddleware(AgentMiddleware[AgentState]):
    """Push tool-execution phase hints into the live SSE stream."""

    state_schema = AgentState

    @staticmethod
    def _resolve_tid(request: ToolCallRequest) -> str:
        tid, _, _ = read_configurable_trace_fields()
        if tid:
            return tid
        runtime = getattr(request, "runtime", None)
        ctx = getattr(runtime, "context", None) if runtime is not None else None
        if isinstance(ctx, dict):
            tid = str(ctx.get("thread_id") or "").strip()
            if tid:
                return tid
        return ""

    @classmethod
    def _emit_tool_activity(cls, request: ToolCallRequest) -> str:
        tid = cls._resolve_tid(request)
        tool_call = request.tool_call or {}
        name = str(tool_call.get("name") or "").strip() or "tool"
        if not tid:
            return ""
        from evoflow.tools.tool_activity_ui import format_activity_detail_from_tool_calls

        tc_dict = dict(tool_call) if isinstance(tool_call, dict) else {"name": name}
        detail = format_activity_detail_from_tool_calls([tc_dict])
        emit_agent_activity(
            tid,
            kind="tools",
            detail=detail,
            tool_name=name,
            tool_calls=[tc_dict],
            force=True,
        )
        return tid

    @staticmethod
    def _emit_tool_finished(tid: str) -> None:
        """工具 handler 返回后，立刻推一条收尾事件，避免 UI 卡在「调用工具…」."""
        if not tid:
            return
        emit_agent_activity(
            tid,
            kind="thinking",
            detail="推理中",
            force=True,
        )

    @staticmethod
    def _tool_call_interrupted(exc: BaseException) -> bool:
        name = exc.__class__.__name__
        return name in {"GraphInterrupt", "Interrupt"}

    @override
    def wrap_tool_call(
        self,
        request: ToolCallRequest,
        handler,
    ) -> ToolMessage | Command:
        tid = self._emit_tool_activity(request)
        interrupted = False
        try:
            return handler(request)
        except BaseException as exc:
            if self._tool_call_interrupted(exc):
                interrupted = True
            raise
        finally:
            if not interrupted:
                self._emit_tool_finished(tid or self._resolve_tid(request))

    @override
    async def awrap_tool_call(
        self,
        request: ToolCallRequest,
        handler,
    ) -> ToolMessage | Command:
        tid = self._emit_tool_activity(request)
        interrupted = False
        try:
            return await handler(request)
        except BaseException as exc:
            if self._tool_call_interrupted(exc):
                interrupted = True
            raise
        finally:
            if not interrupted:
                self._emit_tool_finished(tid or self._resolve_tid(request))
