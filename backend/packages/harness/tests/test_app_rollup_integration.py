"""L2 integration tests for app rollup: DB schema, save/load round-trip, revision, normalize."""

from __future__ import annotations

import tempfile
from pathlib import Path

import pytest

from evoflow.persistence.db import get_db, reset_db_for_tests


@pytest.fixture
def sqlite_tmp(monkeypatch: pytest.MonkeyPatch):
    with tempfile.TemporaryDirectory() as tmp:
        monkeypatch.setenv("EVOFLOW_HOME", tmp)
        reset_db_for_tests()
        yield Path(tmp)
        reset_db_for_tests()
        import gc

        gc.collect()


def test_v100_migration_adds_columns(sqlite_tmp: Path) -> None:
    """Verify that the evoflow_apps table has final_rollup / final_rollup_agent / final_rollup_instruction columns."""
    del sqlite_tmp
    conn = get_db()
    cursor = conn.execute("PRAGMA table_info(evoflow_apps)")
    columns = {row[1]: row for row in cursor.fetchall()}

    # final_rollup: default 'auto'
    assert "final_rollup" in columns, "Missing column: final_rollup"
    col = columns["final_rollup"]
    # col[4] = default value, col[2] = type
    assert col[4] == "auto" or col[4] == "'auto'", f"Unexpected default for final_rollup: {col[4]}"

    # final_rollup_agent: default ''
    assert "final_rollup_agent" in columns, "Missing column: final_rollup_agent"
    col_agent = columns["final_rollup_agent"]
    # SQLite stores '' as two single-quote characters in PRAGMA output
    assert col_agent[4] is None or col_agent[4] == "" or col_agent[4] == "''", (
        f"Unexpected default for final_rollup_agent: {col_agent[4]!r}"
    )

    # final_rollup_instruction: default ''
    assert "final_rollup_instruction" in columns, "Missing column: final_rollup_instruction"
    col_inst = columns["final_rollup_instruction"]
    assert col_inst[4] is None or col_inst[4] == "" or col_inst[4] == "''", (
        f"Unexpected default for final_rollup_instruction: {col_inst[4]!r}"
    )


def test_save_load_roundtrip_final_rollup_fields(sqlite_tmp: Path) -> None:
    """Save an app with rollup fields, load it back, and verify values."""
    del sqlite_tmp
    from evoflow.persistence import app_repositories

    get_db()
    app_id = "App_rollup_roundtrip"
    app_repositories.save_app(
        app_id,
        {
            "name": "Rollup Test",
            "steps": [{"ref": "1", "goal": "g", "tools": "a", "depends_on": []}],
            "parameters": [],
            "goal_template": "do it",
            "version": 1,
            "status": "draft",
            "final_rollup": "auto",
            "final_rollup_agent": "writer",
            "final_rollup_instruction": "custom",
        },
    )

    loaded = app_repositories.load_app(app_id)
    assert loaded is not None
    assert loaded["final_rollup"] == "auto"
    assert loaded["final_rollup_agent"] == "writer"
    assert loaded["final_rollup_instruction"] == "custom"


def test_revision_snapshot_includes_rollup_fields(sqlite_tmp: Path) -> None:
    """Save an app with rollup fields, then load revision snapshot and verify it includes them."""
    del sqlite_tmp
    from evoflow.persistence import app_repositories

    get_db()
    app_id = "App_rollup_rev"
    app_repositories.save_app(
        app_id,
        {
            "name": "Rev Rollup",
            "steps": [{"ref": "1", "goal": "g", "tools": "a", "depends_on": []}],
            "parameters": [],
            "goal_template": "do it v1",
            "version": 1,
            "status": "draft",
            "final_rollup": "answer_node_only",
            "final_rollup_agent": "researcher",
            "final_rollup_instruction": "check quality",
        },
    )

    rev = app_repositories.load_revision(app_id, 1)
    assert rev is not None
    snapshot = rev["snapshot"]
    assert snapshot["final_rollup"] == "answer_node_only"
    assert snapshot["final_rollup_agent"] == "researcher"
    assert snapshot["final_rollup_instruction"] == "check quality"


def test_restore_revision_preserves_rollup(sqlite_tmp: Path) -> None:
    """Restore an older revision and verify rollup mode reverts accordingly."""
    del sqlite_tmp
    from evoflow.persistence import app_repositories

    get_db()
    app_id = "App_rollup_restore"

    # v1: final_rollup="answer_node_only"
    app_repositories.save_app(
        app_id,
        {
            "name": "Restore Demo",
            "steps": [{"ref": "1", "goal": "g", "tools": "a", "depends_on": []}],
            "parameters": [],
            "goal_template": "do v1",
            "version": 1,
            "status": "draft",
            "final_rollup": "answer_node_only",
        },
    )

    # v2: final_rollup="auto"
    app_repositories.save_app(
        app_id,
        {
            **app_repositories.load_app(app_id),
            "version": 2,
            "status": "published",
            "final_rollup": "auto",
        },
    )

    # Verify v2 loaded
    loaded_v2 = app_repositories.load_app(app_id)
    assert loaded_v2["final_rollup"] == "auto"
    assert loaded_v2["version"] == 2

    # Restore v1
    restored = app_repositories.restore_app_from_revision(app_id, 1, as_draft=True)
    assert restored["version"] == 3
    assert restored["final_rollup"] == "answer_node_only"
    assert restored["status"] == "draft"

    # Verify persisted
    loaded_v3 = app_repositories.load_app(app_id)
    assert loaded_v3["final_rollup"] == "answer_node_only"
    assert loaded_v3["version"] == 3


def test_normalize_app_document_rollup_defaults(sqlite_tmp: Path) -> None:
    """Pass an app dict without final_rollup; normalize_app_document should default to 'auto'."""
    del sqlite_tmp
    from evoflow.collab.app_schema import normalize_app_document

    doc = normalize_app_document(
        {
            "name": "No Rollup",
            "steps": [{"ref": "1", "goal": "g", "tools": "a", "depends_on": []}],
            "parameters": [],
            "goal_template": "do it",
        }
    )
    assert doc["final_rollup"] == "auto"
    assert doc["final_rollup_agent"] == ""
    assert doc["final_rollup_instruction"] == ""


def test_normalize_app_document_invalid_mode_fallback(sqlite_tmp: Path) -> None:
    """Pass an invalid final_rollup value; normalize should fall back to 'auto'."""
    del sqlite_tmp
    from evoflow.collab.app_schema import normalize_app_document

    doc = normalize_app_document(
        {
            "name": "Bad Rollup",
            "steps": [{"ref": "1", "goal": "g", "tools": "a", "depends_on": []}],
            "parameters": [],
            "goal_template": "do it",
            "final_rollup": "invalid_value",
        }
    )
    assert doc["final_rollup"] == "auto"
