"""heartbeat_schedule=off → no timed patrol."""

from __future__ import annotations

from evoflow.proactive.models import ProactiveRole, ProactiveRoleConfig
from evoflow.proactive.schedule import (
    SCHEDULE_OFF,
    apply_schedule_input,
    compute_next_duty_iso,
    ensure_role_schedule_fields,
    resolve_role_cron,
    schedule_summary_for_role,
    sync_role_schedule_fields,
    wire_role_schedule,
)


def _role(**kwargs) -> ProactiveRole:
    return ProactiveRole(
        agent_code="tech-director",
        role_name="技术总监",
        config=ProactiveRoleConfig(),
        **kwargs,
    )


def test_off_resolves_to_empty_cron() -> None:
    role = _role(heartbeat_schedule=SCHEDULE_OFF)
    assert resolve_role_cron(role) == ""
    assert wire_role_schedule(role) == SCHEDULE_OFF
    assert schedule_summary_for_role(role) == "关闭巡检"
    assert compute_next_duty_iso(role) == ""


def test_apply_off_suspends_and_clears_next() -> None:
    role = _role(heartbeat_schedule="0 9,15 * * *", next_heartbeat_at="2099-01-01T00:00:00+08:00")
    assert apply_schedule_input(role, heartbeat_schedule="off") is True
    assert role.heartbeat_schedule == SCHEDULE_OFF
    assert role.next_heartbeat_at is None
    assert role.config.auto_patrol_suspended is True


def test_apply_cron_clears_suspend() -> None:
    role = _role(heartbeat_schedule=SCHEDULE_OFF)
    role.config.auto_patrol_suspended = True
    assert apply_schedule_input(role, heartbeat_schedule="0 9 * * *") is True
    assert role.heartbeat_schedule == "0 9 * * *"
    assert role.config.auto_patrol_suspended is False


def test_ensure_preserves_off() -> None:
    role = _role(heartbeat_schedule="off")
    changed = ensure_role_schedule_fields(role)
    assert role.heartbeat_schedule == SCHEDULE_OFF
    assert resolve_role_cron(role) == ""
    # second pass stable
    assert ensure_role_schedule_fields(role) is False or role.heartbeat_schedule == SCHEDULE_OFF
    _ = changed


def test_sync_off_token_variants() -> None:
    for token in ("off", "never", "disabled", "@never"):
        role = _role(heartbeat_schedule="0 9 * * *")
        sync_role_schedule_fields(role, token)
        assert role.heartbeat_schedule == SCHEDULE_OFF
        assert resolve_role_cron(role) == ""
