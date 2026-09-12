"""Measure wall time spent in LangChain SummarizationMiddleware (before_model)."""

from __future__ import annotations

import time
from contextvars import ContextVar
from typing import Any

try:
    from typing import override
except ImportError:
    from typing import override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langgraph.runtime import Runtime

_t0: ContextVar[float | None] = ContextVar("evoflow_summarization_t0", default=None)


class SummarizationTimingStartMiddleware(AgentMiddleware[AgentState]):
    """Place immediately before ``SummarizationMiddleware``."""

    state_schema = AgentState

    @override
    def before_model(self, state: AgentState, runtime: Runtime) -> dict[str, Any] | None:  # noqa: ARG002
        _t0.set(time.perf_counter())
        return None

    @override
    async def abefore_model(self, state: AgentState, runtime: Runtime) -> dict[str, Any] | None:
        return self.before_model(state, runtime)


class SummarizationTimingEndMiddleware(AgentMiddleware[AgentState]):
    """Place immediately after ``SummarizationMiddleware``."""

    state_schema = AgentState

    @override
    def before_model(self, state: AgentState, runtime: Runtime) -> dict[str, Any] | None:  # noqa: ARG002
        t0 = _t0.get()
        if t0 is None:
            return None
        elapsed_ms = (time.perf_counter() - t0) * 1000.0
        _t0.set(None)
        if elapsed_ms < 5.0:
            return None
        try:
            from evoflow.observability.run_latency_trace import record_phase

            record_phase("summarization_before_model_ms", elapsed_ms)
        except Exception:
            pass
        return None

    @override
    async def abefore_model(self, state: AgentState, runtime: Runtime) -> dict[str, Any] | None:
        return self.before_model(state, runtime)
