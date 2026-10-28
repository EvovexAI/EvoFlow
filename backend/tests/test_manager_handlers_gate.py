"""Managers cannot leaf-complete with empty handlers unless they give a reason."""

from __future__ import annotations

import pytest

from evoflow.admin.errors import ValidationError
from evoflow.admin.tasks import assert_manager_handoff_handlers, list_assignee_direct_report_codes
from evoflow.proactive.models import ProactiveRole, ProactiveRoleConfig


def test_assert_manager_requires_handlers_or_reason(monkeypatch: pytest.MonkeyPatch) -> None:
    lead = ProactiveRole(
        agent_code="dev-tech-director",
        role_name="技术总监",
        department="研发部",
        status="active",
        config=ProactiveRoleConfig(workspace_path="/tmp/agent", reports_to=""),
    )
    fe = ProactiveRole(
        agent_code="dev-frontend",
        role_name="前端",
        department="研发部",
        status="active",
        config=ProactiveRoleConfig(workspace_path="/tmp/agent", reports_to="dev-tech-director"),
    )

    class _Repo:
        @staticmethod
        def get_role(code: str):
            return {"dev-tech-director": lead, "dev-frontend": fe}.get(code)

        @staticmethod
        def list_roles(status=None):
            return [lead, fe]

    monkeypatch.setattr(
        "evoflow.proactive.repositories.ProactiveRepository.get_role",
        _Repo.get_role,
    )
    monkeypatch.setattr(
        "evoflow.proactive.repositories.ProactiveRepository.list_roles",
        _Repo.list_roles,
    )

    assert list_assignee_direct_report_codes("dev-tech-director") == ["dev-frontend"]

    with pytest.raises(ValidationError, match="handlers"):
        assert_manager_handoff_handlers(
            assignee="dev-tech-director",
            target_status="completed",
            handlers=[],
            handlers_empty_reason="",
        )

    assert_manager_handoff_handlers(
        assignee="dev-tech-director",
        target_status="completed",
        handlers=[{"agent_code": "dev-frontend", "content": "做前端"}],
        handlers_empty_reason="",
    )

    assert_manager_handoff_handlers(
        assignee="dev-tech-director",
        target_status="completed",
        handlers=[],
        handlers_empty_reason="仅修订文档、无下游",
    )


def test_leaf_role_may_complete_without_handlers(monkeypatch: pytest.MonkeyPatch) -> None:
    fe = ProactiveRole(
        agent_code="dev-frontend",
        role_name="前端",
        department="研发部",
        status="active",
        config=ProactiveRoleConfig(workspace_path="/tmp/agent", reports_to="dev-tech-director"),
    )

    class _Repo:
        @staticmethod
        def get_role(code: str):
            return fe if code == "dev-frontend" else None

        @staticmethod
        def list_roles(status=None):
            return [fe]

    monkeypatch.setattr(
        "evoflow.proactive.repositories.ProactiveRepository.get_role",
        _Repo.get_role,
    )
    monkeypatch.setattr(
        "evoflow.proactive.repositories.ProactiveRepository.list_roles",
        _Repo.list_roles,
    )

    assert_manager_handoff_handlers(
        assignee="dev-frontend",
        target_status="completed",
        handlers=[],
        handlers_empty_reason="",
    )
