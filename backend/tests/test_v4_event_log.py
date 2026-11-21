"""v4 durable 事件日志（重档对齐 ZCode durable event 语义）测试。

契约：
- hub author_deltas 的每条权威 delta 落库，(session_id, log_epoch, seq) 唯一、seq 连续；
- turnHeader 终态 upsert（completedSuccess 等）即「正常回复/被停止/失败」的档案标记；
- 重复投递幂等（INSERT OR IGNORE）；log_epoch 代际隔离；TTL prune。

Run: cd backend && python -m pytest tests/test_v4_event_log.py -v
"""

from __future__ import annotations

import time
from typing import Any

import pytest

from app.gateway.v4.agui_mirror import V4Mirror
from app.gateway.v4.conversation import HUB
from app.gateway.v4.event_log_writer import (
    enqueue_v4_event_log,
    flush_v4_event_log_for_tests,
)


@pytest.fixture()
def temp_db(monkeypatch: pytest.MonkeyPatch, tmp_path: Any) -> str:
    """每个用例独立的 evoflow.db（schema 就绪），隔离写入器落库目标。"""
    db_path = str(tmp_path / "evoflow-test.db")
    monkeypatch.setenv("EVOFLOW_DB_PATH", db_path)
    from evoflow.persistence.db import get_db, reset_db_for_tests

    reset_db_for_tests()
    from evoflow.persistence.schema import ensure_app_schema

    ensure_app_schema(get_db())  # _LockedConnection 代理 execute，直接跑 schema
    return db_path


def _wait_rows(session_id: str, min_rows: int, timeout_s: float = 3.0) -> list[dict[str, Any]]:
    """writer 是后台线程：轮询直到行数达标（或超时返回现有行）。"""
    from evoflow.persistence.v4_event_log_repositories import list_v4_event_log

    deadline = time.monotonic() + timeout_s
    rows: list[dict[str, Any]] = []
    while time.monotonic() < deadline:
        flush_v4_event_log_for_tests(timeout_s=0.3)
        rows = list_v4_event_log(session_id, limit=5000)
        if len(rows) >= min_rows:
            return rows
        time.sleep(0.05)
    return rows


def test_repository_roundtrip_and_idempotency(temp_db: str) -> None:
    from evoflow.persistence.v4_event_log_repositories import (
        append_v4_event_log_rows,
        latest_v4_event_log_seq,
        list_v4_event_log,
        prune_v4_event_log,
    )

    rows = [
        ("sess-a", "1", 1, "row.appended", '{"op":"row.appended"}', "2026-11-21T09:00:00+08:00"),
        ("sess-a", "1", 2, "row.delta", '{"op":"row.delta"}', "2026-11-21T09:00:00+08:00"),
    ]
    assert append_v4_event_log_rows(rows) == 2
    # 同 (session, epoch, seq) 重投 → 幂等
    assert append_v4_event_log_rows(rows[:1]) == 0
    assert latest_v4_event_log_seq("sess-a") == 2

    listed = list_v4_event_log("sess-a")
    assert [r["seq"] for r in listed] == [1, 2]
    assert listed[0]["op"] == "row.appended"
    assert isinstance(listed[0]["payload"], dict)

    # epoch 代际隔离：同 seq 不同 epoch 共存
    append_v4_event_log_rows([("sess-a", "2", 1, "row.appended", "{}", "2026-11-21T09:01:00+08:00")])
    assert latest_v4_event_log_seq("sess-a", log_epoch="2") == 1
    assert len(list_v4_event_log("sess-a")) == 3

    # prune：只删过期行
    assert prune_v4_event_log(days=14) == 0  # 都是刚写入的
    from evoflow.persistence.db import run_db_transaction

    def _backdate(db: Any) -> None:
        db.execute(
            "UPDATE evoflow_v4_event_log SET created_at = '2020-01-01T00:00:00+08:00'"
            " WHERE session_id = 'sess-a' AND log_epoch = '1' AND seq = 1"
        )

    run_db_transaction(_backdate)
    assert prune_v4_event_log(days=14) == 1


