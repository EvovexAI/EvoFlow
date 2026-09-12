"""Mind map tool execution + live footer injection."""

from __future__ import annotations

import tempfile
from unittest.mock import MagicMock, patch

import pytest
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage

from evoflow.agents.middlewares.exploration_graph_live_footer_middleware import (
    ExplorationGraphLiveFooterMiddleware,
)
from evoflow.exploration_graph.mind_map_exec import execute_mind_map
from evoflow.persistence.exploration_graph_repositories import get_graph_header, get_node, list_ops
from evoflow.persistence.schema import ensure_app_schema
from evoflow.tools.arg_coerce import coerce_tool_call_args


@pytest.fixture(autouse=True)
def _mind_map_middleware_runtime(monkeypatch: pytest.MonkeyPatch):
    from evoflow.exploration_graph.config import load_exploration_graph_config_from_dict

    # Footer injection tests need inject on; production default is off for prompt-cache.
    load_exploration_graph_config_from_dict(
        {"enabled": True, "inject_into_model_payload": True, "return_snapshot_on_update": True}
    )
    monkeypatch.setattr("evoflow.agents.automation_runtime.is_unattended_automation", lambda _rt: False)


@pytest.fixture
def sqlite_tmp(monkeypatch: pytest.MonkeyPatch):
    with tempfile.TemporaryDirectory() as tmp:
        monkeypatch.setenv("EVOFLOW_HOME", tmp)
        from evoflow.persistence.db import get_db, reset_db_for_tests

        reset_db_for_tests()
        ensure_app_schema(get_db())
        yield
        reset_db_for_tests()
        import gc

        gc.collect()


def test_coerce_strips_legacy_mind_map_ops() -> None:
    out = coerce_tool_call_args(
        "read_file",
        {"path": "a.ts", "mind_map_ops": [{"op": "upsert_node", "id": "n1"}]},
    )
    assert "mind_map_ops" not in out
    assert out["path"] == "a.ts"


def test_mind_map_exec_applies_ops(sqlite_tmp: None) -> None:
    del sqlite_tmp
    out = execute_mind_map(
        [
            {"op": "set_goal", "title": "Read auth login.ts"},
            {"op": "upsert_node", "id": "file:auth/login.ts", "kind": "file", "title": "login"},
        ],
        thread_id="t-exec-1",
        tool_call_id="call-1",
    )
    assert out.startswith("OK:")
    assert "<session_mind_map>" in out
    node = get_node("t-exec-1", "file:auth/login.ts")
    assert node is not None
    assert node.title == "login"
    assert len(list_ops("t-exec-1", tool_call_id="call-1")) == 2


def test_mind_map_exec_query_returns_snapshot(sqlite_tmp: None) -> None:
    del sqlite_tmp
    execute_mind_map(
        [
            {"op": "set_goal", "title": "Query me"},
            {"op": "upsert_node", "id": "flow:q", "kind": "flow", "title": "Q"},
        ],
        thread_id="t-query-1",
        tool_call_id="call-q1",
    )
    out = execute_mind_map(None, thread_id="t-query-1", tool_call_id="call-q2", query=True)
    assert out.startswith("OK: mind map snapshot")
    assert "<session_mind_map>" in out
    assert "Query me" in out


def test_exploration_graph_live_footer_skips_when_inject_disabled(sqlite_tmp: None) -> None:
    del sqlite_tmp
    from langchain.agents.middleware.types import ModelRequest

    from evoflow.exploration_graph.config import load_exploration_graph_config_from_dict
    from evoflow.persistence.exploration_graph_repositories import apply_mind_map_ops

    load_exploration_graph_config_from_dict(
        {"enabled": True, "inject_into_model_payload": False}
    )
    tid = "t-no-inject"
    apply_mind_map_ops(
        tid,
        [{"op": "set_goal", "title": "No inject"}, {"op": "upsert_node", "id": "flow:n", "kind": "flow", "title": "N"}],
        tool_call_id="tc-ni",
    )
    mw = ExplorationGraphLiveFooterMiddleware()
    rt = MagicMock()
    rt.context = {"thread_id": tid}
    base_messages = [HumanMessage("question"), ToolMessage(content="ok", tool_call_id="t1", name="read")]
    req = ModelRequest(
        model=MagicMock(),
        messages=list(base_messages),
        tools=[],
        runtime=rt,
        state={"messages": list(base_messages)},
    )
    seen: list[list] = []

    def handler(r: ModelRequest):
        seen.append(list(r.messages or []))
        return MagicMock()

    with patch("langgraph.config.get_config", return_value={"configurable": {"thread_id": tid}}):
        mw.wrap_model_call(req, handler)

    assert seen
    assert len(seen[0]) == len(base_messages)
    assert not any(getattr(m, "name", None) == "session_mind_map" for m in seen[0])


