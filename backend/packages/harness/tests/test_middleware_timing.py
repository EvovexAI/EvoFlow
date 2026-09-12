"""Middleware timing framework: threshold + wrap pre-handler only."""

from __future__ import annotations

import inspect

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware

from evoflow.agents.middlewares.middleware_timing import (
    _MARK,
    instrument_middleware_timing,
)


class _SlowBefore(AgentMiddleware[AgentState]):
    state_schema = AgentState
    name = "SlowBefore"

    def before_model(self, state, runtime):  # noqa: ANN001
        import time

        time.sleep(0.02)
        return None


class _WrapPre(AgentMiddleware[AgentState]):
    state_schema = AgentState
    name = "WrapPre"

    def wrap_model_call(self, request, handler):  # noqa: ANN001
        import time

        time.sleep(0.02)
        return handler(request)


def test_instrument_logs_slow_before_model(capsys, monkeypatch):
    monkeypatch.setenv("EVOFLOW_MW_TIMING_MS", "5")
    mw = _SlowBefore()
    instrument_middleware_timing([mw])
    assert getattr(mw, _MARK) is True
    mw.before_model({}, None)
    out = capsys.readouterr().out
    assert "mw.SlowBefore.before_model=" in out


def test_instrument_skips_fast_hooks(capsys, monkeypatch):
    monkeypatch.setenv("EVOFLOW_MW_TIMING_MS", "50")
    mw = _SlowBefore()
    instrument_middleware_timing([mw])
    mw.before_model({}, None)
    out = capsys.readouterr().out
    assert "mw.SlowBefore" not in out


def test_wrap_logs_pre_only(capsys, monkeypatch):
    monkeypatch.setenv("EVOFLOW_MW_TIMING_MS", "5")
    mw = _WrapPre()
    instrument_middleware_timing([mw])

    def handler(_req):
        import time

        time.sleep(0.05)
        return "ok"

    assert mw.wrap_model_call(object(), handler) == "ok"
    out = capsys.readouterr().out
    assert "mw.WrapPre.wrap_model_call.pre=" in out


def test_disable_with_minus_one(monkeypatch):
    monkeypatch.setenv("EVOFLOW_MW_TIMING_MS", "-1")
    mw = _SlowBefore()
    instrument_middleware_timing([mw])
    assert not getattr(mw, _MARK, False)


def test_preserves_runtime_in_signature(monkeypatch):
    """LangGraph injects ``runtime`` via inspect.signature — must not become *args."""
    monkeypatch.setenv("EVOFLOW_MW_TIMING_MS", "3")
    mw = _SlowBefore()
    instrument_middleware_timing([mw])
    sig = inspect.signature(mw.before_model)
    assert "runtime" in sig.parameters
    # Simulate Pregel calling the underlying function with (self, state, runtime).
    fn = mw.before_model.__func__  # type: ignore[attr-defined]
    fn(mw, {}, object())


def test_before_agent_emits_enter_exit(monkeypatch):
    monkeypatch.setenv("EVOFLOW_MW_TIMING_MS", "50")
    events: list[tuple[str, dict]] = []

    def fake_write(tid, event, payload=None, *, trace_id=None):  # noqa: ANN001
        del tid, trace_id
        events.append((event, dict(payload or {})))

    monkeypatch.setattr(
        "evoflow.observability.run_latency_trace.write_run_latency_event",
        fake_write,
    )
    monkeypatch.setattr(
        "evoflow.agents.middlewares.middleware_timing._resolve_tid_trace",
        lambda: ("t-blind", "tr"),
    )

    class _BeforeAgentProbe(AgentMiddleware[AgentState]):
        state_schema = AgentState
        name = "BeforeAgentProbe"

        def before_agent(self, state, runtime):  # noqa: ANN001
            return None

    mw = _BeforeAgentProbe()
    instrument_middleware_timing([mw])
    mw.before_agent({}, None)
    names = [e for e, _ in events]
    assert "mw_hook_enter" in names
    assert "mw_hook_exit" in names
    enter = next(p for e, p in events if e == "mw_hook_enter")
    assert enter["mw"] == "BeforeAgentProbe"
    assert enter["seq"] == 0
