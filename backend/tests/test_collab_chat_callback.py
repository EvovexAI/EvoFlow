"""Collab chat callback: register → finish → deliver trail is auditable."""

from __future__ import annotations

import pytest


@pytest.fixture()
def _schema_ready(tmp_path, monkeypatch):
    db_path = tmp_path / "collab_chat.db"
    monkeypatch.setenv("EVOFLOW_DB_PATH", str(db_path))
    from evoflow.persistence.db import get_db, reset_db_for_tests
    from evoflow.persistence.schema import ensure_app_schema

    reset_db_for_tests()
    ensure_app_schema(get_db())
    yield
    reset_db_for_tests()


def test_register_and_skip_without_initiator(_schema_ready):
    from evoflow.collab.chat_callback import get_call_with_trail, register_collab_chat_call

    doc = register_collab_chat_call(
        target_agent="emp-b",
        target_session_key="proactive:emp-b:chat:1",
        notify_on_complete=True,
        source="chat_send",
        goal_preview="帮我对一下文案",
    )
    assert doc.get("call_id")
    assert doc.get("status") == "skipped"
    trail = get_call_with_trail(doc["call_id"])
    kinds = [e.get("kind") for e in (trail or {}).get("events") or []]
    assert "registered" in kinds
    assert "skipped" in kinds


def test_register_notify_off(_schema_ready):
    from evoflow.collab.chat_callback import register_collab_chat_call

    doc = register_collab_chat_call(
        target_agent="emp-b",
        initiator_agent="emp-a",
        initiator_session_key="proactive:emp-a:chat:1",
        notify_on_complete=False,
    )
    assert doc.get("status") == "skipped"
    assert doc.get("notify_on_complete") is False


def test_finish_delivers_and_trail(_schema_ready, monkeypatch):
    from evoflow.collab import chat_callback as cb
    from evoflow.collab.chat_callback import (
        get_call_with_trail,
        mark_call_processed,
        on_target_run_finished,
        register_collab_chat_call,
    )

    monkeypatch.setattr(cb, "_push_desktop", lambda call: True)
    monkeypatch.setattr(cb, "_inject_initiator_session", lambda call: True)
    monkeypatch.setattr(cb, "_maybe_resume_initiator", lambda call: False)

    doc = register_collab_chat_call(
        target_agent="emp-b",
        target_session_key="proactive:emp-b:chat:t1",
        initiator_agent="emp-a",
        initiator_session_key="proactive:emp-a:chat:lead",
        notify_on_complete=True,
        auto_resume=False,
        goal_preview="核对标题",
    )
    assert doc.get("status") == "open"
    cid = doc["call_id"]

    results = on_target_run_finished(
        session_key="proactive:emp-b:chat:t1",
        run_status="completed",
        summary="标题已缩短",
    )
    assert results and results[0].get("ok") is True
    assert results[0].get("status") == "delivered"

    trail = get_call_with_trail(cid)
    assert trail is not None
    assert trail["initiator_agent"] == "emp-a"
    assert trail["target_agent"] == "emp-b"
    assert trail["status"] == "delivered"
    kinds = [e.get("kind") for e in trail.get("events") or []]
    assert "registered" in kinds
    assert "run_finished" in kinds
    assert "delivered" in kinds

    marked = mark_call_processed(cid, processed_by="emp-a")
    assert marked and marked.get("status") == "processed"
    trail2 = get_call_with_trail(cid)
    kinds2 = [e.get("kind") for e in (trail2 or {}).get("events") or []]
    assert "processed" in kinds2


def test_finish_idempotent(_schema_ready, monkeypatch):
    from evoflow.collab import chat_callback as cb
    from evoflow.collab.chat_callback import on_target_run_finished, register_collab_chat_call

    monkeypatch.setattr(cb, "_push_desktop", lambda call: True)
    monkeypatch.setattr(cb, "_inject_initiator_session", lambda call: True)
    monkeypatch.setattr(cb, "_maybe_resume_initiator", lambda call: False)

    register_collab_chat_call(
        target_agent="emp-b",
        target_session_key="proactive:emp-b:chat:x",
        initiator_agent="emp-a",
        initiator_session_key="proactive:emp-a:chat:y",
    )
    r1 = on_target_run_finished(session_key="proactive:emp-b:chat:x", run_status="completed")
    r2 = on_target_run_finished(session_key="proactive:emp-b:chat:x", run_status="completed")
    assert r1 and r1[0].get("ok")
    # Open-set query no longer matches terminal rows → no second delivery.
    assert r2 == []


