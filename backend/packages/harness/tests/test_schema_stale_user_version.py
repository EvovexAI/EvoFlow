"""Legacy pre-1.0 user_version snap onto the public schema epoch."""

from __future__ import annotations

import sqlite3

from evoflow.persistence.schema import (
    APP_SCHEMA_VERSION,
    _snap_legacy_user_version,
    ensure_app_schema,
)


def test_snap_legacy_user_version_when_markers_present() -> None:
    conn = sqlite3.connect(":memory:")
    conn.execute("PRAGMA user_version = 91")
    for table in (
        "evoflow_proactive_initiatives",
        "evoflow_chat_messages",
        "evoflow_usage_events",
        "evoflow_principals",
    ):
        conn.execute(f"CREATE TABLE {table} (id INTEGER PRIMARY KEY)")
    conn.commit()

    snapped = _snap_legacy_user_version(conn, 91)
    assert snapped == APP_SCHEMA_VERSION
    assert int(conn.execute("PRAGMA user_version").fetchone()[0]) == APP_SCHEMA_VERSION
    conn.close()


def test_ensure_app_schema_preserves_rows_when_snapping_legacy() -> None:
    """Legacy ladder version + marker tables: snap epoch, keep existing rows."""
    conn = sqlite3.connect(":memory:")
    conn.execute("PRAGMA user_version = 8")
    conn.executescript(
        """
        CREATE TABLE evoflow_chat_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_key TEXT NOT NULL,
            seq INTEGER NOT NULL,
            role TEXT NOT NULL,
            message_id TEXT,
            content_json TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL DEFAULT '',
            updated_at TEXT NOT NULL DEFAULT '',
            round_id TEXT,
            UNIQUE(session_key, seq)
        );
        INSERT INTO evoflow_chat_messages(
            session_key, seq, role, message_id, content_json, created_at, updated_at
        ) VALUES ('sk', 1, 'user', 'm1', '{}', 't', 't');

        CREATE TABLE evoflow_proactive_initiatives (id TEXT PRIMARY KEY);
        CREATE TABLE evoflow_usage_events (id INTEGER PRIMARY KEY);
        CREATE TABLE evoflow_principals (id TEXT PRIMARY KEY);
        """
    )
    conn.commit()

    ensure_app_schema(conn)

    row = conn.execute(
        "SELECT message_id FROM evoflow_chat_messages WHERE session_key='sk'"
    ).fetchone()
    assert row is not None
    assert row[0] == "m1"
    assert int(conn.execute("PRAGMA user_version").fetchone()[0]) == APP_SCHEMA_VERSION
    conn.close()


def test_fresh_db_applies_baseline_to_version_1() -> None:
    conn = sqlite3.connect(":memory:")
    ensure_app_schema(conn)
    assert int(conn.execute("PRAGMA user_version").fetchone()[0]) == APP_SCHEMA_VERSION
    assert conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='evoflow_apps'"
    ).fetchone()
    conn.close()
