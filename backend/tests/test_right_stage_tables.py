"""右栏 SQLite：实时表 + 轨迹表。"""

from __future__ import annotations

import sqlite3

import pytest

from evoflow.persistence import right_stage_tables as rst


@pytest.fixture()
def mem_db(monkeypatch):
    # check_same_thread=False：后台 persist worker 与测试主线程共用同一连接
    conn = sqlite3.connect(":memory:", check_same_thread=False)
    conn.row_factory = sqlite3.Row
    rst.ensure_right_stage_tables(conn)

    class _Wrap:
        def execute(self, *a, **k):
            return conn.execute(*a, **k)

        def executemany(self, *a, **k):
            return conn.executemany(*a, **k)

        def executescript(self, *a, **k):
            return conn.executescript(*a, **k)

        def commit(self):
            return conn.commit()

        def __getattr__(self, name):
            return getattr(conn, name)

    wrap = _Wrap()
    monkeypatch.setattr(rst, "get_db", lambda: wrap, raising=False)

    # persist imports get_db from evoflow.persistence.db — patch that too
    import evoflow.persistence.db as dbmod

    monkeypatch.setattr(dbmod, "get_db", lambda: wrap)
    yield wrap
    conn.close()


def test_persist_upserts_live_and_session_and_trails_open_close(mem_db):
    rst.persist_right_stage_report(
        {
            "sessionKey": "agent:main:A",
            "activeKey": "file:a.txt",
            "activeKind": "file",
            "activeTitle": "a.txt",
            "collapsed": False,
            "rev": 1,
            "reportedAt": "2026-11-26T01:00:00Z",
            "tabs": [
                {
                    "key": "file:a.txt",
                    "id": "a.txt",
                    "kind": "file",
                    "title": "a.txt",
                    "ord": 0,
                    "openedBy": "user",
                }
            ],
            "tabOrder": ["file:a.txt"],
        }
    )

    live = rst.read_right_stage_current(rst.LIVE_SCOPE)
    assert live is not None
    assert live["activeKey"] == "file:a.txt"
    assert live["tabOrder"] == ["file:a.txt"]
    assert live["sessionKey"] == "agent:main:A"

    sess = rst.read_right_stage_current("agent:main:A")
    assert sess is not None
    assert len(sess["tabs"]) == 1

    trail = rst.read_right_stage_trail(session_key="agent:main:A", limit=20)
    opens = [e for e in trail if e["event"] == "open"]
    assert any(e["tabKey"] == "file:a.txt" for e in opens)

    # 关掉签
    rst.persist_right_stage_report(
        {
            "sessionKey": "agent:main:A",
            "activeKey": None,
            "activeKind": None,
            "activeTitle": None,
            "collapsed": True,
            "rev": 2,
            "reportedAt": "2026-11-26T01:01:00Z",
            "tabs": [],
            "tabOrder": [],
        }
    )
    trail2 = rst.read_right_stage_trail(session_key="agent:main:A", limit=50)
    closes = [e for e in trail2 if e["event"] == "close"]
    assert any(e["tabKey"] == "file:a.txt" for e in closes)
    collapses = [e for e in trail2 if e["event"] == "collapse"]
    assert collapses

    cur = rst.read_right_stage_current("agent:main:A")
    assert cur is not None
    assert cur["tabs"] == []
    assert cur["collapsed"] is True


def test_schedule_persist_coalesces_and_writes_async(mem_db):
    rst.schedule_persist_right_stage_report(
        {
            "sessionKey": "sk-bg",
            "activeKey": "file:1",
            "collapsed": False,
            "rev": 1,
            "tabs": [{"key": "file:1", "id": "1", "kind": "file", "title": "1", "ord": 0}],
        }
    )
    rst.schedule_persist_right_stage_report(
        {
            "sessionKey": "sk-bg",
            "activeKey": "file:2",
            "collapsed": False,
            "rev": 2,
            "tabs": [
                {"key": "file:1", "id": "1", "kind": "file", "title": "1", "ord": 0},
                {"key": "file:2", "id": "2", "kind": "file", "title": "2", "ord": 1},
            ],
        }
    )
    assert rst.flush_persist_right_stage_for_tests(2.0) is True
    live = rst.read_right_stage_current(rst.LIVE_SCOPE)
    assert live is not None
    assert live["rev"] == 2
    assert live["activeKey"] == "file:2"


def test_prune_right_stage_trail_keeps_two_days(tmp_path, monkeypatch):
    db_path = tmp_path / "evoflow.db"
    conn = sqlite3.connect(str(db_path))
    rst.ensure_right_stage_tables(conn)
    conn.execute(
        """
        INSERT INTO evoflow_right_stage_trail (
            created_at, session_key, event, tab_key, kind, title, opened_by,
            active_key_before, active_key_after, detail_json, rev
        ) VALUES
        ('2026-11-20T10:00:00.000Z', 'sk', 'open', 'a', 'file', '', '', NULL, NULL, '{}', 1),
        ('2026-11-25T10:00:00.000Z', 'sk', 'open', 'b', 'file', '', '', NULL, NULL, '{}', 2),
        ('2026-11-26T01:00:00.000Z', 'sk', 'close', 'b', 'file', '', '', NULL, NULL, '{}', 3)
        """
    )
    conn.commit()
    conn.close()

    monkeypatch.setattr(
        "evoflow.persistence.db.resolve_evolflow_db_path",
        lambda: db_path,
    )
    # 冻结「今天」= 2026-11-26 → keep_days=2 → cutoff=2026-11-24 → 删 11-20
    class _FrozenDateTime:
        @staticmethod
        def now(tz=None):
            from datetime import datetime, timezone

            return datetime(2026, 11, 26, 12, 0, 0, tzinfo=timezone.utc)

    monkeypatch.setattr(rst, "datetime", _FrozenDateTime)

    deleted = rst.prune_right_stage_trail(days=2)
    assert deleted == 1

    conn = sqlite3.connect(str(db_path))
    left = [
        r[0]
        for r in conn.execute(
            "SELECT tab_key FROM evoflow_right_stage_trail ORDER BY id"
        ).fetchall()
    ]
    conn.close()
    assert left == ["b", "b"]


def test_activate_and_reorder_events(mem_db):
    rst.persist_right_stage_report(
        {
            "sessionKey": "sk1",
            "activeKey": "web-embed:1",
            "collapsed": False,
            "rev": 1,
            "tabs": [
                {"key": "web-embed:1", "id": "1", "kind": "web-embed", "title": "一", "ord": 0},
                {"key": "file:b", "id": "b", "kind": "file", "title": "b", "ord": 1},
            ],
        }
    )
    rst.persist_right_stage_report(
        {
            "sessionKey": "sk1",
            "activeKey": "file:b",
            "collapsed": False,
            "rev": 2,
            "tabs": [
                {"key": "file:b", "id": "b", "kind": "file", "title": "b", "ord": 0},
                {"key": "web-embed:1", "id": "1", "kind": "web-embed", "title": "一", "ord": 1},
            ],
        }
    )
    events = rst.read_right_stage_trail(session_key="sk1", limit=50)
    kinds = {e["event"] for e in events}
    assert "activate" in kinds
    assert "reorder" in kinds