def test_resume_uses_initiator_session_owner_not_xiaomi_stamp(_schema_ready, monkeypatch):
    """chat_send often stamps initiator_agent=xiaomi; resume must continue the chat owner thread."""
    from evoflow.collab import chat_callback as cb
    from evoflow.collab.chat_callback import _maybe_resume_initiator

    scheduled: list[dict[str, str]] = []

    def _fake_schedule(**kwargs):
        scheduled.append(
            {
                "thread_id": str(kwargs.get("thread_id") or ""),
                "session_key": str(kwargs.get("session_key") or ""),
                "source": str(kwargs.get("source") or ""),
                "message_id": str(kwargs.get("message_id") or ""),
                "text": str(kwargs.get("notification_text") or ""),
            }
        )
        return True

    monkeypatch.setattr(cb, "_initiator_session_busy", lambda sk: False)
    monkeypatch.setattr(cb, "_resolve_initiator_thread_id", lambda sk: "thread-director-1")
    monkeypatch.setattr(
        "evoflow.tools.zcode_port.notify_continuation.schedule_task_notification_turn",
        _fake_schedule,
    )

    ok = _maybe_resume_initiator(
        {
            "call_id": "ccc_test",
            "initiator_agent": "xiaomi",
            "initiator_session_key": "proactive:dev-tech-director:chat:abc",
            "target_agent": "dev-qa",
            "run_status": "completed",
            "summary": "对方已回复",
        }
    )
    assert ok is True
    assert scheduled and scheduled[0]["session_key"] == "proactive:dev-tech-director:chat:abc"
    assert scheduled[0]["thread_id"] == "thread-director-1"
    assert scheduled[0]["source"] == "collab_chat_receipt"
    assert "<task-notification>" in scheduled[0]["text"]
    assert "collab_chat_receipt" in scheduled[0]["text"] or "ccc_test" in scheduled[0]["text"]
    assert "【协作回执】" not in scheduled[0]["text"]


def test_inject_does_not_write_visible_user_receipt(_schema_ready, monkeypatch):
    """Receipt must not append a fake user bubble or park pending_inject (pollutes next turn)."""
    from evoflow.collab.chat_callback import _inject_initiator_session
    from evoflow.persistence.db import get_db

    pending: list[dict[str, str]] = []

    def _fake_enqueue(sk, **kwargs):
        pending.append(
            {
                "session_key": str(sk or ""),
                "message_id": str(kwargs.get("message_id") or ""),
                "content": str(kwargs.get("content") or ""),
            }
        )

    monkeypatch.setattr(
        "evoflow.persistence.pending_inject_repository.enqueue_pending_inject",
        _fake_enqueue,
    )

    ok = _inject_initiator_session(
        {
            "call_id": "ccc_inj",
            "initiator_session_key": "proactive:dev-tech-director:chat:abc",
            "target_agent": "dev-qa",
            "run_status": "completed",
            "summary": "smoke ok",
        }
    )
    assert ok is True
    rows = get_db().execute(
        "SELECT content_json FROM evoflow_chat_messages WHERE session_key=?",
        ("proactive:dev-tech-director:chat:abc",),
    ).fetchall()
    assert rows == []
    assert pending == []


def test_finish_matches_unbound_task_create_call(_schema_ready, monkeypatch):
    """task_create registers before duty_run_id/session exist — still deliver on finish."""
    from evoflow.collab import chat_callback as cb
    from evoflow.collab.chat_callback import (
        get_call_with_trail,
        on_target_run_finished,
        register_collab_chat_call,
    )

    monkeypatch.setattr(cb, "_push_desktop", lambda call: True)
    monkeypatch.setattr(cb, "_inject_initiator_session", lambda call: True)
    monkeypatch.setattr(cb, "_maybe_resume_initiator", lambda call: True)
    # 【self-evolution-bot · 2026-11-27 · 第135轮 · 模型:deepseek-v4-1-flash-261017】
    # 桩签名跟着 `_summary_from_target_session(..., since=)` 新增的下界参数同步，否则 TypeError。
    monkeypatch.setattr(
        cb,
        "_summary_from_target_session",
        lambda sk, fallback="", since="": "对方已回复：收到",
    )

    doc = register_collab_chat_call(
        target_agent="dev-qa",
        target_session_key="",
        target_duty_run_id="",
        initiator_agent="dev-tech-director",
        initiator_session_key="proactive:dev-tech-director:chat:1",
        source="task_create",
        goal_preview="纯聊天测试",
    )
    assert doc.get("status") == "open"
    results = on_target_run_finished(
        session_key="proactive:dev-qa:task:2611261700_b701",
        duty_run_id="duty_ef2bf7ef",
        run_status="completed",
    )
    assert results and results[0].get("ok") is True
    trail = get_call_with_trail(doc["call_id"])
    assert trail and trail["status"] in {"delivered", "resumed"}
    assert trail.get("target_session_key") == "proactive:dev-qa:task:2611261700_b701"
    assert trail.get("summary") == "对方已回复：收到"


