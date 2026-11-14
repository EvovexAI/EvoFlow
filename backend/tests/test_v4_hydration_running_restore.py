"""hydrate 运行态恢复（生命周期四件套第 1 件 / Phase B）单元测试。

契约：运行中会话刷新/重连后，hydrate 不再把最后一轮一律盖 completedSuccess——
DB run_status fresh running 且 run_id 与最后一轮一致 → turnHeader 保持 running +
running control override（isRunning/停止键/轮尾 loading 恢复，对齐 ZCode 冷恢复
走同一投影）。三分支：fresh running / stale running / mirror live；另验证
run_id 不一致时只恢复 control 不动历史轮，以及 force-rehydrate 清陈旧 override。

Run: cd backend && python -m pytest tests/test_v4_hydration_running_restore.py -v
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

from app.gateway.v4.conversation import V4ConversationHub
from app.gateway.v4.hydration import (
    _probe_running_run,
    hydrate_session_from_transcript,
)

THREAD = "lead-0000__sub__RunningRestore"


def _msg(role: str, content: str, *, rid: str, ts: str, run_id: str = "run-1") -> dict:
    return {
        "role": role,
        "content_json": json.dumps({"content": content}),
        "message_id": rid,
        "run_id": run_id,
        "created_at": ts,
        "turn_started_at": ts,
        "turn_duration_ms": 1200,
        "turn_state": "completed",
    }


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat()


def _load_messages():
    return [
        _msg("user", "第一问", rid="m0", ts="2026-11-14T10:00:00+08:00"),
        _msg("assistant", "答一", rid="m1", ts="2026-11-14T10:00:01+08:00", run_id="run-1"),
    ]


def _headers(hub) -> list[dict]:
    sess = hub.get_session(THREAD)
    assert sess is not None
    return sorted(
        (r for r in sess.rows.values() if r.get("kind") == "turnHeader"),
        key=lambda r: int(r["rowId"]),
    )


def _hydrate(hub, *, probe=None, mirror_live=False):
    from contextlib import ExitStack

    with ExitStack() as stack:
        stack.enter_context(
            patch(
                "evoflow.persistence.session_repositories.find_session_key_by_thread_id",
                return_value="agent:main:test",
            )
        )
        stack.enter_context(
            patch(
                "evoflow.persistence.session_repositories.is_session_deleted",
                return_value=False,
            )
        )
        stack.enter_context(
            patch("app.gateway.v4.hydration._load_messages", return_value=list(_load_messages()))
        )
        if probe is not None:
            stack.enter_context(
                patch("app.gateway.v4.hydration._probe_running_run", return_value=probe)
            )
        if mirror_live:
            stack.enter_context(
                patch("app.gateway.v4.agui_mirror.mirror_thread_is_live", return_value=True)
            )
        return hydrate_session_from_transcript(hub, THREAD)


def test_hydrate_restores_running_header_and_control() -> None:
    """fresh running 且 run_id 匹配：最后一轮保持 running + control override。"""
    hub = V4ConversationHub()
    hub._get_or_create_session(THREAD)
    now_ms = int(datetime.now(tz=timezone.utc).timestamp() * 1000)
    loaded = _hydrate(
        hub, probe={"run_id": "run-1", "status": "running", "updated_at_ms": now_ms}
    )
    assert loaded > 0

    headers = _headers(hub)
    assert len(headers) == 1
    assert headers[0]["turnId"] == "run-1"
    assert headers[0]["state"] == "running", headers[0]
    assert "endedAt" not in headers[0]

    sess = hub.get_session(THREAD)
    assert sess.control_override is not None
    assert sess.control_override["phase"] == "running"
    assert sess.control_override["canStop"] is True

    snap = hub._build_snapshot(sess)
    assert snap["control"]["canStop"] is True
    assert snap["control"]["phase"] == "running"
    # 快照 rows.window 里该轮也是 running（尾部窗口包含最后一轮）
    window_headers = [r for r in snap["rows"]["window"] if r.get("kind") == "turnHeader"]
    assert window_headers and window_headers[-1]["state"] == "running"


def test_hydrate_run_id_mismatch_restores_control_only() -> None:
    """run 刚起还没落消息（探测 run_id ≠ 最后一轮）：不动历史轮，只恢复 control。"""
    hub = V4ConversationHub()
    hub._get_or_create_session(THREAD)
    now_ms = int(datetime.now(tz=timezone.utc).timestamp() * 1000)
    _hydrate(hub, probe={"run_id": "run-new", "status": "running", "updated_at_ms": now_ms})

    headers = _headers(hub)
    assert headers[0]["state"] == "completedSuccess", "历史轮不得被错标 running"
    assert "endedAt" in headers[0]
    sess = hub.get_session(THREAD)
    assert sess.control_override is not None
    assert sess.control_override["canStop"] is True


def test_hydrate_stale_running_keeps_completed() -> None:
    """running 但探测不到（超窗/无 DB）：维持 completedSuccess + 无 override（现状）。"""
    hub = V4ConversationHub()
    hub._get_or_create_session(THREAD)
    # 不 patch probe：测试环境无 DB → run_db_read 失败被吞 → None
    _hydrate(hub)

    headers = _headers(hub)
    assert headers[0]["state"] == "completedSuccess"
    sess = hub.get_session(THREAD)
    assert sess.control_override is None


def test_hydrate_skips_restore_when_mirror_live() -> None:
    """mirror 活跃：在线镜像才是真值，hydrate 不探测不写 override。"""
    hub = V4ConversationHub()
    hub._get_or_create_session(THREAD)
    now_ms = int(datetime.now(tz=timezone.utc).timestamp() * 1000)

    called = {"probe": False}

    def _spy_probe(_tid):
        called["probe"] = True
        return {"run_id": "run-1", "status": "running", "updated_at_ms": now_ms}

    with (
        patch(
            "evoflow.persistence.session_repositories.find_session_key_by_thread_id",
            return_value="agent:main:test",
        ),
        patch(
            "evoflow.persistence.session_repositories.is_session_deleted",
            return_value=False,
        ),
        patch("app.gateway.v4.hydration._load_messages", return_value=list(_load_messages())),
        patch("app.gateway.v4.hydration._probe_running_run", side_effect=_spy_probe),
        patch("app.gateway.v4.agui_mirror.mirror_thread_is_live", return_value=True),
    ):
        hydrate_session_from_transcript(hub, THREAD)

    assert called["probe"] is False, "mirror live 时不得探测"
    assert _headers(hub)[0]["state"] == "completedSuccess"
    assert hub.get_session(THREAD).control_override is None


def test_probe_running_run_stale_via_db(monkeypatch) -> None:
    """探测本身的超窗逻辑：updated_at 超过窗口 → None（zombie 交 sweeper）。"""
    old_iso = _iso(datetime.now(tz=timezone.utc) - timedelta(minutes=10))

    class _FakeConn:
        def execute(self, _sql, _params):
            return self

        def fetchone(self):
            return ("running", old_iso, "run-1")

    monkeypatch.setattr(
        "evoflow.persistence.db.run_db_read", lambda _fn: _FakeConn().fetchone()
    )
    assert _probe_running_run(THREAD) is None

    fresh_iso = _iso(datetime.now(tz=timezone.utc) - timedelta(seconds=5))
    monkeypatch.setattr(
        "evoflow.persistence.db.run_db_read",
        lambda _fn: ("running", fresh_iso, "run-1"),
    )
    out = _probe_running_run(THREAD)
    assert out is not None and out["run_id"] == "run-1"

    monkeypatch.setattr(
        "evoflow.persistence.db.run_db_read", lambda _fn: ("cancelled", fresh_iso, "run-1")
    )
    assert _probe_running_run(THREAD) is None


def test_clear_projection_clears_stale_override() -> None:
    """force-rehydrate wipe 后陈旧 override 必须清，否则停止键被死钉。"""
    hub = V4ConversationHub()
    sess = hub._get_or_create_session(THREAD)
    hub.set_control_override(
        THREAD,
        {"phase": "running", "canStop": True, "stopState": "stoppable", "activeWorks": []},
    )
    assert sess.control_override is not None

    hub.clear_projection_for_rehydrate(THREAD)
    assert sess.control_override is None
    assert sess.run_started_at is None
