"""Observer catchup: force-rehydrate when hub already has rows (IM ui_sse=0)."""

from __future__ import annotations

import json
from contextlib import contextmanager
from unittest.mock import patch

from app.gateway.v4.conversation import V4ConversationHub
from app.gateway.v4.hydration import (
    force_rehydrate_session_from_transcript,
    hydrate_session_from_transcript,
    transcript_fingerprint,
)


THREAD = "catchup-thread-001"
MESSAGES_V1 = [
    {
        "role": "user",
        "content_json": json.dumps({"content": "你好"}),
        "message_id": "m1",
        "run_id": "run-1",
        "created_at": "2026-10-31T15:00:00+08:00",
        "turn_started_at": "2026-10-31T15:00:00+08:00",
        "turn_duration_ms": 1000,
        "turn_state": "completed",
    },
    {
        "role": "assistant",
        "content_json": json.dumps({"content": "第一版"}),
        "message_id": "m2",
        "run_id": "run-1",
        "created_at": "2026-10-31T15:00:01+08:00",
        "turn_started_at": "2026-10-31T15:00:00+08:00",
        "turn_duration_ms": 1000,
        "turn_state": "completed",
    },
]
MESSAGES_V2 = MESSAGES_V1 + [
    {
        "role": "assistant",
        "content_json": json.dumps({"content": "第二版更新"}),
        "message_id": "m3",
        "run_id": "run-2",
        "created_at": "2026-10-31T15:01:00+08:00",
        "turn_started_at": "2026-10-31T15:01:00+08:00",
        "turn_duration_ms": 500,
        "turn_state": "completed",
    },
]


@contextmanager
def _msgs(msgs):
    with (
        patch(
            "evoflow.persistence.session_repositories.find_session_key_by_thread_id",
            return_value="agent:main:test",
        ),
        patch(
            "evoflow.persistence.session_repositories.is_session_deleted",
            return_value=False,
        ),
        patch(
            "app.gateway.v4.hydration._load_messages",
            return_value=list(msgs),
        ),
    ):
        yield


def test_hydrate_skips_when_rows_exist_but_force_rebuilds() -> None:
    hub = V4ConversationHub()
    with _msgs(MESSAGES_V1):
        first = hydrate_session_from_transcript(hub, THREAD)
    assert first > 0
    rows_before = len(hub.get_session(THREAD).rows)

    with _msgs(MESSAGES_V1):
        again = hydrate_session_from_transcript(hub, THREAD)
    assert again == 0
    assert len(hub.get_session(THREAD).rows) == rows_before

    with _msgs(MESSAGES_V2):
        loaded = force_rehydrate_session_from_transcript(hub, THREAD)
    assert loaded > rows_before
    assert hub.get_session(THREAD).catchup_fp == transcript_fingerprint(MESSAGES_V2)


def test_catchup_from_transcript_noops_on_same_fingerprint() -> None:
    hub = V4ConversationHub()
    with _msgs(MESSAGES_V1):
        hub.catchup_from_transcript(THREAD)
    rows = len(hub.get_session(THREAD).rows)
    with _msgs(MESSAGES_V1):
        out = hub.catchup_from_transcript(THREAD)
    assert out["ok"] is True
    assert out["changed"] is False
    assert out.get("reason") == "fingerprint-unchanged"
    assert out["rows"] == rows


def test_catchup_skips_wipe_when_only_tail_content_grows() -> None:
    hub = V4ConversationHub()
    with _msgs(MESSAGES_V1):
        hub.catchup_from_transcript(THREAD)
    rows = len(hub.get_session(THREAD).rows)
    grown = list(MESSAGES_V1)
    grown[-1] = {
        **grown[-1],
        "content_json": json.dumps({"content": "第一版" + ("更" * 40)}),
    }
    with _msgs(grown):
        out = hub.catchup_from_transcript(THREAD)
    assert out["changed"] is False
    assert out.get("reason") == "tail-growing"
    assert len(hub.get_session(THREAD).rows) == rows


