"""User-raised tasks with handlers: system holds wake for human ack."""

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
