"""Asset Hub Phase1/Phase2 processing run log."""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest

from evoflow.config.paths import reset_paths_cache
from evoflow.persistence.db import get_db, reset_db_for_tests


@pytest.fixture()
def db_home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("EVOFLOW_HOME", str(tmp_path))
    reset_paths_cache()
    reset_db_for_tests()
    get_db()
    yield tmp_path
    reset_db_for_tests()
    reset_paths_cache()


def test_record_phase_result_ok_skipped_error(db_home: Path):
    from evoflow.persistence.asset_memory_run_repositories import (
        list_asset_memory_runs,
        record_phase_result,
    )

    rid_ok = record_phase_result(
        phase="phase1",
        trigger="queue",
        result={"ok": True, "paths": ["memory/_inbox/raw_abc.md"]},
        entity_type="employee",
        entity_id="douyin-analyst",
        thread_id="th-1",
        agent_name="douyin-analyst",
        principal_id="yin-tai",
    )
    assert rid_ok

    rid_skip = record_phase_result(
        phase="phase2",
        trigger="queue",
        result={"ok": False, "skipped": "inbox_empty"},
        entity_type="employee",
        entity_id="douyin-analyst",
        thread_id="th-1",
        agent_name="douyin-analyst",
        principal_id="yin-tai",
    )
    assert rid_skip

    rid_err = record_phase_result(
        phase="phase1",
        trigger="queue",
        result=None,
        entity_type="employee",
        entity_id="douyin-analyst",
        thread_id="th-1",
        error="boom",
    )
    assert rid_err

    rows = list_asset_memory_runs(entity_type="employee", entity_id="douyin-analyst", limit=10)
    assert len(rows) == 3
    by_status = {r["status"]: r for r in rows}
    assert by_status["ok"]["paths"] == ["memory/_inbox/raw_abc.md"]
    assert by_status["ok"]["entityType"] == "employee"
    assert by_status["ok"]["entityId"] == "douyin-analyst"
    assert by_status["skipped"]["skipReason"] == "inbox_empty"
    assert by_status["error"]["errorMessage"] == "boom"

    # User filter must not see employee rows.
    assert list_asset_memory_runs(entity_type="user", entity_id="yin-tai") == []


def test_queue_records_employee_entity(db_home: Path, monkeypatch: pytest.MonkeyPatch):
    """Memory queue Phase1/2 logging uses employee entity, not users/<pid>."""
    from evoflow.agents.memory.queue import MemoryUpdateQueue
    from evoflow.assets.paths import EntityRef
    from evoflow.persistence.asset_memory_run_repositories import list_asset_memory_runs

    monkeypatch.setattr(
        "evoflow.assets.pipeline_config.should_run_legacy_memory_updater",
        lambda: False,
    )
    monkeypatch.setattr(
        "evoflow.assets.guidance.resolve_session_entity",
        lambda **kw: EntityRef("employee", "douyin-analyst").normalized(),
    )
    monkeypatch.setattr(
        "evoflow.assets.phase1.run_phase1_extract",
        lambda **kw: {"ok": True, "paths": ["memory/episodic/x.md"]},
    )
    monkeypatch.setattr(
        "evoflow.assets.phase2.run_phase2_consolidate",
        lambda **kw: {"ok": False, "skipped": "inbox_empty"},
    )

    q = MemoryUpdateQueue()
    q.add(
        thread_id="thread-emp-1",
        messages=[SimpleNamespace(type="human", content="hi"), SimpleNamespace(type="ai", content="ok")],
        agent_name="douyin-analyst",
        principal_id="yin-tai",
    )
    q.flush()

    rows = list_asset_memory_runs(thread_id="thread-emp-1", limit=10)
    assert len(rows) >= 2
    phases = {r["phase"] for r in rows}
    assert "phase1" in phases and "phase2" in phases
    for r in rows:
        assert r["entityType"] == "employee"
        assert r["entityId"] == "douyin-analyst"
        assert r["trigger"] == "queue"
        assert r["principalId"] == "yin-tai"

    user_rows = list_asset_memory_runs(entity_type="user", entity_id="yin-tai")
    assert not user_rows


def test_manual_and_startup_triggers(db_home: Path):
    from evoflow.assets.memory_runs import record_asset_phase_run
    from evoflow.assets.paths import EntityRef
    from evoflow.persistence.asset_memory_run_repositories import list_asset_memory_runs

    ent = EntityRef("employee", "ops-bot").normalized()
    assert record_asset_phase_run(
        phase="phase2",
        trigger="manual",
        result={"ok": True, "paths": ["memory/standing.md"]},
        entity=ent,
        principal_id="admin-yin",
    )
    assert record_asset_phase_run(
        phase="phase2",
        trigger="startup_scan",
        result={"ok": False, "skipped": "inbox_empty"},
        entity=ent,
        principal_id="admin-yin",
        detail={"pending": 0},
    )

    rows = list_asset_memory_runs(entity_type="employee", entity_id="ops-bot")
    triggers = {r["trigger"] for r in rows}
    assert triggers == {"manual", "startup_scan"}
    statuses = {r["trigger"]: r["status"] for r in rows}
    assert statuses["manual"] == "ok"
    assert statuses["startup_scan"] == "skipped"
    for r in rows:
        assert r["principalId"] == "admin-yin"
        assert r["operatorId"] == "admin-yin"