def test_mind_map_exec_rejects_empty_ops_when_required(sqlite_tmp: None) -> None:
    del sqlite_tmp
    from evoflow.exploration_graph.config import load_exploration_graph_config_from_dict

    load_exploration_graph_config_from_dict({"require_mind_map_ops": True})
    out = execute_mind_map([], thread_id="t-reject-1", tool_call_id="call-x")
    assert "ops" in out.lower()
    assert list_ops("t-reject-1") == []


def test_mind_map_exec_applies_set_goal(sqlite_tmp: None) -> None:
    del sqlite_tmp
    out = execute_mind_map(
        [
            {"op": "set_goal", "title": "Read a.ts"},
            {"op": "upsert_node", "id": "note:1", "kind": "note", "body": "step"},
        ],
        thread_id="t-goal-run",
        tool_call_id="call-g",
    )
    assert out.startswith("OK:")
    header = get_graph_header("t-goal-run")
    assert header is not None
    assert header.goal == "Read a.ts"


def test_mind_map_exec_rejects_missing_goal_when_required(sqlite_tmp: None) -> None:
    del sqlite_tmp
    from evoflow.exploration_graph.config import load_exploration_graph_config_from_dict

    load_exploration_graph_config_from_dict({"require_mind_map_ops": True})
    out = execute_mind_map(
        [{"op": "upsert_node", "id": "note:step", "kind": "note", "body": "no goal"}],
        thread_id="t-no-goal",
        tool_call_id="call-g",
    )
    assert "no goal" in out.lower()
    assert get_node("t-no-goal", "note:step") is None


def test_mind_map_exec_rejects_missing_goal_by_default(sqlite_tmp: None) -> None:
    del sqlite_tmp
    from evoflow.exploration_graph.config import load_exploration_graph_config_from_dict

    load_exploration_graph_config_from_dict({"enabled": True, "require_mind_map_ops": False})
    out = execute_mind_map(
        [
            {"op": "patch_node", "id": "flow:x", "status": "resolved"},
            {"op": "upsert_node", "id": "test:y", "kind": "test", "parent": "flow:x"},
        ],
        thread_id="t-no-goal-default",
        tool_call_id="call-ng",
    )
    assert "set_goal" in out.lower()
    assert not out.startswith("OK:")
    assert get_graph_header("t-no-goal-default") is None


def test_mind_map_exec_writes_to_session_graph_after_thread_rotation(sqlite_tmp: None) -> None:
    """After client restart LangGraph thread rotates; writes must stay on the session graph."""
    del sqlite_tmp
    from evoflow.persistence.db import get_db
    from evoflow.persistence.exploration_graph_repositories import apply_mind_map_ops

    old_tid = "thread-mm-old-write"
    new_tid = "thread-mm-new-write"
    sk = "agent:main:mm-write-scope"
    apply_mind_map_ops(
        old_tid,
        [
            {"op": "set_goal", "title": "keep graph"},
            {"op": "upsert_node", "id": "flow:keep", "kind": "flow", "title": "Keep me"},
        ],
        tool_call_id="tc-old-write",
    )
    get_db().execute(
        "UPDATE evoflow_exploration_graph SET session_key = ? WHERE thread_id = ?",
        (sk, old_tid),
    )
    get_db().execute(
        """
        INSERT INTO evoflow_exploration_graph (
            thread_id, session_key, graph_version, active_turn_id,
            node_count, edge_count, render_summary, created_at, updated_at
        ) VALUES (?, ?, 0, '', 0, 0, '', datetime('now'), datetime('now'))
        """,
        (new_tid, sk),
    )
    get_db().commit()

    out = execute_mind_map(
        [{"op": "upsert_node", "id": "note:after-restart", "kind": "note", "title": "still here"}],
        thread_id=new_tid,
        session_key=sk,
        tool_call_id="call-after-restart",
    )
    assert out.startswith("OK:")
    assert get_node(old_tid, "note:after-restart") is not None
    assert get_node(new_tid, "note:after-restart") is None


