"""TaskOutput wait must seed live-run rows so Gateway reconcile stays off."""

from __future__ import annotations

from evoflow.persistence.live_run_repositories import (
    get_live_run_snapshot,
    update_live_run_heartbeat,
)


def test_heartbeat_upserts_when_snapshot_missing(monkeypatch):
    """No frontend PUT yet → pulse must INSERT, not no-op UPDATE."""
    rows: dict[str, dict] = {}
    sessions = {
        "sess-wait": {"thread_id": "tid-1", "current_run_id": "run-abc", "updated_at": "old"},
    }

    class _Cur:
        def __init__(self, rowcount: int = 0, row=None):
            self.rowcount = rowcount
            self._row = row

        def fetchone(self):
            return self._row

    class _DB:
        def execute(self, sql: str, params=()):
            s = " ".join(sql.split())
            if s.startswith("UPDATE evoflow_chat_live_runs SET last_event_at"):
                sk = params[2]
                if sk in rows:
                    rows[sk]["last_event_at"] = params[0]
                    rows[sk]["updated_at"] = params[1]
                    return _Cur(1)
                return _Cur(0)
            if s.startswith("SELECT thread_id, current_run_id"):
                sk = params[0]
                sess = sessions.get(sk)
                if not sess:
                    return _Cur(0, None)
                return _Cur(1, {"thread_id": sess["thread_id"], "current_run_id": sess["current_run_id"]})
            if s.startswith("INSERT INTO evoflow_chat_live_runs"):
                sk, tid, rid, event_at, updated_at = params
                rows[sk] = {
                    "session_key": sk,
                    "thread_id": tid,
                    "run_id": rid,
                    "status": "running",
                    "last_event_at": event_at,
                    "updated_at": updated_at,
                }
                return _Cur(1)
            if s.startswith("UPDATE evoflow_chat_sessions SET updated_at"):
                sk = params[1]
                if sk in sessions:
                    sessions[sk]["updated_at"] = params[0]
                return _Cur(1)
            raise AssertionError(f"unexpected sql: {s}")

    def _tx(fn):
        return fn(_DB())

    monkeypatch.setattr(
        "evoflow.persistence.live_run_repositories.run_db_transaction",
        _tx,
    )

    ms = update_live_run_heartbeat("sess-wait")
    assert ms > 0
    assert "sess-wait" in rows
    assert rows["sess-wait"]["run_id"] == "run-abc"
    assert rows["sess-wait"]["thread_id"] == "tid-1"
    assert sessions["sess-wait"]["updated_at"] != "old"


def test_heartbeat_updates_existing_snapshot(monkeypatch):
    rows = {
        "sess-hot": {
            "session_key": "sess-hot",
            "thread_id": "t",
            "run_id": "r",
            "status": "running",
            "last_event_at": "old",
            "updated_at": "old",
        }
    }
    sessions = {"sess-hot": {"updated_at": "old"}}

    class _Cur:
        def __init__(self, rowcount: int = 0):
            self.rowcount = rowcount

    class _DB:
        def execute(self, sql: str, params=()):
            s = " ".join(sql.split())
            if s.startswith("UPDATE evoflow_chat_live_runs SET last_event_at"):
                sk = params[2]
                rows[sk]["last_event_at"] = params[0]
                rows[sk]["updated_at"] = params[1]
                return _Cur(1)
            if s.startswith("UPDATE evoflow_chat_sessions SET updated_at"):
                sessions[params[1]]["updated_at"] = params[0]
                return _Cur(1)
            raise AssertionError(s)

    monkeypatch.setattr(
        "evoflow.persistence.live_run_repositories.run_db_transaction",
        lambda fn: fn(_DB()),
    )

    ms = update_live_run_heartbeat("sess-hot")
    assert ms > 0
    assert rows["sess-hot"]["last_event_at"] != "old"
    assert sessions["sess-hot"]["updated_at"] != "old"
    # ensure get helper still importable
    assert get_live_run_snapshot  # noqa: B018
