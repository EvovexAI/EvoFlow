"""Tests for handler org validation (same-org + direct-report)."""

from __future__ import annotations

from evoflow.collab.handler_org import (
    assert_handlers_org_ok,
    first_hop_toward_descendant,
    is_descendant,
    validate_handler_assignee,
)
from evoflow.proactive.models import ProactiveRole, ProactiveRoleConfig


def _role(code: str, *, reports_to: str = "", workspace: str = "/ws/a") -> ProactiveRole:
    return ProactiveRole(
        agent_code=code,
        role_name=code,
        config=ProactiveRoleConfig(reports_to=reports_to, workspace_path=workspace),
    )


def test_direct_report_ok_and_skip_level_rejected():
    mgr = _role("mgr")
    lead = _role("lead", reports_to="mgr")
    dev = _role("dev", reports_to="lead")
    roster = [mgr, lead, dev]

    assert validate_handler_assignee(from_agent="mgr", target_code="lead", roster=roster) is None
    err = validate_handler_assignee(from_agent="mgr", target_code="dev", roster=roster)
    assert err and "逐级" in err
    assert is_descendant(mgr, dev, roster)
    hop = first_hop_toward_descendant(mgr, dev, roster)
    assert hop is not None and hop.agent_code == "lead"


def test_cross_org_rejected():
    a = _role("a", workspace="/ws/a")
    b = _role("b", reports_to="a", workspace="/ws/b")
    roster = [a, b]
    err = validate_handler_assignee(from_agent="a", target_code="b", roster=roster)
    assert err and "跨组织" in err


def test_user_confirm_allows_peer_same_org_anchor():
    mgr = _role("mgr")
    peer = _role("peer")  # no reports_to link
    roster = [mgr, peer]
    # Employee cannot assign peer
    assert validate_handler_assignee(from_agent="mgr", target_code="peer", roster=roster)
    # Human confirm with org_anchor=mgr allows same-org peer
    assert (
        validate_handler_assignee(
            from_agent="user",
            target_code="peer",
            roster=roster,
            org_anchor="mgr",
        )
        is None
    )


def test_assert_handlers_org_ok_raises():
    from evoflow.admin.errors import ValidationError

    mgr = _role("mgr")
    peer = _role("peer")
    roster = [mgr, peer]
    try:
        assert_handlers_org_ok(
            from_agent="mgr",
            handlers=[{"agent_code": "peer", "content": "x", "read_outputs": []}],
            roster=roster,
        )
        raise AssertionError("expected ValidationError")
    except ValidationError as e:
        assert "组织校验" in str(e)


def test_xiaomi_can_assign_any_handler():
    mgr = _role("mgr")
    peer = _role("peer")
    foreign = _role("foreign", workspace="/ws/b")
    roster = [mgr, peer, foreign, _role("xiaomi", workspace="")]
    assert (
        validate_handler_assignee(
            from_agent="xiaomi", target_code="peer", roster=roster
        )
        is None
    )
    assert (
        validate_handler_assignee(
            from_agent="xiaomi", target_code="foreign", roster=roster
        )
        is None
    )
