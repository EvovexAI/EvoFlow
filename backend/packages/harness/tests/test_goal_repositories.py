"""Smoke tests for hosted-agent SQLite repository (v52 normalized columns)."""

from __future__ import annotations

import tempfile
from pathlib import Path

import pytest

from evoflow.persistence import goal_repositories as goal_repo
from evoflow.persistence.db import get_db, reset_db_for_tests


@pytest.fixture
def sqlite_tmp(monkeypatch: pytest.MonkeyPatch):
    with tempfile.TemporaryDirectory() as tmp:
        monkeypatch.setenv("EVOFLOW_HOME", tmp)
        reset_db_for_tests()
        get_db()
        yield Path(tmp)
        reset_db_for_tests()
        import gc

        gc.collect()


def test_v59_table_has_normalized_columns(sqlite_tmp: Path) -> None:
    conn = get_db()
    version = conn.execute("PRAGMA user_version").fetchone()[0]
    assert int(version) >= 59
    cols = {
        row[1]
        for row in conn.execute("PRAGMA table_info(evoflow_goal_sessions)").fetchall()
    }
    for name in (
        "goal_session_id",
        "prompt",
        "goal_status",
        "goal_revision",
        "continuation_suppressed",
        "last_run_at",
        "last_error",
    ):
        assert name in cols


def test_upsert_load_session_with_goal_fields(sqlite_tmp: Path) -> None:
    sk = "user-a:session-1"
    sys_prompt = "你是一个托管调度 Agent。\n用户目标: 持续优化此仓库代码质量"
    compaction = "## 目标\n持续优化\n## 进展\n已完成 3 轮"

    goal_repo.upsert_goal_session(
        sk,
        user_id="alice",
        goal_session_id="hosted-abc123",
        prompt="持续优化此仓库代码质量",
        max_steps=8,
        step_delay_ms=1500,
        retry_limit=2,
        auto_stop_minutes=0,
        persona_style="professional",
        initiative=60,
        emotional_intelligence=True,
        feishu_push_on_complete=False,
        goal_status="active",
        goal_revision=2,
        continuation_suppressed=True,
        status="running",
        step_count=3,
        enabled=True,
        last_run_at=1718000000000,
        last_run_id="run-xyz",
        last_error="",
        pending_feedback=False,
        error_count=0,
        system_prompt=sys_prompt,
        compaction_summary=compaction,
        locked_chat_model="claude-3.5-sonnet",
        start_time=1718000000000,
    )

    row = goal_repo.load_goal_session(sk)
    assert row is not None
    assert row["session_key"] == sk
    assert row["user_id"] == "alice"
    assert row["goal_session_id"] == "hosted-abc123"
    assert row["prompt"] == "持续优化此仓库代码质量"
    assert row["max_steps"] == 8
    assert row["goal_status"] == "active"
    assert row["goal_revision"] == 2
    assert row["continuation_suppressed"] is True
    assert row["enabled"] is True
    assert row["status"] == "running"
    assert row["step_count"] == 3
    assert row["last_run_id"] == "run-xyz"
    assert row["system_prompt"] == sys_prompt
    assert row["compaction_summary"] == compaction

    settings = goal_repo.row_to_frontend_settings(row)
    assert settings["config"]["prompt"] == "持续优化此仓库代码质量"
    assert settings["goalStatus"] == "active"
    assert settings["goalRevision"] == 2
    assert settings["config"]["enabled"] is True
    assert settings["goalSessionId"] == "hosted-abc123"


def test_row_to_frontend_settings_clears_inactive_goal(sqlite_tmp: Path) -> None:
    sk = "sk-cleared"
    goal_repo.upsert_goal_session(
        sk,
        prompt="旧目标",
        goal_session_id="hosted-old",
        goal_status="cleared",
        status="running",
        enabled=True,
        step_count=5,
    )
    row = goal_repo.load_goal_session(sk)
    assert row is not None
    settings = goal_repo.row_to_frontend_settings(row)
    assert settings["config"]["enabled"] is False
    assert settings["goalSessionId"] == ""
    assert settings["runtime"]["status"] == "idle"


def test_patch_state_updates_runtime_only(sqlite_tmp: Path) -> None:
    sk = "sk-patch"
    goal_repo.upsert_goal_session(
        sk,
        prompt="g",
        enabled=True,
        status="running",
        step_count=1,
        system_prompt="initial prompt",
    )

    ok = goal_repo.patch_goal_session_state(
        sk,
        state={"status": "idle", "stepCount": 8, "lastError": ""},
        enabled=False,
        goal_status="cleared",
    )
    assert ok is True

    row = goal_repo.load_goal_session(sk)
    assert row is not None
    assert row["status"] == "idle"
    assert row["step_count"] == 8
    assert row["enabled"] is False
    assert row["goal_status"] == "cleared"
    assert row["prompt"] == "g"
    assert row["system_prompt"] == "initial prompt"


def test_list_goal_sessions_goal_active_filter(sqlite_tmp: Path) -> None:
    goal_repo.upsert_goal_session(
        "sk-active",
        prompt="g1",
        goal_status="active",
        enabled=True,
        status="running",
        user_id="alice",
    )
    goal_repo.upsert_goal_session(
        "sk-cleared",
        prompt="g2",
        goal_status="cleared",
        enabled=False,
        status="idle",
        user_id="alice",
    )

    active_rows = goal_repo.list_goal_sessions(goal_active_only=True)
    assert {r["session_key"] for r in active_rows} == {"sk-active"}


def test_upsert_updates_goal_summary_on_conflict(sqlite_tmp: Path) -> None:
    sk = "sk-summary"
    goal_repo.upsert_goal_session(
        sk,
        prompt="完成模块 A",
        goal_status="active",
        enabled=True,
        status="running",
        step_count=2,
    )
    goal_repo.upsert_goal_session(
        sk,
        prompt="完成模块 A",
        goal_status="completed",
        enabled=False,
        status="idle",
        step_count=1,
        goal_summary="模块 A 已全部完成",
        completion_outcome="目标达成",
    )

    row = goal_repo.load_goal_session(sk)
    assert row is not None
    assert row["goal_status"] == "completed"
    assert row["goal_summary"] == "模块 A 已全部完成"
    assert row["completion_outcome"] == "目标达成"
    assert row["step_count"] == 2


def test_delete_goal_session(sqlite_tmp: Path) -> None:
    sk = "sk-del"
    goal_repo.upsert_goal_session(sk, prompt="g", enabled=True)
    assert goal_repo.load_goal_session(sk) is not None

    removed = goal_repo.delete_goal_session(sk)
    assert removed == 1
    assert goal_repo.load_goal_session(sk) is None
