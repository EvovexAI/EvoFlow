"""SQLite persistence smoke tests."""

from __future__ import annotations

from evoflow.persistence.schema import ensure_app_schema

import tempfile
from pathlib import Path

import pytest

from evoflow.collab.storage import ProjectStorage, TaskDetailStorage, create_empty_project
from evoflow.persistence.db import get_db, reset_db_for_tests, resolve_evolflow_db_path


@pytest.fixture
def sqlite_tmp(monkeypatch: pytest.MonkeyPatch):
    with tempfile.TemporaryDirectory() as tmp:
        db = Path(tmp) / "test_evolflow.db"
        monkeypatch.setenv("EVOFLOW_HOME", tmp)
        reset_db_for_tests()
        yield db
        reset_db_for_tests()
        import gc

        gc.collect()


def test_resolve_db_under_home(sqlite_tmp: Path) -> None:
    assert resolve_evolflow_db_path().name == "evoflow.db"
    get_db()
    assert (sqlite_tmp.parent / "data" / "app" / "evoflow.db").exists()


def test_project_storage_roundtrip(sqlite_tmp: Path) -> None:
    del sqlite_tmp
    storage = ProjectStorage()
    bundle = create_empty_project(name="t1", main_task_id="main-1")
    bundle["id"] = "main-1"
    assert storage.save_project(bundle)
    loaded = storage.load_project("main-1")
    assert loaded is not None
    assert loaded["id"] == "main-1"
    listed = storage.list_projects()
    assert any(p["id"] == "main-1" for p in listed)


def test_task_detail_roundtrip(sqlite_tmp: Path) -> None:
    del sqlite_tmp
    td = TaskDetailStorage()
    doc = td.load_task_memory("main-2", "agent-a", "sub-1")
    doc["output_summary"] = "done"
    assert td.save_task_memory(doc)
    again = td.load_task_memory("main-2", "agent-a", "sub-1")
    assert again.get("output_summary") == "done"


def test_user_profile_dimensions_and_thread_plan(sqlite_tmp: Path) -> None:
    del sqlite_tmp
    from evoflow.assets.user_profile_dims import (
        ensure_user_profile_files,
        read_user_profile_dimensions,
        update_profile_dimension,
    )
    from evoflow.persistence import plan_repositories as plan_repo

    ensure_user_profile_files()
    update_profile_dimension(dimension="preferences", content="喜欢简洁回复", mode="append")
    dims = read_user_profile_dimensions(max_chars_per_dim=8000)
    assert "简洁" in (dims.get("preferences.md") or "")

    plan_repo.save_thread_plan("thread-1", "# Plan\n\nStep 1", stamped_label="plan-20260101")
    row = plan_repo.get_thread_plan("thread-1")
    assert row is not None
    assert "Step 1" in row["plan_md"]


def test_mission_nodes_parent_tree(sqlite_tmp: Path) -> None:
    del sqlite_tmp
    from evoflow.agents.mission_state.models import MissionState, MissionSubproblem
    from evoflow.agents.mission_state.storage import save_mission_state
    from evoflow.persistence.mission_node_repositories import load_latest_mission_tree

    state = MissionState(
        thread_id="t-mission",
        version=1,
        primary_objective="Build the report",
        active_subproblems=[
            MissionSubproblem(id="s1", title="Collect data", status="in_progress"),
            MissionSubproblem(id="s2", title="Write summary", status="pending"),
        ],
        success_criteria=["Report delivered"],
    )
    assert save_mission_state("t-mission", state)
    payload = load_latest_mission_tree("t-mission")
    assert payload is not None
    nodes = payload["nodes"]
    assert len(nodes) >= 4
    root = next(n for n in nodes if n["kind"] == "objective")
    assert root["parent_id"] is None
    subs = [n for n in nodes if n["kind"] == "subproblem"]
    assert len(subs) == 2
    assert all(n["parent_id"] == root["id"] for n in subs)


def test_schema_v6_normalized_columns(sqlite_tmp: Path) -> None:
    del sqlite_tmp
    cols = {r[1] for r in get_db().execute("PRAGMA table_info(evoflow_models)").fetchall()}
    assert "document_json" not in cols
    assert "vendor" in cols and "use" in cols
    mission_cols = {r[1] for r in get_db().execute("PRAGMA table_info(evoflow_mission_state)").fetchall()}
    assert "document_json" not in mission_cols
    assert "primary_objective" in mission_cols


