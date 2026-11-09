"""Plain-chat subagent defaults to detached; completion notifies lead once."""

from __future__ import annotations


def test_plain_chat_detach_default_is_async():
    """No collab pair → detach_effective True unless detach=False."""
    # Mirror the decision block in task_tool (keep in sync if that changes).
    def decide(detach, resolved_collab, resolved_subtask):
        if detach is False:
            return False
        if resolved_collab and resolved_subtask:
            return bool(detach)
        return True

    assert decide(None, None, None) is True
    assert decide(True, None, None) is True
    assert decide(False, None, None) is False
    assert decide(None, "main", "sub") is False
    assert decide(True, "main", "sub") is True
    assert decide(False, "main", "sub") is False


def test_schedule_task_notification_turn_dedupes(monkeypatch):
    from evoflow.tools.zcode_port import notify_continuation as nc

    scheduled: list[str] = []

    def _fake_schedule(coro, *, name=None):
        scheduled.append(str(name or ""))

    monkeypatch.setattr(nc, "_DEDUP", set())
    monkeypatch.setattr(
        "evoflow.subagents.detached_poll_scheduler.schedule_detached_poll",
        _fake_schedule,
    )

    ok1 = nc.schedule_task_notification_turn(
        thread_id="tid-1",
        session_key="sess-1",
        notification_text="<task-notification>ok</task-notification>",
        message_id="subagent-task-notification:abc",
        source="subagent_task_notification",
    )
    ok2 = nc.schedule_task_notification_turn(
        thread_id="tid-1",
        session_key="sess-1",
        notification_text="<task-notification>ok</task-notification>",
        message_id="subagent-task-notification:abc",
        source="subagent_task_notification",
    )
    assert ok1 is True
    assert ok2 is False
    assert len(scheduled) == 1


def test_inject_receipt_release_roundtrip(tmp_path, monkeypatch):
    import uuid

    db_path = tmp_path / f"inj_{uuid.uuid4().hex[:8]}.db"
    monkeypatch.setenv("EVOFLOW_DB_PATH", str(db_path))
    from evoflow.persistence.db import get_db, reset_db_for_tests
    from evoflow.persistence.schema import ensure_app_schema
    from evoflow.persistence.session_runtime_repository import (
        SOURCE_CHILD_WORK_COMPLETE,
        delete_inject_receipt,
        try_claim_inject,
    )

    reset_db_for_tests()
    ensure_app_schema(get_db())
    sk = f"sess_{uuid.uuid4().hex[:8]}"
    ref = "subagent:task-x"
    assert try_claim_inject(sk, SOURCE_CHILD_WORK_COMPLETE, ref) is True
    assert try_claim_inject(sk, SOURCE_CHILD_WORK_COMPLETE, ref) is False
    assert delete_inject_receipt(sk, SOURCE_CHILD_WORK_COMPLETE, ref) is True
    assert try_claim_inject(sk, SOURCE_CHILD_WORK_COMPLETE, ref) is True
    reset_db_for_tests()
    monkeypatch.delenv("EVOFLOW_DB_PATH", raising=False)
