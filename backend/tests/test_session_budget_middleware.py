"""SessionBudgetMiddleware: budgets off by default; opt-in soft-land only when enabled."""

from __future__ import annotations

from types import SimpleNamespace

from langchain_core.messages import HumanMessage, ToolMessage

from evoflow.agents.middlewares import session_budget_middleware as sbm
from evoflow.agents.middlewares.session_budget_middleware import SessionBudgetMiddleware


def _runtime(session_key: str = "chat:test-session") -> SimpleNamespace:
    return SimpleNamespace(
        context={"session_key": session_key},
        config={"configurable": {"session_key": session_key}},
    )


def _state(text: str = "please research the knowledge base") -> dict:
    return {"messages": [HumanMessage(content=text, id="u1")]}


def _request(name: str, *, runtime: SimpleNamespace, call_id: str = "tc1") -> SimpleNamespace:
    return SimpleNamespace(
        tool_call={"name": name, "id": call_id, "args": {}},
        runtime=runtime,
    )


def test_defaults_do_not_inject_wrap_up_or_block(monkeypatch):
    """Numeric + wrap-up limits are off; long remakes must not get 收尾交班 nudges."""
    assert sbm._BUDGET_ENABLED is False
    assert sbm._RECURSION_SOFT_ENABLED is False

    mw = SessionBudgetMiddleware()
    runtime = _runtime()
    monkeypatch.setattr(sbm, "_langgraph_step_budget", lambda: (99990, 100000))

    assert mw.before_model(_state(), runtime) is None
    assert mw.after_model(_state(), runtime) is None
    assert mw._maybe_block(_request("bash", runtime=runtime)) is None


def test_recursion_soft_land_opt_in(monkeypatch):
    monkeypatch.setattr(sbm, "_RECURSION_SOFT_ENABLED", True)
    mw = SessionBudgetMiddleware()
    runtime = _runtime("chat:opt-in-soft")
    state = _state()

    monkeypatch.setattr(sbm, "_langgraph_step_budget", lambda: (7380, 7500))  # remaining 120
    out = mw.before_model(state, runtime)
    assert out is not None
    msg = out["messages"][0]
    assert isinstance(msg, HumanMessage)
    assert "请收尾" in msg.content

    assert mw.before_model(state, runtime) is None


def test_recursion_hard_land_opt_in_blocks_non_readonly(monkeypatch):
    monkeypatch.setattr(sbm, "_RECURSION_SOFT_ENABLED", True)
    mw = SessionBudgetMiddleware()
    runtime = _runtime("chat:hard-land")
    state = _state()

    monkeypatch.setattr(sbm, "_langgraph_step_budget", lambda: (7465, 7500))  # remaining 35
    out = mw.before_model(state, runtime)
    assert out is not None
    assert "强制收尾" in out["messages"][0].content

    blocked = mw._maybe_block(_request("bash", runtime=runtime, call_id="b1"))
    assert isinstance(blocked, ToolMessage)
    assert blocked.status == "error"
    assert "已拦截" in str(blocked.content)

    assert mw._maybe_block(_request("knowledge", runtime=runtime, call_id="k1")) is None
    assert mw._maybe_block(_request("read_file", runtime=runtime, call_id="r1")) is None