def test_schema_v14_task_tables_flat(sqlite_tmp: Path) -> None:
    del sqlite_tmp
    assert (
        get_db()
        .execute("SELECT name FROM sqlite_master WHERE type='table' AND name='evoflow_task_bundles'")
        .fetchone()
        is None
    )
    collab_task_cols = {r[1] for r in get_db().execute("PRAGMA table_info(evoflow_collab_tasks)").fetchall()}
    assert "task_id" in collab_task_cols
    assert "plan_goal" in collab_task_cols
    detail_cols = {r[1] for r in get_db().execute("PRAGMA table_info(evoflow_task_details)").fetchall()}
    assert "document_json" not in detail_cols
    assert "output_summary" in detail_cols
    collab_cols = {r[1] for r in get_db().execute("PRAGMA table_info(evoflow_thread_collab)").fetchall()}
    assert "state_json" not in collab_cols
    assert "collab_phase" in collab_cols
    assert get_db().execute("SELECT name FROM sqlite_master WHERE type='table' AND name='evoflow_collab_subtasks'").fetchone()
    assert get_db().execute("SELECT name FROM sqlite_master WHERE type='table' AND name='evoflow_mission_runtime'").fetchone()


def test_bundle_with_subtasks_roundtrip(sqlite_tmp: Path) -> None:
    del sqlite_tmp
    from evoflow.collab.storage import create_empty_task
    from evoflow.persistence import repositories as repo

    bundle = create_empty_project(name="p", main_task_id="main-sub")
    bundle["id"] = "main-sub"
    task = create_empty_task(name="root", project_id="main-sub")
    task["id"] = "main-sub"
    task["subtasks"] = [
        {
            "id": "st-1",
            "name": "Sub",
            "description": "d",
            "status": "pending",
            "dependencies": [],
            "assigned_to": "general-purpose",
            "worker_profile": {
                "base_subagent": "general-purpose",
                "depends_on": [],
                "expected_outputs": ["outputs/a.md"],
                "max_retries": 2,
            },
        }
    ]
    bundle["tasks"] = [task]
    repo.save_task_bundle("main-sub", bundle)
    loaded = repo.load_task_bundle("main-sub")
    assert loaded is not None
    assert len(loaded["tasks"]) == 1
    subs = loaded["tasks"][0].get("subtasks") or []
    assert len(subs) == 1
    assert subs[0]["id"] == "st-1"
    wp = subs[0].get("worker_profile") or {}
    assert wp.get("expected_outputs") == ["outputs/a.md"]





def test_schema_v16_mission_subproblems_have_timestamps(sqlite_tmp: Path) -> None:
    del sqlite_tmp
    cols = {r[1] for r in get_db().execute("PRAGMA table_info(evoflow_mission_subproblems)").fetchall()}
    assert "created_at" in cols
    assert "updated_at" in cols


def test_schema_v15_no_document_json_or_ms(sqlite_tmp: Path) -> None:
    del sqlite_tmp
    for table in ("evoflow_memory", "evoflow_channel_bindings", "evoflow_agent_runtime"):
        cols = {r[1] for r in get_db().execute(f"PRAGMA table_info({table})").fetchall()}
        assert "document_json" not in cols
    sess_cols = {r[1] for r in get_db().execute("PRAGMA table_info(evoflow_chat_sessions)").fetchall()}
    assert "created_at_ms" not in sess_cols
    assert "created_at" in sess_cols
    assert "updated_at" in sess_cols
    assert "run_status" in sess_cols
    assert "input_tokens" in sess_cols
    assert "is_pinned" in sess_cols
    assert "pin_order" in sess_cols
    retry_cols = {r[1] for r in get_db().execute("PRAGMA table_info(evoflow_mission_retries)").fetchall()}
    assert "next_run_ts_ms" not in retry_cols
    assert "next_run_at" in retry_cols


def test_memory_roundtrip_v15(sqlite_tmp: Path) -> None:
    del sqlite_tmp
    from evoflow.persistence import repositories as repo

    doc = {
        "version": "1.0",
        "lastUpdated": "2026-01-01T00:00:00Z",
        "user": {"workContext": {"summary": "hello", "updatedAt": "2026-01-01T00:00:00Z"}},
        "history": {},
        "facts": [{"id": "f1", "content": "fact-schema-v1-roundtrip", "category": "general"}],
    }
    repo.save_memory("agent-a", doc)
    loaded = repo.load_memory("agent-a")
    assert loaded is not None
    assert loaded["user"]["workContext"]["summary"] == "hello"
    facts = loaded.get("facts") or []
    assert any(
        (f.get("id") == "f1") or (f.get("content") == "fact-schema-v1-roundtrip")
        for f in facts
        if isinstance(f, dict)
    )


