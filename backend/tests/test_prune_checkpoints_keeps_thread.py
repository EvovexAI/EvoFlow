"""Regression: the checkpoint pruner must TRIM history, never delete a whole thread.

The bug
-------
``prune_inactive_checkpoints.py`` built the "rows to drop" list with::

    "SELECT checkpoint_id FROM checkpoints WHERE thread_id = ? "
    "AND checkpoint_id NOT IN (?)",
    (tid, ",".join(keep_ids)),

``NOT IN (?)`` with a single parameter compares against ONE string
``"cp1,cp2,cp3"`` -- not against the three ids.  No checkpoint_id equals that
comma-joined blob, so the predicate matched **every** row of the thread and the
whole thread was deleted, writes included.

That is the "the live thread's row count went 62 -> 0 -> 26" wave that was
observed on 2026-10-25: the pruner was not trimming history, it was dropping
the thread.  A live run standing on an older checkpoint could lose it.

The fix keeps the parameter list expanded (one ``?`` per id), so only the rows
outside the keep-window are dropped.

The test
--------
Build a throwaway database with a 30-row thread, run the pruner with
``--keep 5 --include-active --active-keep 20``, and assert the thread is still
there with exactly ``active_keep`` rows -- and that the newest checkpoint
survived (that is the one a resuming run would stand on).
"""
from __future__ import annotations

import json
import sqlite3
import subprocess
import sys
from pathlib import Path

import pytest

SCRIPT = (
    Path(__file__).resolve().parents[1]
    / "scripts"
    / "prune_inactive_checkpoints.py"
)

THREAD = "TESTTHREAD0001ZZZ"


def _make_db(path: Path, rows: int = 30) -> None:
    con = sqlite3.connect(path)
    cur = con.cursor()
    cur.execute(
        "CREATE TABLE checkpoints ("
        " thread_id TEXT, checkpoint_ns TEXT, checkpoint_id TEXT,"
        " parent_checkpoint_id TEXT, type TEXT, checkpoint TEXT, metadata TEXT)"
    )
    cur.execute(
        "CREATE TABLE writes ("
        " thread_id TEXT, checkpoint_ns TEXT, checkpoint_id TEXT, task_id TEXT,"
        " idx INTEGER, channel TEXT, type TEXT, value TEXT)"
    )
    for i in range(rows):
        cid = "cp%02d" % i
        cur.execute(
            "INSERT INTO checkpoints VALUES (?,?,?,?,?,?,?)",
            (THREAD, "", cid, "", "test", json.dumps({"blob": "x" * 64}), "{}"),
        )
        cur.execute(
            "INSERT INTO writes VALUES (?,?,?,?,?,?,?,?)",
            (THREAD, "", cid, "t", i, "updates", "test", json.dumps({"w": "y" * 16})),
        )
    con.commit()
    con.close()


def _counts(path: Path) -> tuple[int, int, list[str]]:
    con = sqlite3.connect(path)
    cur = con.cursor()
    n_cp = cur.execute(
        "SELECT COUNT(*) FROM checkpoints WHERE thread_id = ?", (THREAD,)
    ).fetchone()[0]
    n_w = cur.execute(
        "SELECT COUNT(*) FROM writes WHERE thread_id = ?", (THREAD,)
    ).fetchone()[0]
    ids = [
        str(r[0])
        for r in cur.execute(
            "SELECT checkpoint_id FROM checkpoints WHERE thread_id = ? ORDER BY rowid",
            (THREAD,),
        ).fetchall()
    ]
    con.close()
    return n_cp, n_w, ids


@pytest.mark.skipif(not SCRIPT.is_file(), reason="pruner script not present")
def test_pruner_trims_history_and_keeps_the_thread(tmp_path: Path) -> None:
    db = tmp_path / "cp.db"
    _make_db(db, rows=30)
    before = _counts(db)
    assert before[0] == 30

    proc = subprocess.run(
        [
            sys.executable, str(SCRIPT),
            "--db", str(db),
            "--keep", "5",
            "--include-active",
            "--active-keep", "20",
        ],
        capture_output=True, text=True, timeout=120,
    )
    assert proc.returncode == 0, proc.stdout + proc.stderr

    n_cp, n_w, ids = _counts(db)

    # The whole point: the thread must survive.
    assert n_cp > 0, "the pruner deleted the whole thread (the NOT IN (?) bug)"
    # ... trimmed down to the keep window, not left at 30 and not at 0.
    assert n_cp == 20, f"expected the active-keep window (20), got {n_cp}"
    assert n_w == 20, f"writes should follow the same window, got {n_w}"
    # The newest checkpoint is the one a resuming run stands on -> it must be there.
    assert "cp29" in ids, "the newest checkpoint was dropped"
    # The oldest ones are the history that is supposed to be trimmed.
    assert "cp00" not in ids, "old history was not trimmed"


@pytest.mark.skipif(not SCRIPT.is_file(), reason="pruner script not present")
def test_pruner_leaves_short_threads_alone(tmp_path: Path) -> None:
    """A thread with fewer rows than the keep window must not be touched."""
    db = tmp_path / "short.db"
    _make_db(db, rows=3)
    proc = subprocess.run(
        [
            sys.executable, str(SCRIPT),
            "--db", str(db),
            "--keep", "5",
            "--include-active",
            "--active-keep", "20",
        ],
        capture_output=True, text=True, timeout=120,
    )
    assert proc.returncode == 0, proc.stdout + proc.stderr
    n_cp, n_w, ids = _counts(db)
    assert n_cp == 3
    assert n_w == 3
    assert ids == ["cp00", "cp01", "cp02"]
