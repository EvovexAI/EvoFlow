"""回归：组织包占位符（曾因 manifest.py 缺 import os 而全量安装回滚）。"""

from __future__ import annotations

from evoflow.organizations.manifest import apply_placeholders, deep_apply_placeholders
from evoflow.proactive.employee_prompting.org_roster import build_employee_org_roster_block
from evoflow.proactive.models import ProactiveRole, ProactiveRoleConfig
from evoflow.proactive.org import role_workspace_display


def test_apply_placeholders_resolves_evoflow_home(monkeypatch) -> None:
    monkeypatch.setenv("EVOFLOW_HOME", "C:/fake-home")
    out = apply_placeholders(
        "home=${EVOFLOW_HOME} ws=${ORG_WORKSPACE} root=${ORG_ROOT}",
        org_workspace="D:/ws",
        org_root="D:/pack",
    )
    assert out == "home=C:/fake-home ws=D:/ws root=D:/pack"


def test_apply_placeholders_accepts_lowercase_tokens() -> None:
    out = apply_placeholders(
        "c:/users/admin/.evoflow/profiles/default/${org_workspace}",
        org_workspace="acme-org",
        org_root="",
    )
    assert "acme-org" in out.replace("\\", "/")
    assert "${org_workspace}" not in out
    assert "${ORG_WORKSPACE}" not in out


def test_deep_apply_placeholders_walks_nested(monkeypatch) -> None:
    monkeypatch.setenv("EVOFLOW_HOME", "C:/fake-home")
    payload = {
        "config": {
            "workspace_path": ["${ORG_WORKSPACE}"],
            "nested": {"p": "${ORG_ROOT}/x"},
        },
        "keep": 3,
    }
    out = deep_apply_placeholders(payload, org_workspace="D:/ws", org_root="D:/pack")
    assert out["config"]["workspace_path"] == ["D:/ws"]
    assert out["config"]["nested"]["p"] == "D:/pack/x"
    assert out["keep"] == 3


def test_solo_org_block_injects_agent_code_and_resolves_placeholder() -> None:
    role = ProactiveRole(
        agent_code="solo-bot",
        role_name="独立测试岗",
        department="",
        status="active",
        config=ProactiveRoleConfig(
            workspace_path="c:/users/admin/.evoflow/profiles/default/${org_workspace}",
        ),
    )
    display = role_workspace_display(role)
    assert "solo-bot" in display.replace("\\", "/")
    assert "${" not in display

    block = build_employee_org_roster_block(role, roster=[role])
    assert block.startswith("<employee_org>")
    assert 'version="' not in block
    assert "agent_code=`solo-bot`" in block
    assert "${org_workspace}" not in block
    assert "独立岗" in block