def test_timestamps_use_beijing_offset(sqlite_tmp: Path) -> None:
    del sqlite_tmp
    from evoflow.persistence import repositories as repo
    from evoflow.timeutil import beijing_now_iso, parse_iso_to_ms

    now = beijing_now_iso()
    assert "+08:00" in now or now.endswith("+08:00")
    bundle = create_empty_project(name="tz", main_task_id="tz-1")
    bundle["id"] = "tz-1"
    repo.save_task_bundle("tz-1", bundle)
    loaded = repo.load_task_bundle("tz-1")
    assert loaded is not None
    assert "+08:00" in str(loaded.get("updated_at") or "")
    # legacy UTC Z still parses to the same instant
    assert parse_iso_to_ms("2026-01-01T00:00:00Z") == parse_iso_to_ms("2026-01-01T08:00:00+08:00")


def test_mission_runtime_sqlite(sqlite_tmp: Path) -> None:
    del sqlite_tmp
    from evoflow.agents.mission_state.state_manager import get_thread_state, reset_thread_state

    reset_thread_state("t-rt")
    s = get_thread_state("t-rt")
    assert s.mode == "bootstrap"
    assert s.drift_count == 0



def test_find_root_task_by_thread_reads_bound_plan_from_db(sqlite_tmp: Path) -> None:
    del sqlite_tmp
    from evoflow.collab.storage import new_project_bundle_root_task
    from evoflow.persistence import task_repositories as tr

    project, _task = new_project_bundle_root_task(
        "规划任务",
        "协作规划占位任务；调用 plan 工具落库后自动从 Steps 同步子任务。",
        thread_id="thread-plan-fresh",
    )
    task_id = str(project["id"])
    tr.save_task_bundle(task_id, project)

    loaded = tr.load_task_bundle(task_id)
    assert loaded is not None
    root = loaded["tasks"][0]
    root["plan_goal"] = "任务调度测试"
    root["plan_steps"] = [{"ref": "1", "name": "Task 1"}]
    root["plan_bound_at"] = "2026-05-29T00:55:43.273062+08:00"
    root["status"] = "planned"
    root["name"] = "任务调度测试"
    tr.save_task_bundle(task_id, loaded)

    row = tr.find_root_task_by_thread_id("thread-plan-fresh")
    assert row is not None
    assert row.get("plan_goal") == "任务调度测试"
    assert isinstance(row.get("plan_steps"), list)


def test_find_root_task_by_session_key_survives_thread_rotation(sqlite_tmp: Path) -> None:
    del sqlite_tmp
    from evoflow.collab.storage import new_project_bundle_root_task
    from evoflow.persistence import session_repositories as sess_repo
    from evoflow.persistence import task_repositories as tr

    sk = "agent:main:task-session-scope"
    old_thread = "thread-plan-old"
    project, _task = new_project_bundle_root_task(
        "Session scoped task",
        "desc",
        thread_id=old_thread,
    )
    task_id = str(project["id"])
    tr.save_task_bundle(task_id, project)
    tr.save_thread_collab(old_thread, {"collab_phase": "executing", "bound_task_id": task_id})
    sess_repo.upsert_session_row(sk, thread_id=old_thread, collab_task_id=task_id, updated_at_ms=1000)

    row = tr.find_root_task_by_session_key(sk)
    assert row is not None
    assert str(row.get("id") or "") == task_id

    new_thread = "thread-plan-new"
    sess_repo.upsert_session_row(sk, thread_id=new_thread, collab_task_id=task_id, updated_at_ms=2000)
    row2 = tr.find_root_task_by_session_key(sk)
    assert row2 is not None
    assert str(row2.get("id") or "") == task_id
    assert tr.find_root_task_by_thread_id(new_thread) is None


def test_concurrent_sqlite_writes_do_not_raise_locked(sqlite_tmp: Path) -> None:
    """Regression: thread-pool writers must not hit database is locked."""
    del sqlite_tmp
    import concurrent.futures

    from evoflow.persistence import session_repositories as sess_repo
    from evoflow.persistence.config_repositories import set_app_setting
    from evoflow.persistence.session_run_state import mark_session_run_ended, mark_session_run_started

    def _worker(i: int) -> int:
        sk = f"agent:main:concurrent-{i}"
        sess_repo.upsert_session_row(sk, thread_id=f"thread-{i}")
        mark_session_run_started(session_key=sk, run_id=f"run-{i}")
        set_app_setting(f"panel.concurrent.{i}", i)
        mark_session_run_ended(session_key=sk)
        return i

    with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
        out = list(pool.map(_worker, range(48)))
    assert out == list(range(48))
    assert sess_repo.get_session_row_for_ui("agent:main:concurrent-47") is not None


