"""Peer questions must not schedule PeerWake against terminal receivers."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest


@pytest.mark.asyncio
async def test_peer_question_skips_wake_for_failed_target(monkeypatch: pytest.MonkeyPatch):
    from evoflow.collab.peer import service as peer

    scheduled: list = []

    monkeypatch.setattr(peer, "get_project_storage", lambda: MagicMock())
    monkeypatch.setattr(
        peer,
        "_subtask_row",
        lambda _s, _m, sid: (
            {"id": sid, "status": "executing"}
            if sid == "asker"
            else {"id": sid, "status": "failed", "progress": 0}
        ),
    )
    monkeypatch.setattr(peer, "_sender_may_ask", lambda _st: (True, ""))
    monkeypatch.setattr(peer, "resolve_subtask_ref", lambda *_a, **_k: "target")
    monkeypatch.setattr(peer, "is_subtask_outcome_reported", lambda _st: False)
    monkeypatch.setattr(peer, "get_subtask_task_report", lambda _st: "")
    monkeypatch.setattr(peer.peer_repo, "count_pending_questions", lambda *_a, **_k: 0)
    monkeypatch.setattr(
        peer.peer_repo,
        "insert_peer_message",
        lambda _row: 42,
    )
    monkeypatch.setattr(peer, "_bump_peer_state", lambda *a, **k: None)
    monkeypatch.setattr(peer, "broadcast_collab_peer_event", AsyncMock())
    monkeypatch.setattr(
        "evoflow.collab.peer.scheduler.schedule_peer_wake",
        lambda **kw: scheduled.append(kw),
    )

    out = await peer._send_message(
        main_task_id="mt1",
        from_party="asker",
        to_token="target",
        body="what happened?",
        expect_reply=True,
    )
    assert out.get("ok") is True
    assert out.get("wakeSkipped") is True
    assert scheduled == []
