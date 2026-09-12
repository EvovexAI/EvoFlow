"""Minimal tool-approval approve → resume payload flow (DB + service layer)."""

from __future__ import annotations

from evoflow.agents.tool_approval_resume import (
    _build_resume_stream_body,
    build_tool_approval_resume_payload,
)
from evoflow.agents.tool_approval_service import apply_user_approval, append_pending, make_pending_entry
from evoflow.persistence.session_repositories import upsert_session_row


def test_approve_single_pending_returns_replay_ids(tmp_path, monkeypatch) -> None:
    db_path = tmp_path / "approval-flow.db"
    monkeypatch.setenv("EVOFLOW_DB_PATH", str(db_path))

    sk = "agent:main:approval-flow"
    tid = "thread-approval-flow"
    tc_id = "call_delete_1"
    upsert_session_row(sk, thread_id=tid, title="approval flow")
    append_pending(tid, make_pending_entry(
        tool_call_id=tc_id,
        tool_name="delete",
        args={"path": "outputs/x.txt"},
        summary="outputs/x.txt",
    ))

    result = apply_user_approval(tid, {"action": "approve", "tool_call_id": tc_id})
    assert tc_id in result.replay_tool_call_ids
    assert result.resume_action != "await_next"

    payload = build_tool_approval_resume_payload(
        action="approve",
        tool_call_ids=list(result.replay_tool_call_ids),
        tool_call_id=tc_id,
    )
    assert payload["action"] == "execute_approved"
    assert tc_id in payload.get("tool_call_ids", [])


def test_approve_one_of_two_sets_await_next(tmp_path, monkeypatch) -> None:
    db_path = tmp_path / "approval-flow-2.db"
    monkeypatch.setenv("EVOFLOW_DB_PATH", str(db_path))

    sk = "agent:main:approval-flow-2"
    tid = "thread-approval-flow-2"
    upsert_session_row(sk, thread_id=tid, title="approval flow 2")
    for i, name in enumerate(("delete", "write")):
        tc = f"call_{i}"
        append_pending(
            tid,
            make_pending_entry(
                tool_call_id=tc,
                tool_name=name,
                args={"path": f"outputs/{i}.txt"},
                summary=f"outputs/{i}.txt",
            ),
        )

    first = apply_user_approval(tid, {"action": "approve", "tool_call_id": "call_0"})
    assert first.resume_action == "await_next"
    assert first.replay_tool_call_ids == []

    payload = build_tool_approval_resume_payload(action="await_next")
    assert payload == {"action": "await_next"}

    second = apply_user_approval(tid, {"action": "approve", "tool_call_id": "call_1"})
    assert second.replay_tool_call_ids
    assert "call_0" in second.replay_tool_call_ids or "call_1" in second.replay_tool_call_ids


def test_deny_one_of_two_sets_await_next(tmp_path, monkeypatch) -> None:
    db_path = tmp_path / "approval-flow-deny.db"
    monkeypatch.setenv("EVOFLOW_DB_PATH", str(db_path))

    sk = "agent:main:approval-flow-deny"
    tid = "thread-approval-flow-deny"
    upsert_session_row(sk, thread_id=tid, title="approval flow deny")
    for i, name in enumerate(("write", "delete")):
        append_pending(
            tid,
            make_pending_entry(
                tool_call_id=f"call_{i}",
                tool_name=name,
                args={"path": f"outputs/{i}.txt"},
                summary=f"outputs/{i}.txt",
            ),
        )

    first = apply_user_approval(tid, {"action": "deny", "tool_call_id": "call_0"})
    assert first.resume_action == "await_next"
    assert first.replay_tool_call_ids == []
    assert "call_0" in first.denied_tool_call_ids

    second = apply_user_approval(tid, {"action": "deny", "tool_call_id": "call_1"})
    assert second.resume_action != "await_next"
    assert second.replay_tool_call_ids == []
    assert "call_0" in second.denied_tool_call_ids
    assert "call_1" in second.denied_tool_call_ids


def test_deny_then_approve_sibling_returns_replay_ids(tmp_path, monkeypatch) -> None:
    db_path = tmp_path / "approval-flow-mixed.db"
    monkeypatch.setenv("EVOFLOW_DB_PATH", str(db_path))

    sk = "agent:main:approval-flow-mixed"
    tid = "thread-approval-flow-mixed"
    upsert_session_row(sk, thread_id=tid, title="approval flow mixed")
    for i, name in enumerate(("write", "delete")):
        append_pending(
            tid,
            make_pending_entry(
                tool_call_id=f"call_m{i}",
                tool_name=name,
                args={"path": f"outputs/m{i}.txt"},
                summary=f"outputs/m{i}.txt",
            ),
        )

    denied = apply_user_approval(tid, {"action": "deny", "tool_call_id": "call_m0"})
    assert denied.resume_action == "await_next"

    approved = apply_user_approval(tid, {"action": "approve", "tool_call_id": "call_m1"})
    assert "call_m1" in approved.replay_tool_call_ids
    assert "call_m0" not in approved.replay_tool_call_ids


def test_deny_updates_tool_transcript_to_denied(tmp_path, monkeypatch) -> None:
    import json

    from evoflow.persistence.chat_message_repositories import append_message, list_messages
    from evoflow.persistence.chat_message_content import loads_payload

    db_path = tmp_path / "approval-deny-transcript.db"
    monkeypatch.setenv("EVOFLOW_DB_PATH", str(db_path))

    sk = "agent:main:deny-transcript"
    tid = "thread-deny-transcript"
    tc = "call_deny_tx"
    upsert_session_row(sk, thread_id=tid, title="deny transcript")
    pending_body = json.dumps(
        {
            "_evoflow_tool": {"status": "pending_approval"},
            "message": "[pending_approval] write 等待授权",
        },
        ensure_ascii=False,
    )
    append_message(
        sk,
        role="tool",
        content=pending_body,
        tool_call_id=tc,
        tool_name="write",
        thread_id=tid,
    )
    append_pending(
        tid,
        make_pending_entry(
            tool_call_id=tc,
            tool_name="write",
            args={"path": "outputs/x.txt"},
            summary="outputs/x.txt",
        ),
    )

    result = apply_user_approval(tid, {"action": "deny", "tool_call_id": tc})
    assert tc in result.denied_tool_call_ids

    rows = list_messages(sk, limit=20)
    tool_rows = [
        r
        for r in rows
        if str(r.get("role") or "") == "tool" and str(r.get("tool_call_id") or "") == tc
    ]
    assert tool_rows
    payload = tool_rows[-1].get("payload")
    if not isinstance(payload, dict):
        payload = loads_payload(str(tool_rows[-1].get("content_json") or ""))
    raw = payload.get("content") if isinstance(payload, dict) else None
    if isinstance(raw, str):
        body = json.loads(raw)
    elif isinstance(raw, dict):
        body = raw
    else:
        body = {}
    status = (body.get("_evoflow_tool") or {}).get("status") if isinstance(body, dict) else None
    assert status == "denied", body


def test_build_resume_stream_body_includes_null_input_and_modes() -> None:
    body = _build_resume_stream_body(
        resume_payload={"action": "execute_approved", "tool_call_ids": ["call_x"]},
        run_config={"configurable": {"thread_id": "t1", "session_key": "agent:main:t"}},
        thread_id="t1",
    )
    assert body["input"] is None
    assert body["command"] == {"resume": {"action": "execute_approved", "tool_call_ids": ["call_x"]}}
    assert body["stream_mode"] == ["messages-tuple", "values", "custom"]
    assert body["multitask_strategy"] == "enqueue"