def test_nested_run_db_transaction_uses_savepoint(sqlite_tmp: Path) -> None:
    """Nested ``run_db_transaction`` must not issue a second BEGIN IMMEDIATE."""
    del sqlite_tmp
    from evoflow.persistence import session_repositories as sess_repo
    from evoflow.persistence.db import get_db, run_db_transaction

    sk = "agent:main:nested-txn"

    def _outer(db: object) -> None:
        sess_repo._upsert_session_row_impl(sk, thread_id="thread-nested", conn=db)  # noqa: SLF001
        run_db_transaction(
            lambda inner: sess_repo._upsert_session_row_impl(  # noqa: SLF001
                sk,
                thread_id="thread-nested-2",
                context={"session_mode": "auto"},
                conn=inner,
            )
        )

    run_db_transaction(_outer)
    row = sess_repo.get_session_row_for_ui(sk)
    assert row is not None
    assert row.get("sessionMode") == "auto" or row.get("session_mode") == "auto"
    assert not get_db().in_transaction


def test_upsert_agent_rolls_back_on_failure(sqlite_tmp: Path) -> None:
    """Multi-statement agent upsert must not leave partial list_items after rollback."""
    del sqlite_tmp
    import sqlite3

    from evoflow.persistence import config_repositories as cfg_repo
    from evoflow.persistence.db import run_db_transaction
    from evoflow.timeutil import utc_now_iso_z

    code = "txn-rollback-agent"
    cfg_repo.upsert_agent(
        code,
        {
            "agent_code": code,
            "agent_name": "Stable",
            "agent_type": "custom",
            "allowed_tools": ["tool-stable"],
        },
    )
    stable = cfg_repo.get_agent_config(code)
    assert stable is not None
    assert stable.get("agent_name") == "Stable"

    def _write(db: object) -> None:
        cfg_repo._save_agent_row(  # noqa: SLF001
            db,
            code,
            {
                "agent_code": code,
                "agent_name": "Broken",
                "agent_type": "custom",
                "allowed_tools": ["tool-a", "tool-b"],
            },
            soul_md="",
            now=utc_now_iso_z(),
        )
        raise sqlite3.OperationalError("simulated mid-batch failure")

    with pytest.raises(sqlite3.OperationalError, match="simulated"):
        run_db_transaction(_write)

    after = cfg_repo.get_agent_config(code)
    assert after is not None
    assert after.get("agent_name") == "Stable"
    assert after.get("allowed_tools") == ["tool-stable"]


def test_get_agent_config_tolerates_null_sort_order(sqlite_tmp: Path) -> None:
    """Legacy rows with NULL sort_order must not break agent load/create."""
    del sqlite_tmp
    from evoflow.persistence import config_repositories as cfg_repo
    from evoflow.persistence.db import get_db
    from evoflow.timeutil import utc_now_iso_z

    code = "null-sort-agent"
    cfg_repo.upsert_agent(
        code,
        {
            "agent_code": code,
            "agent_name": "Null Sort",
            "agent_type": "custom",
            "tools": ["read"],
        },
    )
    # Simulate pre-constraint / corrupt DB where sort_order may be NULL.
    db = get_db()
    db.executescript(
        """
        CREATE TABLE evoflow_agent_list_items__legacy (
            agent_code TEXT NOT NULL,
            list_kind TEXT NOT NULL,
            item_value TEXT NOT NULL,
            sort_order INTEGER,
            updated_at TEXT NOT NULL
        );
        INSERT INTO evoflow_agent_list_items__legacy
            SELECT agent_code, list_kind, item_value, sort_order, updated_at
            FROM evoflow_agent_list_items;
        DROP TABLE evoflow_agent_list_items;
        ALTER TABLE evoflow_agent_list_items__legacy RENAME TO evoflow_agent_list_items;
        """
    )
    now = utc_now_iso_z()
    db.execute(
        """
        INSERT INTO evoflow_agent_list_items (
            agent_code, list_kind, item_value, sort_order, updated_at
        ) VALUES (?,?,?,?,?)
        """,
        (code, "tools", "write", None, now),
    )
    db.commit()

    doc = cfg_repo.get_agent_config(code)
    assert doc is not None
    tools = doc.get("tools") or []
    assert "read" in tools
    assert "write" in tools

