"""usage_events retention: day prune + oversized meta_json strip."""

from __future__ import annotations

from pathlib import Path

import pytest

from evoflow.persistence import data_retention as dr


@pytest.fixture()
def usage_db(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    db = tmp_path / "evoflow.db"
    import sqlite3

    conn = sqlite3.connect(str(db))
    conn.execute(
        """
        CREATE TABLE evoflow_usage_events (
          id TEXT, event_id TEXT, occurred_at TEXT, category TEXT,
          quantity REAL, amount REAL, meta_json TEXT
        )
        """
    )
    conn.execute(
        "INSERT INTO evoflow_usage_events VALUES ('1','e1','2020-01-01T00:00:00.000+08:00','llm',1,0,?)",
        ("x" * 100_000,),
    )
    conn.execute(
        "INSERT INTO evoflow_usage_events VALUES ('2','e2','2099-01-01T00:00:00.000+08:00','llm',1,0,?)",
        ("ok",),
    )
    conn.commit()
    conn.close()

    monkeypatch.setenv("EVOFLOW_DB_PATH", str(db))
    from evoflow.persistence import db as dbmod

    dbmod.reset_db_for_tests()
    return db


def test_prune_usage_events_deletes_old_rows(usage_db: Path) -> None:
    deleted = dr.prune_usage_events(days=30)
    assert deleted == 1
    import sqlite3

    n = sqlite3.connect(str(usage_db)).execute("SELECT COUNT(*) FROM evoflow_usage_events").fetchone()[0]
    assert n == 1


def test_strip_usage_meta_replaces_oversized(usage_db: Path) -> None:
    # Keep both rows; only strip fat meta on the old one before prune.
    stripped = dr.strip_usage_events_heavy_meta(json_limit=1024)
    assert stripped == 1
    import sqlite3

    rows = sqlite3.connect(str(usage_db)).execute(
        "SELECT id, meta_json FROM evoflow_usage_events ORDER BY id"
    ).fetchall()
    assert rows[0][1] == "{}"
    assert rows[1][1] == "ok"