def test_writer_enqueue_flushes_to_db(temp_db: str) -> None:
    from evoflow.persistence.v4_event_log_repositories import list_v4_event_log

    items = [(i, "row.delta", f'{{"op":"row.delta","i":{i}}}') for i in range(1, 51)]
    enqueue_v4_event_log("sess-writer", "1", items)
    rows = _wait_rows("sess-writer", 50)
    assert len(rows) == 50
    assert [r["seq"] for r in rows] == list(range(1, 51))
    # created_at 非空（入队时刻生成）
    assert all(r["createdAt"] for r in rows)


def test_hub_author_deltas_persisted_with_turn_outcome(
    temp_db: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """端到端：mirror 一轮（开始→正文→完成）→ 档案里 seq 连续 + 终态 upsert 在档。"""
    monkeypatch.setattr("app.gateway.v4.agui_mirror._MIRROR_DISABLED", False)
    tid = "event-log-e2e"
    if tid in getattr(HUB, "_sessions", {}):
        del HUB._sessions[tid]  # noqa: SLF001
    try:
        mirror = V4Mirror(HUB)
        mirror.note_user_input(tid, "第一问")
        mirror.feed_events(
            tid,
            [
                {"type": "RUN_STARTED", "threadId": tid, "runId": "run-e2e"},
                {"type": "TEXT_MESSAGE_START", "messageId": "m1"},
                {"type": "TEXT_MESSAGE_CONTENT", "messageId": "m1", "delta": "答"},
                {"type": "TEXT_MESSAGE_END", "messageId": "m1"},
                {"type": "RUN_FINISHED", "threadId": tid, "runId": "run-e2e"},
            ],
        )

        rows = _wait_rows(tid, 5)
        assert rows, "author_deltas 的权威 delta 必须落库"
        seqs = [r["seq"] for r in rows]
        assert seqs == sorted(seqs), "seq 升序"
        assert len(set(seqs)) == len(seqs), "seq 无重复"
        # 轮头终态：completedSuccess 的 turnHeader upsert 在档（「正常回复」的档案标记）
        terminal = [
            r
            for r in rows
            if r["op"] == "row.upserted"
            and isinstance(r["payload"], dict)
            and r["payload"].get("row", {}).get("kind") == "turnHeader"
            and r["payload"].get("row", {}).get("state") == "completedSuccess"
        ]
        assert terminal, f"终态 turnHeader upsert 未落档: {rows[-3:]}"
    finally:
        if tid in getattr(HUB, "_sessions", {}):
            del HUB._sessions[tid]  # noqa: SLF001


def test_hub_user_stop_archives_interrupted_outcome(
    temp_db: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """用户停止 → 档案里 turnHeader 终态 = completedInterrupted（「被停止」的档案标记）。"""
    monkeypatch.setattr("app.gateway.v4.agui_mirror._MIRROR_DISABLED", False)
    tid = "event-log-stop"
    if tid in getattr(HUB, "_sessions", {}):
        del HUB._sessions[tid]  # noqa: SLF001
    try:
        mirror = V4Mirror(HUB)
        mirror.note_user_input(tid, "问")
        mirror.feed_events(tid, [{"type": "RUN_STARTED", "threadId": tid, "runId": "run-s"}])
        mirror.feed_events(
            tid,
            [
                {
                    "type": "RUN_ERROR",
                    "code": "USER_INTERRUPT",
                    "message": "user_interrupt",
                    "threadId": tid,
                }
            ],
        )
        rows = _wait_rows(tid, 4)
        interrupted = [
            r
            for r in rows
            if r["op"] == "state.updated"
            and isinstance(r["payload"], dict)
            and r["payload"].get("patch", {}).get("control", {}).get("phase")
            == "completedInterrupted"
        ]
        assert interrupted, "completedInterrupted 的 control patch 未落档"
    finally:
        if tid in getattr(HUB, "_sessions", {}):
            del HUB._sessions[tid]  # noqa: SLF001
