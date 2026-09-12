"""SessionBudgetMiddleware per-session tool budget isolation."""

from __future__ import annotations

from langchain_core.messages import AIMessage, HumanMessage

from evoflow.agents.lead_agent.runtime_context import LeadAgentRuntimeContext
from evoflow.agents.middlewares.session_budget_middleware import (
    SessionBudgetMiddleware,
    _BLOCK_MSG,
    _BUDGET_MSG_PREFIX,
    _effective_budget_key,
    _user_turn_token,
)


def _runtime(session_key: str, thread_id: str = "t1"):
    return type(
        "Rt",
        (),
        {"context": LeadAgentRuntimeContext(session_key=session_key, thread_id=thread_id)},
    )()


def _write_req(session_key: str, call_id: str = "call-1", thread_id: str = "t1"):
    return type(
        "Req",
        (),
        {
            "tool_call": {"name": "write", "id": call_id, "args": {"path": "a.py"}},
            "runtime": _runtime(session_key, thread_id),
        },
    )()


def test_effective_budget_key_prefers_session_key() -> None:
    runtime = _runtime("agent:main:abc", "thread-abc")
    assert _effective_budget_key(runtime) == "sk:agent:main:abc"


def test_effective_budget_key_reads_langgraph_configurable_when_runtime_none(monkeypatch) -> None:
    monkeypatch.setattr(
        "evoflow.agents.middlewares.session_budget_middleware._langgraph_configurable",
        lambda: {"session_key": "agent:main:new", "thread_id": "thread-new"},
    )
    assert _effective_budget_key(None) == "sk:agent:main:new"


def test_tool_budget_counts_are_per_session_not_shared_default_bucket() -> None:
    mw = SessionBudgetMiddleware()
    mw._tool_counts["sk:agent:main:a"] = 499
    mw._tool_counts["sk:agent:main:b"] = 0

    assert mw._maybe_block(_write_req("agent:main:a", "call-a", "t-a")) is None
    assert mw._maybe_block(_write_req("agent:main:b", "call-b", "t-b")) is None


def test_unresolved_budget_key_does_not_block() -> None:
    mw = SessionBudgetMiddleware()
    mw._tool_counts["default"] = 999
    req = type(
        "Req",
        (),
        {
            "tool_call": {"name": "write", "id": "call-x", "args": {}},
            "runtime": None,
        },
    )()
    assert mw._maybe_block(req) is None


def test_repeated_replace_failures_are_not_blocked() -> None:
    """Same-target failure throttling was removed — retries must still run."""
    mw = SessionBudgetMiddleware()
    args = {"path": "README.md", "old_string": "same"}
    blocked = mw._maybe_block(
        type(
            "Req",
            (),
            {
                "tool_call": {"name": "replace", "id": "call-retry", "args": args},
                "runtime": _runtime("agent:main:t2", "t2"),
            },
        )()
    )
    assert blocked is None


def test_user_turn_token_ignores_budget_nudge() -> None:
    msgs = [
        HumanMessage(content="先做 A", id="u1"),
        AIMessage(content="ok"),
        HumanMessage(content=f"{_BUDGET_MSG_PREFIX}] 提醒"),
    ]
    assert _user_turn_token(msgs) == "1:u1"


def test_tool_budget_resets_on_new_user_message() -> None:
    mw = SessionBudgetMiddleware()
    session_key = "agent:main:turn"
    budget_key = f"sk:{session_key}"
    runtime = _runtime(session_key)

    mw.before_model({"messages": [HumanMessage(content="第一轮", id="u1")]}, runtime)
    mw._tool_counts[budget_key] = 500
    mw._warned.add(budget_key)

    blocked = mw._maybe_block(_write_req(session_key, "call-hard"))
    assert blocked is not None
    assert "本轮消息" in str(blocked.content) or _BUDGET_MSG_PREFIX in str(blocked.content)

    mw.before_model(
        {
            "messages": [
                HumanMessage(content="第一轮", id="u1"),
                AIMessage(content="done"),
                HumanMessage(content="继续写文件", id="u2"),
            ]
        },
        runtime,
    )
    assert mw._tool_counts[budget_key] == 0
    assert budget_key not in mw._warned
    assert mw._maybe_block(_write_req(session_key, "call-after-reset")) is None


def test_same_user_turn_does_not_reset_count() -> None:
    mw = SessionBudgetMiddleware()
    session_key = "agent:main:same"
    budget_key = f"sk:{session_key}"
    runtime = _runtime(session_key)
    state = {"messages": [HumanMessage(content="同一轮", id="u9")]}

    mw.before_model(state, runtime)
    mw._tool_counts[budget_key] = 42
    mw.before_model(state, runtime)
    assert mw._tool_counts[budget_key] == 42
    assert _BLOCK_MSG.startswith(_BUDGET_MSG_PREFIX)
