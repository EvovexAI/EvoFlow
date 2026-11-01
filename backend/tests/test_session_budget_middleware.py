"""SessionBudgetMiddleware: tool hard-block + recursion soft-land before GraphRecursionError."""

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


def test_recursion_soft_land_injects_wrap_up_nudge(monkeypatch):
    mw = SessionBudgetMiddleware()
    runtime = _runtime()
    state = _state()

    monkeypatch.setattr(sbm, "_langgraph_step_budget", lambda: (7380, 7500))  # remaining 120
    out = mw.before_model(state, runtime)
    assert out is not None
    msg = out["messages"][0]
    assert isinstance(msg, HumanMessage)
    assert "请收尾" in msg.content
    assert "软预算" in msg.content

    # Once per user turn
    assert mw.before_model(state, runtime) is None


def test_recursion_hard_land_and_blocks_non_readonly(monkeypatch):
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

    # Readonly tools still pass through the block gate
    assert mw._maybe_block(_request("knowledge", runtime=runtime, call_id="k1")) is None
    assert mw._maybe_block(_request("read_file", runtime=runtime, call_id="r1")) is None


def test_recursion_soft_land_skipped_when_step_unknown(monkeypatch):
    mw = SessionBudgetMiddleware()
    runtime = _runtime("chat:unknown-step")
    monkeypatch.setattr(sbm, "_langgraph_step_budget", lambda: (None, 7500))
    assert mw.before_model(_state(), runtime) is None


def test_injected_recursion_nudge_does_not_reset_turn(monkeypatch):
    mw = SessionBudgetMiddleware()
    runtime = _runtime("chat:turn-stable")
    monkeypatch.setattr(sbm, "_langgraph_step_budget", lambda: (7380, 7500))

    state = _state("first user ask")
    assert mw.before_model(state, runtime) is not None
    # Simulate merge of soft-land HumanMessage into transcript
    state["messages"].append(HumanMessage(content=sbm._RECURSION_SOFT_MSG))
    mw._recursion_soft_warned.clear()  # force re-eval path through sync
    # Same user turn token → soft flag stays (already cleared above only for warn set);
    # sync must NOT treat the budget HumanMessage as a new user turn.
    turn_before = mw._turn_tokens.get("sk:chat:turn-stable")
    mw._sync_user_turn(state, runtime)
    assert mw._turn_tokens.get("sk:chat:turn-stable") == turn_before