def test_exploration_graph_live_footer_strips_system_footer(sqlite_tmp: None) -> None:
    del sqlite_tmp
    from evoflow.persistence.exploration_graph_repositories import apply_mind_map_ops

    tid = "t-footer-1"
    apply_mind_map_ops(
        tid,
        [{"op": "set_goal", "title": "Auth flow"}, {"op": "upsert_node", "id": "flow:auth", "kind": "flow", "title": "Auth flow"}],
        tool_call_id="tc-f",
    )

    mw = ExplorationGraphLiveFooterMiddleware()
    rt = MagicMock()
    rt.context = {"thread_id": tid}
    from langchain.agents.middleware.types import ModelRequest

    req = ModelRequest(
        model=MagicMock(),
        messages=[HumanMessage("hi")],
        system_message=SystemMessage("base system\n<session_mind_map>stale</session_mind_map>"),
        tools=[],
        runtime=rt,
        state={"messages": [HumanMessage("hi")]},
    )
    seen: list[str] = []

    def handler(r: ModelRequest):
        seen.append(str(r.system_message.content or ""))
        return MagicMock()

    mw.wrap_model_call(req, handler)
    assert seen
    assert "<session_mind_map>" not in seen[0]


def test_exploration_graph_live_footer_injects_ephemeral_message(sqlite_tmp: None) -> None:
    del sqlite_tmp
    from langchain.agents.middleware.types import ModelRequest

    from evoflow.persistence.exploration_graph_repositories import apply_mind_map_ops

    tid = "t-footer-2"
    apply_mind_map_ops(
        tid,
        [{"op": "set_goal", "title": "Inject test"}, {"op": "upsert_node", "id": "flow:x", "kind": "flow", "title": "X"}],
        tool_call_id="tc-i",
    )

    mw = ExplorationGraphLiveFooterMiddleware()
    rt = MagicMock()
    rt.context = {"thread_id": tid}
    base_messages = [HumanMessage("question"), ToolMessage(content="ok", tool_call_id="t1", name="read")]
    req = ModelRequest(
        model=MagicMock(),
        messages=list(base_messages),
        tools=[],
        runtime=rt,
        state={"messages": list(base_messages)},
    )
    seen: list[list] = []

    def handler(r: ModelRequest):
        seen.append(list(r.messages or []))
        return MagicMock()

    with patch("langgraph.config.get_config", return_value={"configurable": {"thread_id": tid}}):
        mw.wrap_model_call(req, handler)

    assert seen
    payload = seen[0]
    assert len(payload) == len(base_messages) + 1
    injected = payload[-1]
    assert isinstance(injected, SystemMessage)
    assert getattr(injected, "name", None) == "session_mind_map"
    assert "Inject test" in str(injected.content)


def test_exploration_graph_live_footer_does_not_touch_checkpoint(sqlite_tmp: None) -> None:
    del sqlite_tmp
    from langchain.agents.middleware.types import ModelRequest

    from evoflow.persistence.exploration_graph_repositories import apply_mind_map_ops

    tid = "t-footer-3"
    apply_mind_map_ops(
        tid,
        [{"op": "set_goal", "title": "No persist"}, {"op": "upsert_node", "id": "flow:y", "kind": "flow", "title": "Y"}],
        tool_call_id="tc-np",
    )

    mw = ExplorationGraphLiveFooterMiddleware()
    rt = MagicMock()
    rt.context = {"thread_id": tid}
    base_messages = [HumanMessage("question"), ToolMessage(content="ok", tool_call_id="t1", name="read")]
    state = {"messages": list(base_messages)}
    req = ModelRequest(
        model=MagicMock(),
        messages=list(base_messages),
        tools=[],
        runtime=rt,
        state=state,
    )
    seen_state: list[dict] = []

    def handler(r: ModelRequest):
        seen_state.append(dict(r.state or {}))
        return MagicMock()

    with patch("langgraph.config.get_config", return_value={"configurable": {"thread_id": tid}}):
        mw.wrap_model_call(req, handler)

    assert seen_state
    checkpoint_msgs = list(seen_state[0].get("messages") or [])
    assert len(checkpoint_msgs) == len(base_messages)
    assert not any(getattr(m, "name", None) == "session_mind_map" for m in checkpoint_msgs)


