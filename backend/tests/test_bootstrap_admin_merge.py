"""Bootstrap ``local-admin`` must not survive next to the real WebUI admin.

Covers:
* ``get_or_create_local_admin`` resolves to the primary WebUI admin principal
  (not the bootstrap row) once the operator has a login account;
* the bootstrap principal is only created as a last resort and never carries a
  user-visible "Local Admin" display name;
* ``merge_bootstrap_admin_into_primary`` re-attributes sessions, participants,
  usage, grants, apps, panel settings and workspaces, and is idempotent.

Run: cd backend && python -m pytest tests/test_bootstrap_admin_merge.py -v
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from evoflow.persistence.bootstrap_admin_merge import (
    BOOTSTRAP_PRINCIPAL_ID,
    MIGRATION_MARKER_KEY,
    merge_bootstrap_admin_into_primary,
)

SCHEMA = """
CREATE TABLE evoflow_principals (
    principal_id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    principal_type TEXT NOT NULL,
    display_name TEXT NOT NULL,
    primary_email TEXT,
    status TEXT NOT NULL,
    team_ids_json TEXT NOT NULL DEFAULT '[]',
    attrs_json TEXT NOT NULL DEFAULT '{}',
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL
);
CREATE TABLE evoflow_principal_identities (
    org_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    external_id TEXT NOT NULL,
    principal_id TEXT NOT NULL,
    PRIMARY KEY (org_id, provider, external_id)
);
CREATE TABLE evoflow_webui_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL DEFAULT 'admin',
    password_hash TEXT NOT NULL,
    is_primary INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE TABLE evoflow_admin_grants (
    org_id TEXT NOT NULL,
    principal_id TEXT NOT NULL,
    role TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    granted_by TEXT,
    created_at REAL NOT NULL,
    PRIMARY KEY (org_id, principal_id, scope_id, role)
);
CREATE TABLE evoflow_chat_sessions (
    session_key TEXT PRIMARY KEY,
    org_id TEXT NOT NULL DEFAULT '',
    scope_id TEXT NOT NULL DEFAULT '',
    created_by TEXT NOT NULL DEFAULT '',
    context_json TEXT,
    local_workspace_root TEXT
);
CREATE TABLE evoflow_session_participants (
    session_key TEXT NOT NULL,
    principal_id TEXT NOT NULL,
    joined_at REAL NOT NULL,
    left_at REAL,
    PRIMARY KEY (session_key, principal_id)
);
CREATE TABLE evoflow_usage_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    principal_id TEXT NOT NULL DEFAULT ''
);
CREATE TABLE evoflow_usage_daily (
    day TEXT NOT NULL,
    category TEXT NOT NULL,
    subcategory TEXT NOT NULL DEFAULT '',
    sku TEXT NOT NULL DEFAULT '',
    subject_type TEXT NOT NULL,
    subject_id TEXT NOT NULL DEFAULT '',
    principal_id TEXT NOT NULL DEFAULT '',
    quantity_sum REAL NOT NULL DEFAULT 0,
    quantity_in_sum REAL NOT NULL DEFAULT 0,
    quantity_out_sum REAL NOT NULL DEFAULT 0,
    amount_sum REAL NOT NULL DEFAULT 0,
    event_count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, category, subcategory, sku, subject_type, subject_id, principal_id)
);
CREATE TABLE evoflow_apps (
    app_id TEXT PRIMARY KEY,
    created_by TEXT NOT NULL DEFAULT '',
    owner_scope_id TEXT NOT NULL DEFAULT ''
);
CREATE TABLE evoflow_app_settings (
    key TEXT PRIMARY KEY,
    value_text TEXT,
    value_json TEXT,
    updated_at TEXT NOT NULL
);
CREATE TABLE evoflow_workspaces (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_path TEXT NOT NULL UNIQUE,
    owner_scope_id TEXT NOT NULL DEFAULT '',
    org_id TEXT NOT NULL DEFAULT ''
);
"""


def _seed(conn: sqlite3.Connection) -> None:
    conn.executescript(SCHEMA)
    conn.executemany(
        "INSERT INTO evoflow_principals (principal_id, org_id, principal_type, display_name, "
        "primary_email, status, created_at, updated_at) VALUES (?, 'local', 'internal', ?, NULL, 'active', ?, ?)",
        [
            (BOOTSTRAP_PRINCIPAL_ID, "Local Admin", 1.0, 1.0),
            ("admin", "admin", 2.0, 2.0),
        ],
    )
    conn.execute(
        "INSERT INTO evoflow_webui_users (id, username, password_hash, is_primary, created_at, updated_at) "
        "VALUES (1, 'admin', 'h', 1, 2, 2)"
    )
    conn.executemany(
        "INSERT INTO evoflow_principal_identities (org_id, provider, external_id, principal_id) VALUES (?, ?, ?, ?)",
        [("local", "webui", "1", "admin"), ("local", "webui_username", "admin", "admin")],
    )
    conn.executemany(
        "INSERT INTO evoflow_admin_grants (org_id, principal_id, role, scope_id, granted_by, created_at) "
        "VALUES ('local', ?, 'org_admin', 'org:local', NULL, ?)",
        [(BOOTSTRAP_PRINCIPAL_ID, 1.0), ("admin", 2.0)],
    )
    # One rpc session newer than the other, plus a legacy JSON blob.
    conn.executemany(
        "INSERT INTO evoflow_chat_sessions (session_key, org_id, scope_id, created_by, context_json, "
        "local_workspace_root) VALUES (?, 'local', ?, ?, ?, ?)",
        [
            (
                "agent:main:new-1",
                f"personal:{BOOTSTRAP_PRINCIPAL_ID}",
                BOOTSTRAP_PRINCIPAL_ID,
                '{"created_by": "local-admin", "principal_id": "local-admin", '
                '"local_workspace_root": "C:/x/scopes/personal/local-admin/files"}',
                "C:/x/scopes/personal/local-admin/files",
            ),
            (
                "agent:main:new-2",
                f"personal:{BOOTSTRAP_PRINCIPAL_ID}",
                BOOTSTRAP_PRINCIPAL_ID,
                '{"agent_name": "main"}',
                None,
            ),
        ],
    )
    conn.executemany(
        "INSERT INTO evoflow_session_participants (session_key, principal_id, joined_at) VALUES (?, ?, 1.0)",
        [("agent:main:new-1", BOOTSTRAP_PRINCIPAL_ID), ("agent:main:new-2", "admin")],
    )
    conn.executemany(
        "INSERT INTO evoflow_usage_events (principal_id) VALUES (?)", [(BOOTSTRAP_PRINCIPAL_ID,)] * 3
    )
    conn.executemany(
        "INSERT INTO evoflow_usage_daily (day, category, subject_type, principal_id, quantity_sum, event_count) "
        "VALUES ('2026-10-21', 'llm', 'install', ?, ?, ?)",
        [(BOOTSTRAP_PRINCIPAL_ID, 100.0, 2), ("admin", 50.0, 1)],
    )
    conn.execute(
        "INSERT INTO evoflow_apps (app_id, created_by, owner_scope_id) VALUES ('App_1', ?, ?)",
        (BOOTSTRAP_PRINCIPAL_ID, f"personal:{BOOTSTRAP_PRINCIPAL_ID}"),
    )
    conn.execute(
        "INSERT INTO evoflow_app_settings (key, value_text, value_json, updated_at) VALUES (?, NULL, '{}', '')",
        (f"panel.ui:{BOOTSTRAP_PRINCIPAL_ID}",),
    )
    conn.execute(
        "INSERT INTO evoflow_workspaces (workspace_path, owner_scope_id, org_id) VALUES (?, ?, 'local')",
        ("C:/x/scopes/personal/local-admin/files", f"personal:{BOOTSTRAP_PRINCIPAL_ID}"),
    )
    conn.commit()


@pytest.fixture()
def conn() -> sqlite3.Connection:
    c = sqlite3.connect(":memory:")
    c.row_factory = sqlite3.Row
    _seed(c)
    yield c
    c.close()


def _count(conn: sqlite3.Connection, table: str, column: str, value: str) -> int:
    return int(conn.execute(f"SELECT COUNT(*) FROM {table} WHERE {column} = ?", (value,)).fetchone()[0])


def test_merge_reattributes_everything(conn: sqlite3.Connection, tmp_path: Path) -> None:
    result = merge_bootstrap_admin_into_primary(conn, scopes_root=tmp_path)

    assert result["skipped"] is None
    assert result["target"] == "admin"
    assert result["sessions"] == 2

    assert _count(conn, "evoflow_chat_sessions", "created_by", BOOTSTRAP_PRINCIPAL_ID) == 0
    assert _count(conn, "evoflow_chat_sessions", "created_by", "admin") == 2
    assert _count(conn, "evoflow_chat_sessions", "scope_id", f"personal:{BOOTSTRAP_PRINCIPAL_ID}") == 0

    root = conn.execute(
        "SELECT local_workspace_root FROM evoflow_chat_sessions WHERE session_key = 'agent:main:new-1'"
    ).fetchone()[0]
    assert "personal/admin" in root and BOOTSTRAP_PRINCIPAL_ID not in root

    ctx = conn.execute(
        "SELECT context_json FROM evoflow_chat_sessions WHERE session_key = 'agent:main:new-1'"
    ).fetchone()[0]
    assert BOOTSTRAP_PRINCIPAL_ID not in ctx and "personal/admin" in ctx

    # Participant row collided with the target's own row → ours dropped.
    assert _count(conn, "evoflow_session_participants", "principal_id", BOOTSTRAP_PRINCIPAL_ID) == 0
    assert _count(conn, "evoflow_session_participants", "principal_id", "admin") == 2

    assert _count(conn, "evoflow_usage_events", "principal_id", "admin") == 3
    daily = conn.execute(
        "SELECT quantity_sum, event_count FROM evoflow_usage_daily WHERE principal_id = 'admin'"
    ).fetchone()
    assert daily["quantity_sum"] == pytest.approx(150.0)
    assert daily["event_count"] == 3
    assert _count(conn, "evoflow_usage_daily", "principal_id", BOOTSTRAP_PRINCIPAL_ID) == 0

    assert _count(conn, "evoflow_admin_grants", "principal_id", BOOTSTRAP_PRINCIPAL_ID) == 0
    assert _count(conn, "evoflow_apps", "created_by", BOOTSTRAP_PRINCIPAL_ID) == 0
    assert _count(conn, "evoflow_app_settings", "key", f"panel.ui:{BOOTSTRAP_PRINCIPAL_ID}") == 0
    assert _count(conn, "evoflow_app_settings", "key", "panel.ui:admin") == 1
    assert _count(conn, "evoflow_workspaces", "owner_scope_id", f"personal:{BOOTSTRAP_PRINCIPAL_ID}") == 0

    # Display name can never render as "Local Admin" again, and the bootstrap
    # identity is retired so it stops showing up as a second user.
    row = conn.execute(
        "SELECT display_name, status FROM evoflow_principals WHERE principal_id = ?", (BOOTSTRAP_PRINCIPAL_ID,)
    ).fetchone()
    assert row["display_name"] == "admin"
    assert row["status"] == "deactivated"


def test_merge_is_idempotent(conn: sqlite3.Connection) -> None:
    merge_bootstrap_admin_into_primary(conn)
    marker = conn.execute("SELECT value_json FROM evoflow_app_settings WHERE key = ?", (MIGRATION_MARKER_KEY,)).fetchone()
    assert marker is not None

    second = merge_bootstrap_admin_into_primary(conn)
    assert second["skipped"] == "already merged"


def test_merge_skips_without_primary_admin(conn: sqlite3.Connection) -> None:
    conn.execute("DELETE FROM evoflow_webui_users")
    conn.commit()
    result = merge_bootstrap_admin_into_primary(conn)
    assert result["skipped"] == "no primary webui admin"
    assert _count(conn, "evoflow_chat_sessions", "created_by", BOOTSTRAP_PRINCIPAL_ID) == 2


def test_merge_noop_when_bootstrap_owns_nothing(conn: sqlite3.Connection) -> None:
    conn.execute("DELETE FROM evoflow_chat_sessions")
    conn.execute("DELETE FROM evoflow_session_participants")
    conn.execute("DELETE FROM evoflow_usage_events")
    conn.execute("DELETE FROM evoflow_usage_daily")
    conn.execute("DELETE FROM evoflow_apps")
    conn.execute("DELETE FROM evoflow_admin_grants WHERE principal_id = ?", (BOOTSTRAP_PRINCIPAL_ID,))
    conn.commit()

    result = merge_bootstrap_admin_into_primary(conn)
    assert result["skipped"] == "bootstrap principal owns nothing"
    # Still normalizes the display name and records the marker.
    name = conn.execute(
        "SELECT display_name FROM evoflow_principals WHERE principal_id = ?", (BOOTSTRAP_PRINCIPAL_ID,)
    ).fetchone()[0]
    assert name == "admin"


def test_asset_bucket_is_merged(conn: sqlite3.Connection, tmp_path: Path) -> None:
    """Per-user asset bucket (memory/profile/craft) must follow the identity."""
    src = tmp_path / "users" / BOOTSTRAP_PRINCIPAL_ID / "memory"
    src.mkdir(parents=True)
    (src / "MEMORY.md").write_text("# MEMORY", encoding="utf-8")

    from evoflow.persistence.bootstrap_admin_merge import _merge_asset_buckets

    assert _merge_asset_buckets("admin", assets_root=tmp_path) is True
    assert (tmp_path / "users" / "admin" / "memory" / "MEMORY.md").is_file()
    assert not (tmp_path / "users" / BOOTSTRAP_PRINCIPAL_ID).exists()
