"""Replay id resolution must survive hydration wiping the marker HumanMessage."""

from __future__ import annotations

from types import SimpleNamespace

from langchain_core.messages import HumanMessage, ToolMessage

from evoflow.agents.middlewares.tool_approval_middleware import ToolApprovalReplayMiddleware
from evoflow.agents.middlewares.session_transcript_hydration_middleware import (
    _extract_tool_approval_replay_messages,
)
from evoflow.agents.tool_approval_service import (
    append_pending,
    apply_user_approval,
    build_replay_message,
    make_pending_entry,
)
from evoflow.persistence.session_repositories import upsert_session_row


def test_extract_replay_marker_survives_list_content() -> None:
    marker = build_replay_message(["call_1"])
    msgs = [
        HumanMessage(content=[{"type": "text", "text": marker}]),
        ToolMessage(content="ok", tool_call_id="other"),
    ]
    found = _extract_tool_approval_replay_messages(msgs)
    assert len(found) == 1
    assert isinstance(found[0].content, str)
    assert "call_1" in found[0].content


def test_resolve_replay_ids_from_marker_when_not_last() -> None:
    mw = ToolApprovalReplayMiddleware()
    marker = build_replay_message(["call_abc"])
    state = {
        "messages": [
            HumanMessage(content=marker),
            ToolMessage(
                content='{"_evoflow_tool":{"status":"pending_approval"},"message":"[pending_approval] write"}',
                tool_call_id="call_abc",
            ),
        ]
    }
    runtime = SimpleNamespace(context={"thread_id": "t1"}, config={})
    assert mw._resolve_replay_ids(state, runtime) == ["call_abc"]


def test_resolve_replay_ids_from_configurable() -> None:
    mw = ToolApprovalReplayMiddleware()
    state = {
        "messages": [
            ToolMessage(
                content='{"_evoflow_tool":{"status":"pending_approval"},"message":"[pending_approval] write"}',
                tool_call_id="call_cfg",
            ),
        ]
    }
    runtime = SimpleNamespace(
        context={},
        config={"configurable": {"tool_approval_replay_ids": ["call_cfg"]}},
    )
    assert mw._resolve_replay_ids(state, runtime) == ["call_cfg"]


def test_resolve_replay_ids_from_pending_plus_approved_db(tmp_path, monkeypatch) -> None:
    db_path = tmp_path / "replay-resolve.db"
    monkeypatch.setenv("EVOFLOW_DB_PATH", str(db_path))

    sk = "agent:main:replay-resolve"
    tid = "thread-replay-resolve"
    tc = "call_db_1"
    upsert_session_row(sk, thread_id=tid, title="replay resolve")
    append_pending(
        tid,
        make_pending_entry(
            tool_call_id=tc,
            tool_name="write",
            args={"path": "outputs/x.txt"},
            summary="outputs/x.txt",
        ),
    )
    result = apply_user_approval(tid, {"action": "approve", "tool_call_id": tc})
    assert tc in result.replay_tool_call_ids

    mw = ToolApprovalReplayMiddleware()
    state = {
        "messages": [
            ToolMessage(
                content='{"_evoflow_tool":{"status":"pending_approval"},"message":"[pending_approval] write"}',
                tool_call_id=tc,
            ),
        ]
    }
    runtime = SimpleNamespace(context={"thread_id": tid}, config={})
    assert mw._resolve_replay_ids(state, runtime) == [tc]


def test_merge_executed_replaces_pending_and_strips_marker() -> None:
    mw = ToolApprovalReplayMiddleware()
    marker = build_replay_message(["call_m"])
    pending = ToolMessage(
        content='{"_evoflow_tool":{"status":"pending_approval"}}',
        tool_call_id="call_m",
    )
    executed = ToolMessage(content="wrote ok", tool_call_id="call_m", name="write")
    merged = mw._merge_executed_tool_messages(
        [HumanMessage(content="hi"), pending, HumanMessage(content=marker)],
        [executed],
        ["call_m"],
    )
    assert len(merged) == 2
    assert isinstance(merged[0], HumanMessage)
    assert merged[0].content == "hi"
    assert isinstance(merged[1], ToolMessage)
    assert merged[1].content == "wrote ok"