def test_exploration_graph_live_footer_uses_session_graph_when_runtime_thread_empty(sqlite_tmp: None) -> None:
    del sqlite_tmp
    from langchain.agents.middleware.types import ModelRequest

    from evoflow.persistence.db import get_db
    from evoflow.persistence.exploration_graph_repositories import apply_mind_map_ops

    old_tid = "t-footer-old"
    new_tid = "t-footer-new"
    sk = "agent:main:footer-scope"
    apply_mind_map_ops(
        old_tid,
        [{"op": "set_goal", "title": "Footer scope goal"}, {"op": "upsert_node", "id": "flow:f", "kind": "flow", "title": "F"}],
        tool_call_id="tc-footer-old",
    )
    get_db().execute(
        "UPDATE evoflow_exploration_graph SET session_key = ? WHERE thread_id = ?",
        (sk, old_tid),
    )
    get_db().commit()

    mw = ExplorationGraphLiveFooterMiddleware()
    rt = MagicMock()
    rt.context = {"thread_id": new_tid, "session_key": sk}
    base_messages = [HumanMessage("question")]
    req = ModelRequest(
        model=MagicMock(),
        messages=list(base_messages),
        tools=[],
        runtime=rt,
        state={"messages": list(base_messages)},
    )
    seen: list[list] = []

    def handler(r: ModelRequest):
        seen.append(list(r.messages or []))
        return MagicMock()

    with patch("langgraph.config.get_config", return_value={"configurable": {"thread_id": new_tid, "session_key": sk}}):
        mw.wrap_model_call(req, handler)

    injected = [
        m
        for m in (seen[0] if seen else [])
        if isinstance(m, SystemMessage) and getattr(m, "name", None) == "session_mind_map"
    ]
    assert len(injected) == 1
    assert "Footer scope goal" in str(injected[0].content)


def test_exploration_graph_live_footer_skips_when_disabled(sqlite_tmp: None, monkeypatch: pytest.MonkeyPatch) -> None:
    del sqlite_tmp
    from langchain.agents.middleware.types import ModelRequest

    from evoflow.exploration_graph.config import load_exploration_graph_config_from_dict

    monkeypatch.setattr("evoflow.agents.automation_runtime.is_unattended_automation", lambda _rt: False)
    load_exploration_graph_config_from_dict({"enabled": False})
    mw = ExplorationGraphLiveFooterMiddleware()
    rt = MagicMock()
    rt.context = {"thread_id": "t-off"}
    req = ModelRequest(
        model=MagicMock(),
        messages=[HumanMessage("x")],
        tools=[],
        runtime=rt,
        state={"messages": [HumanMessage("x")]},
    )
    seen: list[list] = []

    def handler(r: ModelRequest):
        seen.append(list(r.messages or []))
        return MagicMock()

    mw.wrap_model_call(req, handler)
    assert seen
    assert len(seen[0]) == 1
    load_exploration_graph_config_from_dict(
        {"enabled": True, "inject_into_model_payload": True, "return_snapshot_on_update": True}
    )


def test_exploration_graph_live_footer_no_duplicate_on_ai(sqlite_tmp: None) -> None:
    del sqlite_tmp
    from langchain.agents.middleware.types import ModelRequest

    mw = ExplorationGraphLiveFooterMiddleware()
    rt = MagicMock()
    rt.context = {"thread_id": "t-dup"}
    req = ModelRequest(
        model=MagicMock(),
        messages=[HumanMessage("q"), AIMessage(content="ans")],
        tools=[],
        runtime=rt,
        state={"messages": [HumanMessage("q"), AIMessage(content="ans")]},
    )
    seen: list[list] = []

    def handler(r: ModelRequest):
        seen.append(list(r.messages or []))
        return MagicMock()

    mw.wrap_model_call(req, handler)
    assert seen
    assert len(seen[0]) == 2


