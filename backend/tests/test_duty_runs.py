"""Duty-run trail index: trigger → evoflow_duty_runs → board rounds."""

from __future__ import annotations

import uuid

import pytest


@pytest.fixture()
def duty_db(tmp_path, monkeypatch):
    """Isolated sqlite for duty_runs helpers."""
    db_path = tmp_path / f"duty_{uuid.uuid4().hex[:8]}.db"
    monkeypatch.setenv("EVOFLOW_DB_PATH", str(db_path))
    from evoflow.persistence.db import get_db, reset_db_for_tests
    from evoflow.persistence.schema import ensure_app_schema

    reset_db_for_tests()
    conn = get_db()
    ensure_app_schema(conn)
    yield conn
    reset_db_for_tests()
    monkeypatch.delenv("EVOFLOW_DB_PATH", raising=False)


def test_start_and_list_duty_run(duty_db):
    from evoflow.proactive.duty_runs import (
        list_duty_rounds_for_board,
        list_duty_runs,
        start_duty_run,
        update_duty_run,
    )

    row = start_duty_run(
        agent_code="sales_rep",
        trigger_source="scheduler.tick",
        trigger_reason="定时心跳到期",
        scheduled=True,
        status="started",
    )
    assert row.get("run_id")
    assert row["agent_code"] == "sales_rep"
    assert row["status"] == "started"
    assert str(row["round_id"]).startswith("round:")

    update_duty_run(
        row["run_id"],
        status="completed",
        session_key=f"proactive:sales_rep:duty:{row['round_id'].replace(':', '-')}",
        msg_count=3,
        tool_count=1,
    )

    listed = list_duty_runs("sales_rep", limit=10)
    assert len(listed) == 1
    assert listed[0]["status"] == "completed"
    assert listed[0]["msg_count"] == 3

    rounds = list_duty_rounds_for_board("sales_rep", limit=10)
    assert len(rounds) == 1
    assert rounds[0]["action_plan"]["kind"] == "round_log"
    assert rounds[0]["action_plan"]["source"] == "duty_run"
    assert rounds[0]["title"] == "定时上班"
    assert "轨迹 3 条" in (rounds[0].get("outcome") or "")


def test_skipped_idle_board_appears_in_rounds(duty_db):
    from evoflow.proactive.duty_runs import list_duty_rounds_for_board, start_duty_run

    start_duty_run(
        agent_code="xiaomi",
        trigger_source="scheduler.tick",
        trigger_reason="空板",
        scheduled=True,
        status="skipped",
        skip_reason="xiaomi_idle_board",
    )
    rounds = list_duty_rounds_for_board("xiaomi", limit=5)
    assert len(rounds) == 1
    assert "空板" in (rounds[0].get("outcome") or "")
