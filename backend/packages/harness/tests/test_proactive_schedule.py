"""Cron-based proactive role scheduling (unified with automation tasks)."""

from __future__ import annotations

from evoflow.persistence.schema import ensure_app_schema

import sqlite3
from datetime import datetime

from evoflow.proactive.models import ProactiveRole, ProactiveRoleConfig
from evoflow.proactive.schedule import (
    compute_next_duty_iso,
    ensure_role_schedule_fields,
    legacy_rrule_to_cron,
    migrate_stored_schedule,
    resolve_role_cron,
)
from evoflow.timeutil import BEIJING_TZ


def _role(*, schedule: str = "", rrule: str = "FREQ=HOURLY;INTERVAL=2") -> ProactiveRole:
    return ProactiveRole(
        agent_code="t",
        role_name="T",
        config=ProactiveRoleConfig(),
        heartbeat_rrule=rrule,
        heartbeat_schedule=schedule,
        status="active",
    )


def test_legacy_hourly_2_with_work_window_becomes_cron() -> None:
    cfg = ProactiveRoleConfig(work_schedule_enabled=True, work_start_hour=9, work_end_hour=20)
    cron = legacy_rrule_to_cron("FREQ=HOURLY;INTERVAL=2", cfg)
    assert cron == "0 9-19/2 * * *"


def test_cron_human_summary_for_employee_patterns() -> None:
    from evoflow.admin.automation_schedule import cron_human_summary

    assert cron_human_summary("0 9-19/2 * * *") == "每 2 小时（9–19 点）"
    assert cron_human_summary("0 9-19 * * *") == "每小时（9–19 点）"
    assert cron_human_summary("0 */2 * * *") == "每 2 小时"
    assert cron_human_summary("0 * * * *") == "每小时"
    assert cron_human_summary("*/30 * * * *") == "每 30 分钟"
    assert cron_human_summary("0 10 * * *") == "每天 10:00"
    assert cron_human_summary("0 9 * * 1-5") == "工作日 09:00"


def test_legacy_hourly_1_with_work_window_becomes_cron() -> None:
    cfg = ProactiveRoleConfig(work_schedule_enabled=True, work_start_hour=9, work_end_hour=20)
    cron = legacy_rrule_to_cron("FREQ=HOURLY;INTERVAL=1", cfg)
    assert cron == "0 9-19 * * *"


def test_legacy_hourly_without_work_window() -> None:
    cfg = ProactiveRoleConfig(work_schedule_enabled=False)
    assert legacy_rrule_to_cron("FREQ=HOURLY;INTERVAL=1", cfg) == "0 * * * *"
    assert legacy_rrule_to_cron("FREQ=HOURLY;INTERVAL=2", cfg) == "0 */2 * * *"


def test_resolve_role_prefers_heartbeat_schedule() -> None:
    role = _role(schedule="0 9 * * 1-5", rrule="FREQ=HOURLY;INTERVAL=1")
    assert resolve_role_cron(role) == "0 9 * * 1-5"


def test_resolve_role_migrates_rrule_stuffed_into_schedule() -> None:
    role = _role(schedule="FREQ=HOURLY;INTERVAL=1", rrule="")
    assert resolve_role_cron(role) == "0 9-19 * * *"


def test_ensure_role_schedule_fields_rewrites_legacy() -> None:
    role = _role(schedule="", rrule="FREQ=HOURLY;INTERVAL=2")
    assert ensure_role_schedule_fields(role) is True
    assert role.heartbeat_schedule == "0 9-19/2 * * *"
    assert ensure_role_schedule_fields(role) is False


def test_migrate_stored_schedule_from_rrule() -> None:
    cfg_json = ProactiveRoleConfig(
        work_schedule_enabled=True,
        work_start_hour=9,
        work_end_hour=20,
    ).to_json()
    cron = migrate_stored_schedule("FREQ=HOURLY;INTERVAL=2", cfg_json)
    assert cron == "0 9-19/2 * * *"


def test_compute_next_duty_from_cron() -> None:
    role = _role(schedule="0 10 * * *")
    noon = datetime(2026, 7, 18, 11, 30, tzinfo=BEIJING_TZ)
    nxt = compute_next_duty_iso(role, now=noon)
    dt = datetime.fromisoformat(nxt)
    assert dt.hour == 10
    assert dt.day == 19


def test_v126_migration_rewrites_legacy_rows() -> None:
        
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    ensure_app_schema(conn)
    # Pre-v126 shape: RRULE only (column may be absent until migrate adds it).
    cols = {str(r[1]) for r in conn.execute("PRAGMA table_info(evoflow_proactive_roles)").fetchall()}
    if "heartbeat_schedule" not in cols:
        # Insert via columns that exist on v86
        conn.execute(
            """
            INSERT INTO evoflow_proactive_roles
            (agent_code, role_name, department, config_json, heartbeat_rrule, status, created_at, updated_at)
            VALUES (?, ?, '', ?, ?, 'active', 't', 't')
            """,
            (
                "dev",
                "Dev",
                ProactiveRoleConfig(work_schedule_enabled=True, work_start_hour=9, work_end_hour=20).to_json(),
                "FREQ=HOURLY;INTERVAL=1",
            ),
        )
        conn.execute(
            """
            INSERT INTO evoflow_proactive_roles
            (agent_code, role_name, department, config_json, heartbeat_rrule, status, created_at, updated_at)
            VALUES (?, ?, '', ?, ?, 'active', 't', 't')
            """,
            (
                "ops",
                "Ops",
                ProactiveRoleConfig(work_schedule_enabled=True, work_start_hour=9, work_end_hour=20).to_json(),
                "FREQ=HOURLY;INTERVAL=2",
            ),
        )
        conn.commit()

    ensure_app_schema(conn)
    # Idempotent second pass
    ensure_app_schema(conn)

    by_code = {
        str(r["agent_code"]): str(r["heartbeat_schedule"])
        for r in conn.execute(
            "SELECT agent_code, heartbeat_schedule FROM evoflow_proactive_roles"
        ).fetchall()
    }
    assert by_code["dev"] == "0 9-19 * * *"
    assert by_code["ops"] == "0 9-19/2 * * *"
    conn.close()


def test_cron_range_step_matches_default_duty_hours() -> None:
    """``9-19/2`` must match 9,11,13… — previously broken → empty next → stampede."""
    from evoflow.admin.automation_schedule import cron_field_matches, next_cron_runs

    assert cron_field_matches(9, "9-19/2")
    assert cron_field_matches(11, "9-19/2")
    assert not cron_field_matches(10, "9-19/2")
    assert not cron_field_matches(8, "9-19/2")
    assert cron_field_matches(19, "9-19/2")

    now = datetime(2026, 8, 26, 10, 50, 45)
    runs = next_cron_runs("0 9-19/2 * * *", count=3, from_dt=now)
    assert runs == [
        datetime(2026, 8, 26, 11, 0),
        datetime(2026, 8, 26, 13, 0),
        datetime(2026, 8, 26, 15, 0),
    ]


def test_compute_next_duty_iso_for_default_cron_is_future() -> None:
    now = datetime(2026, 8, 26, 10, 50, 45, tzinfo=BEIJING_TZ)
    role = _role(schedule="0 9-19/2 * * *")
    nxt = compute_next_duty_iso(role, now=now)
    assert nxt.startswith("2026-08-26T11:00:00")
