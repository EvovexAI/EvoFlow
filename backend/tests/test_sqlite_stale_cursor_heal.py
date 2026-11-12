"""Shared-connection SELECT must not leave unread rows for a concurrent writer."""

from __future__ import annotations

import threading
import time

import pytest

from evoflow.persistence import db as db_mod


@pytest.fixture()
def shared_db(tmp_path, monkeypatch: pytest.MonkeyPatch):
    path = tmp_path / "stale-cursor.db"
    monkeypatch.setenv("EVOFLOW_DB_PATH", str(path))
    db_mod.reset_db_for_tests()
    conn = db_mod.get_db()
    conn.execute("CREATE TABLE IF NOT EXISTS stale_probe (id INTEGER PRIMARY KEY, v TEXT)")
    conn.commit()
    yield conn
    db_mod.reset_db_for_tests()


def test_select_then_write_on_shared_connection(shared_db) -> None:
    db = shared_db
    db.execute("DELETE FROM stale_probe")
    db.executemany("INSERT INTO stale_probe(v) VALUES (?)", [("a",), ("b",), ("c",)])
    db.commit()

    # Classic race shape: execute SELECT, then a write, then fetch — must not raise.
    cur = db.execute("SELECT id, v FROM stale_probe ORDER BY id")
    db.execute("INSERT INTO stale_probe(v) VALUES (?)", ("d",))
    db.commit()
    rows = cur.fetchall()
    assert len(rows) >= 3


def test_concurrent_select_and_upsert(shared_db) -> None:
    db = shared_db
    db.execute("DELETE FROM stale_probe")
    db.executemany(
        "INSERT INTO stale_probe(v) VALUES (?)",
        [(f"r{i}",) for i in range(50)],
    )
    db.commit()

    errors: list[BaseException] = []
    stop = threading.Event()

    def reader() -> None:
        while not stop.is_set():
            try:
                rows = db_mod.get_db().execute("SELECT id, v FROM stale_probe").fetchall()
                assert rows is not None
            except BaseException as exc:  # noqa: BLE001 - collect any failure
                errors.append(exc)
                return

    def writer() -> None:
        for i in range(80):
            try:
                def _write(i=i) -> None:
                    db_mod.get_db().execute(
                        "INSERT INTO stale_probe(v) VALUES (?)",
                        (f"w{i}",),
                    )
                    db_mod.get_db().commit()

                db_mod.run_db_with_retry(_write)
            except BaseException as exc:  # noqa: BLE001
                errors.append(exc)
                return
            time.sleep(0.001)

    t_r = threading.Thread(target=reader, name="stale-reader")
    t_w = threading.Thread(target=writer, name="stale-writer")
    t_r.start()
    t_w.start()
    t_w.join(timeout=10)
    stop.set()
    t_r.join(timeout=5)
    assert not errors, f"shared-conn race errors: {errors!r}"


def test_is_stale_cursor_error_matches_sqlite_message() -> None:
    assert db_mod._is_stale_cursor_error(Exception("DatabaseError: another row available"))
    assert db_mod._is_stale_cursor_error(Exception("you can only execute one statement at a time"))
    assert not db_mod._is_stale_cursor_error(Exception("database is locked"))