def test_exploration_graph_live_footer_strips_legacy_from_payload_only(sqlite_tmp: None) -> None:
    del sqlite_tmp
    from uuid import uuid4

    from langchain.agents.middleware.types import ModelRequest

    from evoflow.persistence.exploration_graph_repositories import apply_mind_map_ops

    tid = "t-legacy"
    apply_mind_map_ops(
        tid,
        [{"op": "set_goal", "title": "Fresh map"}, {"op": "upsert_node", "id": "flow:z", "kind": "flow", "title": "Z"}],
        tool_call_id="tc-z",
    )

    mw = ExplorationGraphLiveFooterMiddleware()
    rt = MagicMock()
    rt.context = {"thread_id": tid}
    legacy = ToolMessage(content="old map", tool_call_id=str(uuid4()), name="session_mind_map", id="legacy-mm")
    base_messages = [HumanMessage("q"), ToolMessage(content="evidence", tool_call_id="t1", name="read"), legacy]
    state = {"messages": list(base_messages)}
    req = ModelRequest(
        model=MagicMock(),
        messages=list(base_messages),
        tools=[],
        runtime=rt,
        state=state,
    )
    seen_payload: list[list] = []
    seen_state: list[dict] = []

    def handler(r: ModelRequest):
        seen_payload.append(list(r.messages or []))
        seen_state.append(dict(r.state or {}))
        return MagicMock()

    with patch("langgraph.config.get_config", return_value={"configurable": {"thread_id": tid}}):
        mw.wrap_model_call(req, handler)

    assert seen_payload
    payload = seen_payload[0]
    assert not any(getattr(m, "name", None) == "session_mind_map" and "old map" in str(getattr(m, "content", "")) for m in payload)
    assert any(isinstance(m, SystemMessage) and getattr(m, "name", None) == "session_mind_map" for m in payload)
    checkpoint_msgs = list(seen_state[0].get("messages") or [])
    assert len(checkpoint_msgs) == len(base_messages)
    assert any(getattr(m, "id", None) == "legacy-mm" for m in checkpoint_msgs)


def test_exploration_graph_live_footer_survives_pre_call_guardrail(sqlite_tmp: None) -> None:
    del sqlite_tmp
    from langchain.agents.middleware.types import ModelRequest

    from evoflow.agents.middlewares.pre_call_guardrail_agent_middleware import PreCallGuardrailAgentMiddleware
    from evoflow.persistence.exploration_graph_repositories import apply_mind_map_ops

    tid = "t-guardrail"
    apply_mind_map_ops(
        tid,
        [{"op": "set_goal", "title": "Guardrail test"}, {"op": "upsert_node", "id": "flow:g", "kind": "flow", "title": "G"}],
        tool_call_id="tc-g",
    )

    graph_mw = ExplorationGraphLiveFooterMiddleware()
    guardrail = PreCallGuardrailAgentMiddleware()
    rt = MagicMock()
    rt.context = {"thread_id": tid}
    base_messages = [
        HumanMessage("question"),
        AIMessage(content="", tool_calls=[{"id": "t1", "name": "read", "args": {}}]),
        ToolMessage(content="ok", tool_call_id="t1", name="read"),
    ]
    req = ModelRequest(
        model=MagicMock(),
        messages=list(base_messages),
        tools=[],
        runtime=rt,
        state={"messages": list(base_messages)},
    )
    seen: list[list] = []

    def model_handler(r: ModelRequest):
        seen.append(list(r.messages or []))
        return MagicMock()

    def graph_handler(r: ModelRequest):
        return model_handler(graph_mw._patch_request(r))

    with patch("langgraph.config.get_config", return_value={"configurable": {"thread_id": tid}}):
        guardrail.wrap_model_call(req, graph_handler)

    assert seen
    payload = seen[0]
    injected = [m for m in payload if isinstance(m, SystemMessage) and getattr(m, "name", None) == "session_mind_map"]
    assert len(injected) == 1
    assert "Guardrail test" in str(injected[0].content)
