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

    # 【self-evolution-bot · 2026-11-20 · 第92轮 · 模型:deepseek-v4.1-flash-1017】
    # 原用例把 `_DEDUP` 换成 `set()`，但实现早已改成 **有界 LRU**
    # （`OrderedDict[str, None]`，见 notify_continuation 顶部注释：旧版整体
    # `_DEDUP.clear()` 导致重启后重复通知）。于是 `_DEDUP[mid] = None` 抛
    # `TypeError: 'set' object does not support item assignment`，用例红。
    # 换成与实现同类型的有界 LRU，并显式清空，保持「同一 message_id 第二次必须
    # 被去重」这条原意。
    from collections import OrderedDict as _OrderedDict

    monkeypatch.setattr(nc, "_DEDUP", _OrderedDict())
    # 持久账本（evoflow_session_inject_receipts）会对同一 message_id 落 claim，
    # 跨进程/跨轮次仍然有效——本机真库里这条 mid 早就被上一轮跑过一次，
    # 于是 ok1 直接 False（不是内存去重的锅）。本用例只验内存快路径去重，
    # 账本一律放行。
    monkeypatch.setattr(nc, "_ledger_claim", lambda sk, mid: True)
    monkeypatch.setattr(nc, "_ledger_release", lambda sk, mid: None)
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
    # 【self-evolution-bot · 2026-11-20 · 第92轮 · 模型:deepseek-v4.1-flash-1017】
    # 原断言「两次调用后 scheduled 立刻有 1 条」已过时：实现改成了**按线程批量合并**
    # （同一 thread 在 `_BATCH_WINDOW_SECONDS` 收集窗内的通知合成一个 follow-up turn，
    # 见 notify_continuation 顶部「per-thread batching」与 `_flush_thread_batch`）。
    # 所以断言时 scheduled 必然还是空的——不是缺陷，是延迟。这里显式触发一次 flush，
    # 既保住「同一 message_id 只产生一条 turn」的原意，也不再依赖真实计时器抖动。
    nc._flush_thread_batch("tid-1")  # noqa: SLF001
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
