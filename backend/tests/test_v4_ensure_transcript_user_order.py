"""ensure_transcript 先行落盘必须保持 turnHeader→userInput，且 RUN_STARTED 复用 provisional 头。

浮层实锤（2026-11-18）：「每个部门的负责人都在吗」只剩孤用户气泡，回复行在投影里
却挂在同 turn——根因是 ensure 只 append userInput，随后 RUN_STARTED 再 append
turnHeader，rowId 颠倒；尾窗对齐到 header 裁掉紧前 user → 页面错位。

Run: cd backend && python -m pytest tests/test_v4_ensure_transcript_user_order.py -v
"""

from __future__ import annotations

from typing import Any

import pytest

from app.gateway.v4.agui_mirror import V4Mirror, mirror_ensure_transcript_user_input
from app.gateway.v4.conversation import HUB


def _rows(tid: str) -> list[dict[str, Any]]:
    sess = HUB.get_session(tid)
    assert sess is not None
    return sorted(sess.rows.values(), key=lambda r: int(r["rowId"]))


@pytest.fixture()
def mirror_thread(monkeypatch: pytest.MonkeyPatch) -> str:
    monkeypatch.setattr("app.gateway.v4.agui_mirror._MIRROR_DISABLED", False)
    tid = "ensure-transcript-order-test"
    if tid in getattr(HUB, "_sessions", {}):
        del HUB._sessions[tid]  # noqa: SLF001
    yield tid
    if tid in getattr(HUB, "_sessions", {}):
        del HUB._sessions[tid]  # noqa: SLF001


def test_ensure_transcript_writes_header_then_user(mirror_thread: str) -> None:
    tid = mirror_thread
    assert mirror_ensure_transcript_user_input(
        tid, "每个部门的负责人都在吗", message_id="u-head-1"
    )
    rows = _rows(tid)
    assert [r["kind"] for r in rows] == ["turnHeader", "userInput"]
    assert rows[0]["state"] == "running"
    assert rows[0]["turnId"].startswith("transcript-")
    assert rows[1]["turnId"] == rows[0]["turnId"]
    assert rows[1]["entityId"] == "u-head-1"
    assert int(rows[0]["rowId"]) < int(rows[1]["rowId"])


def test_run_started_reuses_provisional_ensure_turn(mirror_thread: str) -> None:
    tid = mirror_thread
    assert mirror_ensure_transcript_user_input(
        tid, "每个部门的负责人都在吗", message_id="u-head-2"
    )
    before = _rows(tid)
    provisional = before[0]["turnId"]
    header_rid = int(before[0]["rowId"])
    user_rid = int(before[1]["rowId"])

    mirror = V4Mirror(HUB)
    # note 已由 ensure 写入 pending；再 note 一次对齐生产路径
    mirror.note_user_input(tid, "每个部门的负责人都在吗", message_id="u-head-2")
    mirror.feed_events(
        tid, [{"type": "RUN_STARTED", "threadId": tid, "runId": "run-f5f7edf5"}]
    )

    rows = _rows(tid)
    headers = [r for r in rows if r.get("kind") == "turnHeader"]
    users = [r for r in rows if r.get("kind") == "userInput"]
    assert len(headers) == 1, f"不得再开第二颗头: {headers}"
    assert len(users) == 1
    assert headers[0]["rowId"] == header_rid
    assert users[0]["rowId"] == user_rid
    assert headers[0]["turnId"] == "run-f5f7edf5"
    assert users[0]["turnId"] == "run-f5f7edf5"
    assert headers[0]["state"] == "running"
    assert int(headers[0]["rowId"]) < int(users[0]["rowId"])
    assert provisional != "run-f5f7edf5"
