"""小V（系统前台）派发不受组织上下级/平级限制。"""

from __future__ import annotations

from evoflow.proactive.models import ProactiveRole, ProactiveRoleConfig
from evoflow.proactive.runner import validate_dispatch_org_relationship


def _role(code: str, *, reports_to: str = "", workspace: str = "/ws/a") -> ProactiveRole:
    return ProactiveRole(
        agent_code=code,
        role_name=code,
        config=ProactiveRoleConfig(reports_to=reports_to, workspace_path=workspace),
    )


def test_xiaomi_can_dispatch_across_org_and_hierarchy() -> None:
    mgr = _role("mgr", workspace="/ws/a")
    arch = _role("project-architect", reports_to="mgr", workspace="/ws/a")
    foreign = _role("foreign-dev", workspace="/ws/b")
    xiaomi = _role("xiaomi", workspace="")
    roster = [mgr, arch, foreign, xiaomi]

    assert (
        validate_dispatch_org_relationship(
            from_agent="xiaomi", target_code="project-architect", roster=roster
        )
        is None
    )
    assert (
        validate_dispatch_org_relationship(
            from_agent="xiaomi", target_code="foreign-dev", roster=roster
        )
        is None
    )
    # Alias display code still treated as front desk.
    assert (
        validate_dispatch_org_relationship(
            from_agent="小V", target_code="project-architect", roster=roster
        )
        is None
    )


def test_xiaomi_cannot_dispatch_to_self() -> None:
    xiaomi = _role("xiaomi", workspace="")
    arch = _role("project-architect", workspace="/ws/a")
    roster = [xiaomi, arch]
    err = validate_dispatch_org_relationship(
        from_agent="xiaomi", target_code="xiaomi", roster=roster
    )
    assert err and "自己" in err


def test_ordinary_employee_still_org_gated() -> None:
    mgr = _role("mgr", workspace="/ws/a")
    peer_a = _role("peer-a", reports_to="mgr", workspace="/ws/a")
    peer_b = _role("peer-b", reports_to="mgr", workspace="/ws/a")
    foreign = _role("foreign", workspace="/ws/b")
    roster = [mgr, peer_a, peer_b, foreign]

    assert (
        validate_dispatch_org_relationship(
            from_agent="peer-a", target_code="peer-b", roster=roster
        )
        is None
    )
    err = validate_dispatch_org_relationship(
        from_agent="peer-a", target_code="foreign", roster=roster
    )
    assert err and "跨组织" in err


def test_xiaomi_handler_assignee_can_manage_anyone() -> None:
    from evoflow.collab.handler_org import validate_handler_assignee

    mgr = _role("mgr", workspace="/ws/a")
    arch = _role("project-architect", reports_to="mgr", workspace="/ws/a")
    foreign = _role("foreign-dev", workspace="/ws/b")
    xiaomi = _role("xiaomi", workspace="")
    roster = [mgr, arch, foreign, xiaomi]

    assert (
        validate_handler_assignee(
            from_agent="xiaomi", target_code="project-architect", roster=roster
        )
        is None
    )
    assert (
        validate_handler_assignee(
            from_agent="xiaomi", target_code="foreign-dev", roster=roster
        )
        is None
    )
    err = validate_handler_assignee(
        from_agent="xiaomi", target_code="xiaomi", roster=roster
    )
    assert err and "自己" in err


def test_xiaomi_duty_prompt_says_manage_anyone() -> None:
    from evoflow.agents.xiaomi.duty import build_xiaomi_duty_system_prompt
    from evoflow.proactive.models import ProactiveRole, ProactiveRoleConfig

    role = ProactiveRole(
        agent_code="xiaomi",
        role_name="小V",
        config=ProactiveRoleConfig(),
    )
    text = build_xiaomi_duty_system_prompt(role)
    assert "可管理任何人" in text or "管理平台上任何人" in text
    assert "只能派直属下级" in text  # explicit anti-pattern warning
    assert "直属下级（你可派活的直接下属）" not in text