def test_catchup_refuses_shrink_when_hub_richer_than_db_hydrate() -> None:
    """Live mirror just ended but hub still has rich rows; lagging DB must not wipe."""
    hub = V4ConversationHub()
    with _msgs(MESSAGES_V1):
        hub.catchup_from_transcript(THREAD)
    sess = hub.get_session(THREAD)
    assert sess is not None
    # Inflate hub as if channel mirror appended many online rows.
    base = max(sess.rows.keys() or [0])
    for i in range(40):
        rid = base + 1 + i
        sess.rows[rid] = {
            "rowId": rid,
            "kind": "assistantText",
            "text": f"live-{i}",
            "turnId": "run-live",
        }
    prev = len(sess.rows)
    assert prev > 20
    with _msgs(MESSAGES_V2):
        out = hub.catchup_from_transcript(THREAD)
    assert out["changed"] is False
    assert out.get("reason") == "refuse-shrink"
    assert len(hub.get_session(THREAD).rows) == prev


def test_catchup_skips_wipe_when_panel_subscribed() -> None:
    """Observer panel subscribed + hub has rows → catchup must not fight live mirror."""
    from app.gateway.v4.conversation import _Subscription

    hub = V4ConversationHub()
    with _msgs(MESSAGES_V1):
        hub.catchup_from_transcript(THREAD)
    prev = len(hub.get_session(THREAD).rows)
    hub._subscriptions["sub-test"] = _Subscription(  # noqa: SLF001
        subscription_id="sub-test",
        session_id=THREAD,
        connection_id="c1",
        topic=f"conversation/{THREAD}",
    )
    with _msgs(MESSAGES_V2):
        out = hub.catchup_from_transcript(THREAD)
    assert out["changed"] is False
    assert out.get("reason") == "hub-subscribed"
    assert len(hub.get_session(THREAD).rows) == prev


def test_catchup_skips_wipe_while_channel_mirror_live() -> None:
    """Live IM mirror (~240 rows) must not be replaced by lagging DB hydrate (~130)."""
    import app.gateway.v4.agui_mirror as mir
    from app.gateway.v4.agui_mirror import mirror_channel_run_started, mirror_reset_thread

    hub = V4ConversationHub()
    mir._MIRROR = mir.V4Mirror(hub)
    with _msgs(MESSAGES_V1):
        hub.catchup_from_transcript(THREAD)
    rows_after_hydrate = len(hub.get_session(THREAD).rows)
    mirror_reset_thread(THREAD)
    mirror_channel_run_started(THREAD, "run-live")
    rows_with_live = len(hub.get_session(THREAD).rows)
    assert rows_with_live >= rows_after_hydrate
    # Hub already has rows; live turn open — new DB fingerprint must NOT wipe.
    with _msgs(MESSAGES_V2):
        out = hub.catchup_from_transcript(THREAD)
    assert out["changed"] is False
    assert out.get("reason") == "live-mirror"
    assert len(hub.get_session(THREAD).rows) == rows_with_live


def test_channel_assistant_mirror_appends_text() -> None:
    from app.gateway.v4.agui_mirror import (
        mirror_channel_assistant_text,
        mirror_channel_run_finished,
        mirror_channel_run_started,
        mirror_reset_thread,
    )
    import app.gateway.v4.agui_mirror as mir

    hub = V4ConversationHub()
    mir._MIRROR = mir.V4Mirror(hub)
    tid = "channel-mirror-tid"
    mirror_reset_thread(tid)
    mirror_channel_run_started(tid, "run-ch-1")
    mirror_channel_assistant_text(tid, "你", run_id="run-ch-1", message_id="a1")
    mirror_channel_assistant_text(tid, "你好", run_id="run-ch-1", message_id="a1")
    mirror_channel_run_finished(tid)
    sess = hub.get_session(tid)
    assert sess is not None
    texts = [r for r in sess.rows.values() if r.get("kind") == "assistantText"]
    assert texts, "channel mirror must create assistantText row"
    assert any("你好" in str(r.get("text") or "") for r in texts)
