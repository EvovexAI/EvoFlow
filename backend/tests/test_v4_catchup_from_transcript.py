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
    assert out.get("tipRowId") is not None
    assert int(out["tipRowId"]) > 0


def test_catchup_client_stale_resync_when_client_tip_ahead_of_hub() -> None:
    """FE tip 高于 hub tip（错过 recovery）→ fingerprint 未变也要再广播 recovery。"""
    hub = V4ConversationHub()
    with _msgs(MESSAGES_V1):
        hub.catchup_from_transcript(THREAD)
    sess = hub.get_session(THREAD)
    assert sess is not None and sess.rows
    hub_tip = max(int(r.get("rowId") or 0) for r in sess.rows.values())
    with _msgs(MESSAGES_V1):
        # 微差（+2）不得触发 client-stale（live 采样噪声）
        micro = hub.catchup_from_transcript(
            THREAD,
            client_tip_row_id=hub_tip + 2,
            client_log_epoch=str(sess.log_epoch),
        )
        assert micro.get("reason") == "fingerprint-unchanged"
        assert micro.get("changed") is False
        out = hub.catchup_from_transcript(
            THREAD,
            client_tip_row_id=hub_tip + 100,
            client_log_epoch=str(sess.log_epoch),
        )
    assert out["ok"] is True
    assert out["changed"] is True
    assert out.get("reason") == "client-stale-resync"
    assert int(out.get("tipRowId") or 0) == hub_tip
    assert int(out.get("clientTipRowId") or 0) == hub_tip + 100


def test_catchup_client_behind_resync_when_client_tip_lags_hub() -> None:
    """FE tip 低于 hub tip（frames 丢了）→ fingerprint 未变也要再广播 recovery。"""
    from app.gateway.v4.agui_mirror import mirror_reset_thread

    # 前序 live-mirror 用例可能把 THREAD 留在 mirror live；先清掉以免挡 hydrate。
    mirror_reset_thread(THREAD)
    hub = V4ConversationHub()
    with _msgs(MESSAGES_V1):
        hub.catchup_from_transcript(THREAD)
    sess = hub.get_session(THREAD)
    assert sess is not None and sess.rows
    real_tip = max(int(r.get("rowId") or 0) for r in sess.rows.values())
    # V1 tip 往往 <5；用 stub 抬高 hub tip，专测 Δ≥5 的 behind 阈值（不污染 fingerprint）。
    with (
        _msgs(MESSAGES_V1),
        patch.object(V4ConversationHub, "_hub_tip_row_id", return_value=real_tip + 10),
    ):
        out = hub.catchup_from_transcript(
            THREAD,
            client_tip_row_id=real_tip + 5,
            client_log_epoch=str(sess.log_epoch),
        )
    assert out["ok"] is True
    assert out["changed"] is True
    assert out.get("reason") == "client-behind-resync"
    assert int(out.get("clientTipRowId") or 0) == real_tip + 5


def test_catchup_prefer_settle_only_never_wipes_existing_rows() -> None:
    """切回校准：客户端已有投影时只 settle，禁止 clear_projection wipe。"""
    hub = V4ConversationHub()
    with _msgs(MESSAGES_V1):
        hub.catchup_from_transcript(THREAD)
    rows = len(hub.get_session(THREAD).rows)
    epoch = hub.get_session(THREAD).log_epoch
    with _msgs(MESSAGES_V2):
        out = hub.catchup_from_transcript(THREAD, prefer_settle_only=True)
    assert out["ok"] is True
    assert out["changed"] is False
    assert out.get("reason") == "settle-only"
    assert out["rows"] == rows
    assert len(hub.get_session(THREAD).rows) == rows
    assert hub.get_session(THREAD).log_epoch == epoch


