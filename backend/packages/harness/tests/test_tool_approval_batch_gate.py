"""Tool approval should register every gated sibling in the same model turn."""

from __future__ import annotations

from langchain_core.messages import AIMessage
from langgraph.prebuilt.tool_node import ToolCallRequest

from evoflow.agents.middlewares import tool_approval_middleware as tam
from evoflow.agents.tool_approval_service import list_pending_approvals, make_pending_entry
from evoflow.persistence.session_repositories import upsert_session_row


def _request(*, tc_id: str, name: str, messages: list) -> ToolCallRequest:
    return ToolCallRequest(
        tool_call={"id": tc_id, "name": name, "args": {"path": f"{name}.txt"}},
        tool=None,
        state={"messages": messages},
        runtime=None,
    )


def test_sibling_tool_calls_for_request_finds_batch() -> None:
    msgs = [
        AIMessage(
            content="",
            tool_calls=[
                {"id": "call_a", "name": "delete", "args": {"path": "a.txt"}},
                {"id": "call_b", "name": "write", "args": {"path": "b.txt"}},
            ],
        )
    ]
    req = _request(tc_id="call_a", name="delete", messages=msgs)
    batch = tam._sibling_tool_calls_for_request(req)
    assert [tc["id"] for tc in batch] == ["call_a", "call_b"]


def test_register_sibling_pending_approvals_queues_all_gated_tools(tmp_path, monkeypatch) -> None:
    db_path = tmp_path / "approval-batch.db"
    monkeypatch.setenv("EVOFLOW_DB_PATH", str(db_path))

    sk = "agent:main:approval-batch"
    tid = "thread-approval-batch"
    upsert_session_row(sk, thread_id=tid, title="batch")

    msgs = [
        AIMessage(
            content="",
            tool_calls=[
                {"id": "call_a", "name": "delete", "args": {"path": "a.txt"}},
                {"id": "call_b", "name": "write", "args": {"path": "b.txt"}},
                {"id": "call_c", "name": "read", "args": {"path": "c.txt"}},
            ],
        )
    ]
    leader = _request(tc_id="call_a", name="delete", messages=msgs)

    monkeypatch.setattr(tam, "_thread_id_from_request", lambda _req: tid)
    monkeypatch.setattr(tam, "_workspace_root_from_request", lambda _req: "")
    monkeypatch.setattr(tam, "is_granted_for_thread", lambda *_a, **_k: False)
    monkeypatch.setattr(
        tam,
        "persist_transcript_tool_message_now",
        lambda *_a, **_k: None,
    )
    monkeypatch.setattr(tam, "_emit_pending_approval_sse", lambda *_a, **_k: None)

    tam._register_pending_approval(leader, summary="a.txt")
    tam._register_sibling_pending_approvals(leader, skip_tool_call_id="call_a", current_summary="a.txt")

    pending = list_pending_approvals(tid)
    ids = {str(row.get("tool_call_id") or "") for row in pending}
    assert ids == {"call_a", "call_b"}
    assert "call_c" not in ids
