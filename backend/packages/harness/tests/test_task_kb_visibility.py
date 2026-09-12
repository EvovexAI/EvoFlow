"""Task / KB visibility isolation (v139)."""

from __future__ import annotations

import gc
import tempfile
from pathlib import Path

import pytest

from evoflow.persistence.db import get_db, reset_db_for_tests
from evoflow.persistence.schema import ensure_app_schema

_EVOFLOW_ROOT = Path(__file__).resolve().parents[4]


@pytest.fixture
def sqlite_tmp(monkeypatch: pytest.MonkeyPatch):
    with tempfile.TemporaryDirectory() as tmp:
        monkeypatch.setenv("EVOFLOW_HOME", tmp)
        monkeypatch.setenv("EVOFLOW_CONFIG_PATH", str(_EVOFLOW_ROOT / "config.yaml"))
        reset_db_for_tests()
        yield tmp
        reset_db_for_tests()
        gc.collect()


def test_task_owner_scope_columns_and_visibility(sqlite_tmp: str) -> None:
    from evoflow.authz import principals as principals_mod
    from evoflow.authz.scope import personal_scope
    from evoflow.persistence import task_repositories as task_repo
    from evoflow.persistence.timestamps import now_iso_z

    ensure_app_schema(get_db())
    alice = principals_mod.create_principal(display_name="Alice", principal_id="user:alice")
    bob = principals_mod.create_principal(display_name="Bob", principal_id="user:bob")
    assert alice and bob

    now = now_iso_z()
    mid = "task_alice_root"
    get_db().execute(
        """
        INSERT INTO evoflow_collab_tasks (
            main_task_id, task_id, name, description, status, parent_id, assigned_to,
            error_text, created_at, started_at, completed_at, progress, execution_authorized,
            thread_id, authorized_at, authorized_by, result_json,
            plan_goal, plan_flowchart_mermaid, plan_validation_json, plan_open_questions,
            plan_steps_json, plan_bound_at, extra_json, sort_order, updated_at,
            org_id, owner_scope_id, created_by
        ) VALUES (?, ?, 'Alice Task', '', 'pending', NULL, NULL, NULL, ?, NULL, NULL, 0, 0,
                  NULL, NULL, NULL, NULL, '', '', '[]', '', '[]', '', '{}', 0, ?,
                  'local', ?, ?)
        """,
        (mid, mid, now, now, personal_scope("user:alice"), "user:alice"),
    )
    get_db().commit()

    assert task_repo.task_visible_to_principal(
        mid,
        personal_scope=personal_scope("user:alice"),
        org_scope="org:local",
        principal=alice,
    )
    assert not task_repo.task_visible_to_principal(
        mid,
        personal_scope=personal_scope("user:bob"),
        org_scope="org:local",
        principal=bob,
    )
    rows = task_repo.list_root_task_summaries()
    alice_rows = [r for r in rows if r.get("id") == mid or r.get("task_id") == mid]
    assert alice_rows
    assert alice_rows[0].get("owner_scope_id") == personal_scope("user:alice")


def test_unstamped_task_hidden_from_non_admin(sqlite_tmp: str) -> None:
    from evoflow.authz import principals as principals_mod
    from evoflow.authz.scope import personal_scope
    from evoflow.persistence import task_repositories as task_repo
    from evoflow.persistence.timestamps import now_iso_z

    ensure_app_schema(get_db())
    bob = principals_mod.create_principal(display_name="Bob", principal_id="user:bob")
    now = now_iso_z()
    mid = "task_legacy"
    # Insert without ownership cols filled (simulate pre-backfill edge)
    cols = {str(r[1]) for r in get_db().execute("PRAGMA table_info(evoflow_collab_tasks)").fetchall()}
    assert "owner_scope_id" in cols
    get_db().execute(
        """
        INSERT INTO evoflow_collab_tasks (
            main_task_id, task_id, name, description, status, parent_id, assigned_to,
            error_text, created_at, started_at, completed_at, progress, execution_authorized,
            thread_id, authorized_at, authorized_by, result_json,
            plan_goal, plan_flowchart_mermaid, plan_validation_json, plan_open_questions,
            plan_steps_json, plan_bound_at, extra_json, sort_order, updated_at
        ) VALUES (?, ?, 'Legacy', '', 'pending', NULL, NULL, NULL, ?, NULL, NULL, 0, 0,
                  NULL, NULL, NULL, NULL, '', '', '[]', '', '[]', '', '{}', 0, ?)
        """,
        (mid, mid, now, now),
    )
    get_db().commit()
    # Clear any admin backfill from migration on this row
    get_db().execute(
        "UPDATE evoflow_collab_tasks SET owner_scope_id=NULL, created_by=NULL WHERE task_id=?",
        (mid,),
    )
    get_db().commit()

    assert not task_repo.task_visible_to_principal(
        mid,
        personal_scope=personal_scope("user:bob"),
        org_scope="org:local",
        principal=bob,
    )
    assert task_repo.task_visible_to_principal(
        mid,
        is_admin=True,
        personal_scope=personal_scope("user:bob"),
        org_scope="org:local",
        principal=bob,
    )