def test_catchup_prefer_settle_only_still_resyncs_when_client_tip_diverges() -> None:
    """preferSettleOnly 不得吞掉 tip 分叉（现场 FE=2155 hub=1 被 settle-only 跳死）。

    用 V2 指纹（与 hub catchup_fp 不同）走到 settle-only 分支，而不是
    fingerprint-unchanged 早退——专门钉住 settle-only 里的 tip 对账。
    """
    hub = V4ConversationHub()
    with _msgs(MESSAGES_V1):
        hub.catchup_from_transcript(THREAD)
    sess = hub.get_session(THREAD)
    assert sess is not None and sess.rows
    hub_tip = max(int(r.get("rowId") or 0) for r in sess.rows.values())
    rows = len(sess.rows)
    with _msgs(MESSAGES_V2):
        out = hub.catchup_from_transcript(
            THREAD,
            prefer_settle_only=True,
            client_tip_row_id=hub_tip + 200,
        )
    assert out["ok"] is True
    assert out["changed"] is True
    assert out.get("reason") == "client-stale-resync"
    assert int(out.get("tipRowId") or 0) == hub_tip
    assert out["rows"] == rows
    assert "notified" in out
    assert "subscriberCount" in out


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


def test_catchup_client_behind_under_live_mirror_broadcasts_recovery() -> None:
    """live-mirror 不得挡住 FE tip 落后时的 recovery（WIRE_WITHOUT_V4_TIP）。"""
    import app.gateway.v4.agui_mirror as mir
    from app.gateway.v4.agui_mirror import mirror_channel_run_started, mirror_reset_thread
    from app.gateway.v4.conversation import _Subscription

    hub = V4ConversationHub()
    mir._MIRROR = mir.V4Mirror(hub)
    with _msgs(MESSAGES_V1):
        hub.catchup_from_transcript(THREAD)
    mirror_reset_thread(THREAD)
    mirror_channel_run_started(THREAD, "run-live")
    sess = hub.get_session(THREAD)
    assert sess is not None and sess.rows
    hub_tip = max(int(r.get("rowId") or 0) for r in sess.rows.values())
    assert hub_tip > 1
    hub._subscriptions["sub-live"] = _Subscription(  # noqa: SLF001
        subscription_id="sub-live",
        session_id=THREAD,
        connection_id="c-live",
        topic=f"conversation/{THREAD}",
    )
    # live-mirror 例外门槛：hub_tip - client_tip >= 5（防噪声），差 1 仍走 live-mirror。
    with _msgs(MESSAGES_V2):
        out = hub.catchup_from_transcript(
            THREAD,
            client_tip_row_id=hub_tip - 5,
            client_log_epoch=str(sess.log_epoch),
        )
    assert out["ok"] is True
    assert out["changed"] is True
    assert out.get("reason") == "client-behind-resync"
    assert int(out.get("tipRowId") or 0) == hub_tip
    assert int(out.get("notified") or 0) >= 1


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


def test_remint_live_seed_blocks_hydrate_unless_forced() -> None:
    """stream-404 remint 竞态：新 thread 先被 note_user_input 种 2 行时，
    普通 hydrate 会跳过；rehydrate_after_thread_remint 必须把 transcript 灌回。
    """
    from app.gateway.v4 import conversation as conv_mod
    from app.gateway.v4.hydration import rehydrate_after_thread_remint

    remint_tid = "remint-thread-404"
    hub = V4ConversationHub()
    prev_hub = conv_mod.HUB
    conv_mod.HUB = hub
    try:
        # Simulate retried stream seeding a non-empty session before FE subscribe.
        sess = hub._get_or_create_session(remint_tid)  # noqa: SLF001
        sess.rows[1] = {
            "rowId": 1,
            "kind": "turnHeader",
            "turnId": "run-new",
            "phase": "running",
        }
        sess.rows[2] = {
            "rowId": 2,
            "kind": "userInput",
            "text": "把剧本写好",
            "turnId": "run-new",
            "origin": "realUser",
        }
        sess.next_row_id = 3
        assert len(sess.rows) == 2

        with _msgs(MESSAGES_V1):
            skipped = hydrate_session_from_transcript(hub, remint_tid)
        assert skipped == 0
        assert len(hub.get_session(remint_tid).rows) == 2

        with _msgs(MESSAGES_V1):
            loaded = rehydrate_after_thread_remint(remint_tid)
        assert loaded > 2
        assert len(hub.get_session(remint_tid).rows) == loaded
    finally:
        conv_mod.HUB = prev_hub


