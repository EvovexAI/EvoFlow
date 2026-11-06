"""Regression: tables/columns shipped after the baseline epoch must be added to
DBs that already sit at ``APP_SCHEMA_VERSION``.

``_backfill_legacy_columns`` and the baseline ``CREATE TABLE IF NOT EXISTS``
only run from ``_apply_baseline`` / ``_snap_legacy_user_version``. A database
created before a table/column was added is already stamped ``user_version=1``,
so it never reaches those paths. Result on a real install:

* ``workflow.create`` died on ``evoflow_apps.project_path``
* chat history died on ``evoflow_chat_messages.turn_started_at``
* feishu/wecom binding paths died on ``evoflow_role_push_bindings``

Fresh installs (``user_version=0``) were never affected.
"""

from __future__ import annotations

import sqlite3
import uuid

import pytest

_POST_BASELINE_COLUMNS = {
    "evoflow_apps": ("project_path",),
    "evoflow_chat_messages": ("turn_started_at", "turn_duration_ms", "turn_state"),
}


def _columns(conn: sqlite3.Connection, table: str) -> set[str]:
    return {str(r[1]) for r in conn.execute(f"PRAGMA table_info({table})").fetchall()}


def _tables(conn: sqlite3.Connection) -> set[str]:
    return {str(r[0]) for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}


def _legacy_db_without_post_baseline(tmp_path) -> sqlite3.Connection:
    """A DB shaped like an older install: baseline minus post-epoch additions."""
    from evoflow.persistence.schema import _POST_BASELINE_TABLES, _BASELINE_DDL

    conn = sqlite3.connect(str(tmp_path / f"legacy_{uuid.uuid4().hex[:8]}.db"))
    conn.executescript(_BASELINE_DDL)
    for table, cols in _POST_BASELINE_COLUMNS.items():
        for col in cols:
            conn.execute(f"ALTER TABLE {table} DROP COLUMN {col}")
    for table in _POST_BASELINE_TABLES:
        conn.execute(f'DROP TABLE IF EXISTS "{table}"')
    conn.execute("PRAGMA user_version = 1")
    conn.commit()
    return conn


def test_post_baseline_columns_added_to_current_version_db(tmp_path):
    from evoflow.persistence.schema import ensure_app_schema

    conn = _legacy_db_without_post_baseline(tmp_path)
    for table, cols in _POST_BASELINE_COLUMNS.items():
        assert not (set(cols) & _columns(conn, table)), "precondition: column missing"

    ensure_app_schema(conn)

    for table, cols in _POST_BASELINE_COLUMNS.items():
        missing = set(cols) - _columns(conn, table)
        assert not missing, f"{table} still missing {missing} after ensure_app_schema"


def test_post_baseline_tables_created_on_current_version_db(tmp_path):
    from evoflow.persistence.schema import _POST_BASELINE_TABLES, ensure_app_schema

    conn = _legacy_db_without_post_baseline(tmp_path)
    absent = set(_POST_BASELINE_TABLES) - _tables(conn)
    assert absent == set(_POST_BASELINE_TABLES), "precondition: tables missing"

    ensure_app_schema(conn)

    missing = set(_POST_BASELINE_TABLES) - _tables(conn)
    assert not missing, f"tables still missing after ensure_app_schema: {missing}"


def test_chat_history_query_works_after_upgrade(tmp_path):
    """The real production SELECT must run against an upgraded legacy DB."""
    from evoflow.persistence.chat_message_repositories import _SELECT_COLS
    from evoflow.persistence.schema import ensure_app_schema

    conn = _legacy_db_without_post_baseline(tmp_path)
    ensure_app_schema(conn)
    # Raises sqlite3.DatabaseError("no such column: turn_state") before the fix.
    conn.execute(f"SELECT {_SELECT_COLS} FROM evoflow_chat_messages LIMIT 1").fetchall()


def test_post_baseline_backfill_is_idempotent(tmp_path):
    from evoflow.persistence.schema import ensure_app_schema

    conn = _legacy_db_without_post_baseline(tmp_path)
    ensure_app_schema(conn)
    before_cols = _columns(conn, "evoflow_apps")
    before_tables = _tables(conn)
    ensure_app_schema(conn)
    ensure_app_schema(conn)
    assert _columns(conn, "evoflow_apps") == before_cols
    assert _tables(conn) == before_tables


def test_fresh_install_has_everything(tmp_path):
    """New users start at user_version=0 and must get the full schema."""
    from evoflow.persistence.schema import _POST_BASELINE_TABLES, ensure_app_schema

    conn = sqlite3.connect(str(tmp_path / f"fresh_{uuid.uuid4().hex[:8]}.db"))
    assert conn.execute("PRAGMA user_version").fetchone()[0] == 0
    ensure_app_schema(conn)
    assert conn.execute("PRAGMA user_version").fetchone()[0] == 1
    for table, cols in _POST_BASELINE_COLUMNS.items():
        missing = set(cols) - _columns(conn, table)
        assert not missing, f"fresh install missing {table}.{missing}"
    assert not (set(_POST_BASELINE_TABLES) - _tables(conn))


@pytest.mark.parametrize("table,column", [("evoflow_apps", "project_path")])
def test_column_accepts_writes_with_default(tmp_path, table, column):
    """NOT NULL DEFAULT '' must let legacy inserts (that omit the column) pass."""
    from evoflow.persistence.schema import ensure_app_schema

    conn = _legacy_db_without_post_baseline(tmp_path)
    ensure_app_schema(conn)
    conn.execute("INSERT INTO evoflow_apps (id, name) VALUES ('A1', 'n')")
    conn.commit()
    row = conn.execute(f"SELECT {column} FROM {table} WHERE id = 'A1'").fetchone()
    assert row is not None and row[0] == ""
