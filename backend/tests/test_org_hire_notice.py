"""Hire org notice: same-dept similar posts + wiring."""

from evoflow.admin.org_hire_notice import build_org_hire_notice, find_similar_in_department
from evoflow.proactive.models import ProactiveRole, ProactiveRoleConfig


def _role(
    code: str,
    *,
    name: str = "",
    dept: str = "研发部",
    reports_to: str = "",
    workspace: str = "/tmp/agent",
) -> ProactiveRole:
    return ProactiveRole(
        agent_code=code,
        role_name=name or code,
        department=dept,
        status="active",
        config=ProactiveRoleConfig(workspace_path=workspace, reports_to=reports_to),
    )


def test_find_similar_in_department() -> None:
    a = _role("dev-frontend", name="前端开发")
    b = _role("dev-fe-2", name="前端")
    c = _role("dev-backend", name="后端开发")
    hits = find_similar_in_department(
        role_name="前端开发",
        department="研发部",
        agent_code="dev-fe-2",
        roster=[a, b, c],
    )
    codes = {h["agent_code"] for h in hits}
    assert "dev-frontend" in codes
    assert "dev-backend" not in codes
    assert "dev-fe-2" not in codes


def test_build_org_hire_notice_flags_similar_and_wiring() -> None:
    lead = _role("dev-tech-director", name="技术总监", reports_to="")
    fe = _role("dev-frontend", name="前端开发", reports_to="")
    notice = build_org_hire_notice(lead, roster=[lead, fe])
    assert notice["needs_reports_to_wiring"] is True
    assert notice["severity"] == "warning"
    assert any("汇报线" in w for w in notice["warnings"])

    fe2 = _role("dev-frontend-2", name="前端开发", reports_to="dev-tech-director")
    notice2 = build_org_hire_notice(fe2, roster=[lead, fe, fe2])
    assert notice2["same_department_similar"]
    assert any(x["agent_code"] == "dev-frontend" for x in notice2["same_department_similar"])