# ── 员工/后台 run 终态收口（2026-11-15 死锁闭环修复）────────────────────────


def _seed_running_projection(hub: V4ConversationHub, thread: str, msgs=MESSAGES_V1) -> None:
    """模拟「hydrate 时 run 在跑 → 写了 running control → 之后无人收口」。"""
    from app.gateway.v4.conversation import _minimal_control

    with _msgs(msgs):
        hub.catchup_from_transcript(thread)
    sess = hub.get_session(thread)
    assert sess is not None and sess.rows
    sess.phase = "running"
    sess.control_override = _minimal_control("running", run_started_at=1)
    # hydrate 灌行会盖 last_author_at_ms；陈旧场景写手早已收工。
    sess.last_author_at_ms = 0.0


def test_catchup_settles_stale_running_when_db_terminal() -> None:
    """DB run_status 已终态 + 投影死钉 running → settle control 并 rehydrate 终态行。"""
    thread = "settle-thread-001"
    hub = V4ConversationHub()
    _seed_running_projection(hub, thread)
    with (
        _msgs(MESSAGES_V2),
        patch(
            "app.gateway.v4.hydration.read_run_status_row",
            return_value={"status": "done", "updated_at_ms": 1, "run_id": "run-2"},
        ),
    ):
        out = hub.catchup_from_transcript(thread)
    assert out["ok"] is True
    assert out["changed"] is True
    assert out["settledPhase"] == "completedSuccess"
    sess = hub.get_session(thread)
    assert sess.phase == "completedSuccess"
    assert sess.control_override is None
    texts = [str(r.get("text") or "") for r in sess.rows.values() if r.get("kind") == "assistantText"]
    assert any("第二版更新" in t for t in texts), "终态回复必须进投影"


def test_catchup_settles_draft_inflight_when_db_terminal() -> None:
    """DB done + phase=draft 但仍有 streaming tip → settle（压缩后僵尸思考）。"""
    thread = "settle-thread-draft-inflight"
    hub = V4ConversationHub()
    with _msgs(MESSAGES_V1):
        hub.catchup_from_transcript(thread)
    sess = hub.get_session(thread)
    assert sess is not None and sess.rows
    sess.phase = "draft"
    sess.control_override = None
    sess.catchup_fp = "pinned-fp-keep"
    sess.last_author_at_ms = 0.0
    # 人工钉一条 streaming 思考，模拟 tip「正在思考」孤儿。
    rid = int(sess.next_row_id)
    sess.next_row_id = rid + 1
    sess.rows[rid] = {
        "rowId": rid,
        "kind": "reasoning",
        "state": "streaming",
        "text": "",
        "turnId": "zombie-tip",
        "createdAt": 1,
        "startedAt": 1,
    }
    with patch(
        "app.gateway.v4.hydration.read_run_status_row",
        return_value={"status": "done", "updated_at_ms": 1, "run_id": "run-x"},
    ), patch(
        "app.gateway.v4.hydration.transcript_fingerprint_for_thread",
        return_value="pinned-fp-keep",
    ):
        out = hub.catchup_from_transcript(thread)
    assert out["ok"] is True
    assert out.get("settledPhase") == "completedSuccess"
    assert out.get("reason") == "fingerprint-unchanged"
    sess2 = hub.get_session(thread)
    assert sess2.phase == "completedSuccess"


