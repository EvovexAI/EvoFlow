"""Org wiring helpers: top may lack manager; same-org unlinked is not solo."""

from evoflow.proactive.models import ProactiveRole, ProactiveRoleConfig
from evoflow.proactive.org import describe_org_wiring


def _role(code: str, *, reports_to: str = "", workspace: str = "/tmp/ws") -> ProactiveRole:
    return ProactiveRole(
        agent_code=code,
        role_name=code,
        department="研发部",
        status="active",
        config=ProactiveRoleConfig(workspace_path=workspace, reports_to=reports_to),
    )


def test_top_with_reports_is_linked_not_needing_wiring() -> None:
    lead = _role("lead", reports_to="")
    fe = _role("fe", reports_to="lead")
    snap = describe_org_wiring(lead, [lead, fe])
    assert snap["reporting_linked"] is True
    assert snap["needs_reports_to_wiring"] is False
    assert snap["direct_report_codes"] == ["fe"]
    assert snap["is_true_solo"] is False


def test_same_org_unlinked_needs_wiring() -> None:
    lead = _role("lead", reports_to="")
    fe = _role("fe", reports_to="")
    snap = describe_org_wiring(lead, [lead, fe])
    assert snap["workspace_bound"] is True
    assert snap["needs_reports_to_wiring"] is True
    assert snap["is_true_solo"] is False
    assert "fe" in snap["same_org_other_codes"]


def test_true_solo_unbound() -> None:
    solo = _role("solo", reports_to="", workspace="")
    other = _role("other", reports_to="", workspace="/tmp/other")
    snap = describe_org_wiring(solo, [solo, other])
    # Unbound + no reporting → prompt solo (do not treat global roster as a team).
    assert snap["workspace_bound"] is False
    assert snap["needs_reports_to_wiring"] is False
    assert snap["reporting_linked"] is False
    assert snap["is_true_solo"] is True


def test_bound_alone_is_true_solo() -> None:
    alone = _role("alone", reports_to="", workspace="/tmp/only-me")
    snap = describe_org_wiring(alone, [alone])
    assert snap["is_true_solo"] is True
    assert snap["needs_reports_to_wiring"] is False
