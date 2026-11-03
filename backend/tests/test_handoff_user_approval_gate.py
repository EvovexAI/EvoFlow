"""User-raised tasks with handlers: system holds wake for human ack."""

import evoflow.admin.tasks as tasks_mod
from evoflow.admin.tasks import handoff_needs_approval


def test_user_raised_with_handlers_needs_approval() -> None:
    task = {
        "assigned_to": "dev-tech-director",
        "raised_by": "user",
        "risk_level": "low",
        "handlers": [
            {"agent_code": "dev-frontend", "goal": "实现前端"},
            {"agent_code": "dev-backend", "goal": "实现后端"},
        ],
    }
    assert handoff_needs_approval(task) is True


def test_xiaomi_raised_with_handlers_needs_approval() -> None:
    task = {
        "assigned_to": "dev-tech-director",
        "raised_by": "xiaomi",
        "risk_level": "low",
        "handlers": [{"agent_code": "dev-frontend", "goal": "ui"}],
    }
    assert handoff_needs_approval(task) is True


def test_peer_raised_low_risk_without_user_may_skip() -> None:
    """Non-user raised: fall back to autonomy×risk (no role in DB → False)."""
    task = {
        "assigned_to": "unknown-role-xyz",
        "raised_by": "dev-backend",
        "risk_level": "low",
        "handlers": [{"agent_code": "dev-frontend", "goal": "ui"}],
    }
    assert handoff_needs_approval(task) is False


def test_no_handlers_never_handoff_gate() -> None:
    task = {
        "assigned_to": "dev-tech-director",
        "raised_by": "user",
        "risk_level": "low",
        "handlers": [],
    }
    assert handoff_needs_approval(task) is False


# ── 总开关 runtime.handoff_approval ────────────────────────────────────


def _user_task() -> dict:
    return {
        "assigned_to": "dev-tech-director",
        "raised_by": "user",
        "risk_level": "high",
        "handlers": [{"agent_code": "dev-frontend", "goal": "实现前端"}],
    }


def test_switch_off_disables_gate_for_user_raised(monkeypatch) -> None:
    """关闭总开关后，用户派单交接也直接派发，不再等人点头。"""
    monkeypatch.setattr(tasks_mod, "handoff_approval_enabled", lambda: False)
    assert handoff_needs_approval(_user_task()) is False


def test_switch_on_keeps_gate(monkeypatch) -> None:
    monkeypatch.setattr(tasks_mod, "handoff_approval_enabled", lambda: True)
    assert handoff_needs_approval(_user_task()) is True


def test_switch_off_still_never_gates_without_handlers(monkeypatch) -> None:
    monkeypatch.setattr(tasks_mod, "handoff_approval_enabled", lambda: False)
    task = {**_user_task(), "handlers": []}
    assert handoff_needs_approval(task) is False


def test_handoff_approval_enabled_defaults_true_when_unset(monkeypatch) -> None:
    """未配置该 key 时保持历史行为（需要审核）。"""
    import evoflow.persistence.config_repositories as repo

    monkeypatch.setattr(repo, "get_app_setting", lambda key: None)
    assert tasks_mod.handoff_approval_enabled() is True


def test_handoff_approval_enabled_reads_false(monkeypatch) -> None:
    import evoflow.persistence.config_repositories as repo

    for raw in (False, "false", "0", "off", {"enabled": False}):
        monkeypatch.setattr(repo, "get_app_setting", lambda key, _raw=raw: _raw)
        assert tasks_mod.handoff_approval_enabled() is False


def test_handoff_approval_enabled_reads_true(monkeypatch) -> None:
    import evoflow.persistence.config_repositories as repo

    for raw in (True, "true", "1", "on", {"enabled": True}):
        monkeypatch.setattr(repo, "get_app_setting", lambda key, _raw=raw: _raw)
        assert tasks_mod.handoff_approval_enabled() is True