def test_soft_finish_without_reply_defers(_schema_ready, monkeypatch):
    """langgraph_idle heal before target answers must not close the call."""
    from evoflow.collab import chat_callback as cb
    from evoflow.collab.chat_callback import get_call_with_trail, on_target_run_finished, register_collab_chat_call

    monkeypatch.setattr(cb, "_target_replied_after_call", lambda call, sk: False)
    monkeypatch.setattr(cb, "_push_desktop", lambda call: True)
    monkeypatch.setattr(cb, "_inject_initiator_session", lambda call: True)

    doc = register_collab_chat_call(
        target_agent="dev-qa",
        target_session_key="proactive:dev-qa:chat:dept-x",
        initiator_agent="dev-tech-director",
        initiator_session_key="proactive:dev-tech-director:chat:1",
        goal_preview="再来一遍",
    )
    cid = doc["call_id"]
    results = on_target_run_finished(
        session_key="proactive:dev-qa:chat:dept-x",
        run_status="done",
        summary="session_run_ended:langgraph_idle",
    )
    assert results and results[0].get("skipped") is True
    assert results[0].get("reason") == "soft_finish_without_reply"
    trail = get_call_with_trail(cid)
    assert trail and trail["status"] == "open"
    kinds = [e.get("kind") for e in trail.get("events") or []]
    assert "finish_deferred" in kinds


def test_busy_initiator_defers_resume_then_flush(_schema_ready, monkeypatch):
    from evoflow.collab import chat_callback as cb
    from evoflow.collab.chat_callback import (
        get_call_with_trail,
        on_target_run_finished,
        register_collab_chat_call,
        try_resume_awaiting_for_initiator_session,
    )

    monkeypatch.setattr(cb, "_push_desktop", lambda call: True)
    monkeypatch.setattr(cb, "_inject_initiator_session", lambda call: True)
    monkeypatch.setattr(cb, "_initiator_session_busy", lambda sk: True)
    monkeypatch.setattr(cb, "_maybe_resume_initiator", lambda call: False)

    doc = register_collab_chat_call(
        target_agent="dev-qa",
        target_session_key="proactive:dev-qa:chat:t",
        initiator_agent="dev-tech-director",
        initiator_session_key="proactive:dev-tech-director:chat:lead",
        auto_resume=True,
    )
    cid = doc["call_id"]
    results = on_target_run_finished(
        session_key="proactive:dev-qa:chat:t",
        run_status="completed",
        summary="smoke2 已跑完",
    )
    assert results and results[0].get("status") == "awaiting_resume"
    trail = get_call_with_trail(cid)
    assert trail and trail["status"] == "awaiting_resume"
    kinds = [e.get("kind") for e in trail.get("events") or []]
    assert "resume_deferred" in kinds

    woke: list[str] = []

    def _resume(call):
        woke.append(str(call.get("call_id") or ""))
        return True

    monkeypatch.setattr(cb, "_initiator_session_busy", lambda sk: False)
    monkeypatch.setattr(cb, "_maybe_resume_initiator", _resume)
    flushed = try_resume_awaiting_for_initiator_session(
        "proactive:dev-tech-director:chat:lead"
    )
    assert flushed and flushed[0].get("resumed") is True
    assert woke == [cid]
    trail2 = get_call_with_trail(cid)
    assert trail2 and trail2["status"] == "resumed"


def test_summary_ignores_assistant_text_older_than_call(_schema_ready):
    """【self-evolution-bot · 2026-11-27 · 第135轮 · 模型:deepseek-v4-1-flash-261017】

    现场实测两次复现的假回执：本轮目标跑挂在 LLM 调用、一个字都没回，
    而 `_summary_from_target_session` 只按 session_key 取「最后一条 assistant」，
    于是 5 天前那条无关发言被当成「对方摘要」投给发起人。
    判据：带 since 时，早于下界的历史发言必须一条都不返回。
    """
    from evoflow.collab.chat_callback import _summary_from_target_session
    from evoflow.persistence.db import get_db

    sk = "proactive:emp-x:chat:dept-t"
    db = get_db()
    db.execute(
        "INSERT INTO evoflow_chat_messages (session_key, seq, role, content_json, created_at, updated_at)"
        " VALUES (?,?,?,?,?,?)",
        (sk, 1, "assistant", '{"content":"五天前的旧结论：SEARCH-TOOL-OK"}',
         "2026-11-22T17:52:07.000000+08:00", "2026-11-22T17:52:07.000000+08:00"),
    )
    db.execute(
        "INSERT INTO evoflow_chat_messages (session_key, seq, role, content_json, created_at, updated_at)"
        " VALUES (?,?,?,?,?,?)",
        (sk, 2, "assistant", '{"content":"本轮真回复：已收到"}',
         "2026-11-27T07:50:00.000000+08:00", "2026-11-27T07:50:00.000000+08:00"),
    )
    db.commit()

    # 下界在两条之间 → 只允许拿到本轮那条
    got = _summary_from_target_session(sk, since="2026-11-27T07:46:12.000000+08:00")
    assert got == "本轮真回复：已收到", got
    # 下界晚于所有发言（本轮确实没回复）→ 必须空，不许回落旧消息
    empty = _summary_from_target_session(sk, since="2026-11-27T08:00:00.000000+08:00")
    assert empty == "", f"旧消息被当成本轮摘要：{empty!r}"