def test_trim_projection_after_fingerprint_tip_drops_ghost_tail() -> None:
    """库尾 message 之后的幽灵轮必须裁掉（durable-replay 追加旧 live tip）。"""
    from app.gateway.v4.conversation import V4ConversationHub

    hub = V4ConversationHub()
    with _msgs(MESSAGES_V2):
        hub.catchup_from_transcript(THREAD)
    sess = hub.get_session(THREAD)
    assert sess is not None
    fp = transcript_fingerprint(MESSAGES_V2)
    base = int(sess.next_row_id)
    sess.next_row_id = base + 2
    sess.rows[base] = {
        "rowId": base,
        "kind": "toolCall",
        "status": "cancelled",
        "toolName": "bash",
        "turnId": "run-07cc-ghost",
        "inputText": "",
    }
    sess.rows[base + 1] = {
        "rowId": base + 1,
        "kind": "reasoning",
        "state": "complete",
        "text": "ghost tip",
        "turnId": "run-07cc-ghost",
    }
    assert V4ConversationHub._projection_tip_matches_fingerprint(sess, fp) is False
    removed = V4ConversationHub._trim_projection_after_fingerprint_tip(sess, fp)
    assert removed == 2
    assert V4ConversationHub._projection_tip_matches_fingerprint(sess, fp) is True
    assert not any(str(r.get("turnId") or "") == "run-07cc-ghost" for r in sess.rows.values())


def test_catchup_force_rehydrates_when_tip_mismatches_fingerprint() -> None:
    """指纹已是库尾，但 tip 仍挂着更早一轮的 tool/思考 → 强制重灌（允许 shrink）。

    394bc37f：SQL tip=「两条都通了」，面板 tip=旧 run cancelled bash；
    fingerprint-unchanged + refuse-shrink 会把错误 tip 钉死。
    """
    thread = "tip-mismatch-thread-001"
    hub = V4ConversationHub()
    with _msgs(MESSAGES_V2):
        hub.catchup_from_transcript(thread)
    sess = hub.get_session(thread)
    assert sess is not None and sess.rows
    fp = transcript_fingerprint(MESSAGES_V2)
    assert sess.catchup_fp == fp
    # 库尾 m3 已在投影里；再在更高 rowId 挂另一轮幽灵 tip。
    assert any(
        str(r.get("entityId") or "") == "m3" for r in sess.rows.values()
    ), "hydrate 必须带上库尾 message_id"
    base_rid = int(sess.next_row_id)
    sess.next_row_id = base_rid + 3
    sess.rows[base_rid] = {
        "rowId": base_rid,
        "kind": "turnHeader",
        "state": "completedSuccess",
        "turnId": "run-ghost-old",
        "createdAt": 9_000,
        "startedAt": 9_000,
        "endedAt": 9_100,
    }
    sess.rows[base_rid + 1] = {
        "rowId": base_rid + 1,
        "kind": "toolCall",
        "status": "cancelled",
        "toolName": "bash",
        "inputText": "",
        "turnId": "run-ghost-old",
        "createdAt": 9_001,
    }
    sess.rows[base_rid + 2] = {
        "rowId": base_rid + 2,
        "kind": "reasoning",
        "state": "complete",
        "text": "Let me reconsider. 有问题的修复掉",
        "turnId": "run-ghost-old",
        "createdAt": 9_002,
    }
    prev = len(sess.rows)
    sess.last_author_at_ms = 0.0
    with (
        _msgs(MESSAGES_V2),
        patch(
            "app.gateway.v4.hydration.read_run_status_row",
            return_value={"status": "done", "updated_at_ms": 1, "run_id": "run-2"},
        ),
    ):
        out = hub.catchup_from_transcript(thread)
    assert out["ok"] is True
    assert out["changed"] is True
    assert out.get("reason") == "tip-mismatch-rehydrated"
    assert int(out.get("rows") or 0) < prev
    sess2 = hub.get_session(thread)
    assert not any(
        str(r.get("turnId") or "") == "run-ghost-old" for r in sess2.rows.values()
    )
    texts = [
        str(r.get("text") or "")
        for r in sess2.rows.values()
        if r.get("kind") == "assistantText"
    ]
    assert any("第二版更新" in t for t in texts)


