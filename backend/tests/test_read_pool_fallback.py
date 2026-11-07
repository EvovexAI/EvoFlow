"""Regression: read-pool fallback when the DB file does not exist yet.

Fresh install: the very first read can arrive before the DB file is created.
The read pool opens with ``mode=ro``, which fails on a missing file — reads must
fall back to the shared write connection instead of raising.
"""

from __future__ import annotations

import os
import sqlite3
import tempfile
from pathlib import Path


def test_read_falls_back_when_db_file_missing() -> None:
    from evoflow.persistence import db as dbm

    d = Path(tempfile.mkdtemp())
    os.environ["EVOFLOW_DB_PATH"] = str(d / "evoflow.db")
    dbm._read_pool = None
    dbm._cached_default_path = None
    dbm.reset_db_for_tests()
    try:
        # File really does not exist yet.
        assert not (d / "evoflow.db").exists()

        # The write connection creates the file (and the schema).
        conn = dbm.get_db()
        conn.execute("CREATE TABLE IF NOT EXISTS t_probe (id INTEGER PRIMARY KEY, v TEXT)")
        conn.commit()

        def _q(c: sqlite3.Connection) -> int:
            return int(c.execute("SELECT COUNT(*) FROM t_probe").fetchone()[0])

        assert dbm.run_db_read(_q) == 0
    finally:
        dbm.reset_db_for_tests()
        dbm._read_pool = None
        os.environ.pop("EVOFLOW_DB_PATH", None)


def test_read_pool_used_when_db_exists() -> None:
    from evoflow.persistence import db as dbm

    d = Path(tempfile.mkdtemp())
    os.environ["EVOFLOW_DB_PATH"] = str(d / "evoflow.db")
    dbm._read_pool = None
    dbm._cached_default_path = None
    dbm.reset_db_for_tests()
    try:
        conn = dbm.get_db()
        conn.execute("CREATE TABLE IF NOT EXISTS t_probe (id INTEGER PRIMARY KEY, v TEXT)")
        conn.commit()

        def _q(c: sqlite3.Connection) -> int:
            return int(c.execute("SELECT COUNT(*) FROM t_probe").fetchone()[0])

        assert dbm.run_db_read(_q) == 0
        # Pool is live now.
        assert dbm._read_pool is not None
    finally:
        dbm.reset_db_for_tests()
        dbm._read_pool = None
        os.environ.pop("EVOFLOW_DB_PATH", None)