def test_catchup_keeps_running_control_while_run_active() -> None:
    """DB run_status 仍 running（后台 run 真在跑、无 mirror 喂流）→ 不收口，
    且 DB transcript 是唯一真源，行照常 rehydrate（修「盯着看也冻结」）。"""
    import time as _time

    thread = "settle-thread-002"
    hub = V4ConversationHub()
    _seed_running_projection(hub, thread)
    fresh_ms = int(_time.time() * 1000)
    with (
        _msgs(MESSAGES_V2),
        patch(
            "app.gateway.v4.hydration.read_run_status_row",
            return_value={"status": "running", "updated_at_ms": fresh_ms, "run_id": "run-2"},
        ),
    ):
        out = hub.catchup_from_transcript(thread)
    assert out["ok"] is True
    assert out["changed"] is True
    assert not out.get("settledPhase")
    sess = hub.get_session(thread)
    assert sess.phase == "running"
    assert (sess.control_override or {}).get("phase") == "running"
    texts = [str(r.get("text") or "") for r in sess.rows.values() if r.get("kind") == "assistantText"]
    assert any("第二版更新" in t for t in texts)


def test_reconcile_stale_running_settles_and_broadcasts() -> None:
    """周期收口：候选命中 running 投影，settle 后 phase 归位、行刷新。"""
    thread = "settle-thread-003"
    hub = V4ConversationHub()
    _seed_running_projection(hub, thread)
    with (
        _msgs(MESSAGES_V2),
        patch(
            "app.gateway.v4.hydration.read_run_status_row",
            return_value={"status": "fail", "updated_at_ms": 1, "run_id": "run-2"},
        ),
    ):
        stats = hub.reconcile_stale_running()
    assert stats["candidates"] == 1
    assert stats["settled"] == 1
    sess = hub.get_session(thread)
    assert sess.phase == "error"


def test_reconcile_skips_freshly_authored_sessions() -> None:
    """最近 5s 内有活写手的 running 会话不是孤儿 run，不得收口。"""
    import time as _time

    thread = "settle-thread-004"
    hub = V4ConversationHub()
    _seed_running_projection(hub, thread)
    hub.get_session(thread).last_author_at_ms = _time.time() * 1000
    with (
        _msgs(MESSAGES_V2),
        patch(
            "app.gateway.v4.hydration.read_run_status_row",
            return_value={"status": "done", "updated_at_ms": 1, "run_id": "run-2"},
        ),
    ):
        stats = hub.reconcile_stale_running()
    assert stats["candidates"] == 0
    assert hub.get_session(thread).phase == "running"


def test_catchup_still_refuses_while_hub_turn_running() -> None:
    """hub 自跑 turn（主聊）拥有执行权：订阅 + 活 turn → catchup 仍不得对打。"""
    import asyncio as _asyncio

    from app.gateway.v4.conversation import _Subscription

    thread = "settle-thread-005"
    hub = V4ConversationHub()
    with _msgs(MESSAGES_V1):
        hub.catchup_from_transcript(thread)
    prev = len(hub.get_session(thread).rows)
    hub._subscriptions["sub-test"] = _Subscription(  # noqa: SLF001
        subscription_id="sub-test",
        session_id=thread,
        connection_id="c1",
        topic=f"conversation/{thread}",
    )
    loop = _asyncio.new_event_loop()
    turn = None
    try:
        turn = loop.create_task(_asyncio.sleep(0))
        hub.get_session(thread).turn_task = turn  # noqa: SLF001 — 测试直填
        with _msgs(MESSAGES_V2):
            out = hub.catchup_from_transcript(thread)
        assert out["changed"] is False
        assert out.get("reason") == "hub-subscribed"
        assert len(hub.get_session(thread).rows) == prev
    finally:
        if turn is not None:
            turn.cancel()
        loop.run_until_complete(_asyncio.gather(turn, return_exceptions=True)) if turn else None
        loop.close()
