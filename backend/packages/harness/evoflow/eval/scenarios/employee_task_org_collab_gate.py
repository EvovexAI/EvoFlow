"""Employee: same-org peer wake allowed; cross-org dispatch denied."""

from __future__ import annotations

from pathlib import Path

from evoflow.eval.scenarios._harness import check, finalize, run_scenario
from evoflow.eval.scenarios._persist import expect_agent, expect_role
from evoflow.eval.scenarios._runtime_contract import ensure_agent, runtime_contract_metrics

_MGR = "eval-org-mgr"
_PEER_A = "eval-org-peer-a"
_PEER_B = "eval-org-peer-b"
_FOREIGN = "eval-org-foreign"
_WS_HOME = "D:/eval/org-home"
_WS_OTHER = "D:/eval/org-other"


def _hire(code: str, name: str, *, workspace: str, reports_to: str = "") -> None:
    from evoflow.admin import employees as employees_admin
    from evoflow.admin.errors import ConflictError
    from evoflow.proactive.repositories import ProactiveRepository

    payload = {
        "agent_code": code,
        "role_name": name,
        "responsibilities": ["组织协同评测"],
        "work_schedule_enabled": False,
        "workspace_path": workspace,
        "autonomy_level": "full_auto",
    }
    if reports_to:
        payload["reports_to"] = reports_to
    if ProactiveRepository.get_role(code) is None:
        try:
            employees_admin.hire(payload)
            return
        except ConflictError:
            pass
    employees_admin.update_role(code, payload)


def _run(home: Path) -> dict:
    del home
    from evoflow.proactive.repositories import ProactiveRepository
    from evoflow.proactive.runner import validate_dispatch_org_relationship

    for code, name in (
        (_MGR, "组织上级"),
        (_PEER_A, "同组织平级A"),
        (_PEER_B, "同组织平级B"),
        (_FOREIGN, "外组织员工"),
    ):
        ensure_agent(
            agent_code=code,
            agent_name=name,
            description="org collab eval",
            soul="Collaborate within org.",
            system_prompt="Follow org dispatch rules.",
            tools=["read"],
        )

    _hire(_MGR, "组织上级", workspace=_WS_HOME)
    _hire(_PEER_A, "同组织平级A", workspace=_WS_HOME, reports_to=_MGR)
    _hire(_PEER_B, "同组织平级B", workspace=_WS_HOME, reports_to=_MGR)
    _hire(_FOREIGN, "外组织员工", workspace=_WS_OTHER)

    roster = [
        r
        for r in ProactiveRepository.list_roles()
        if str(r.status or "").strip().lower() != "archived"
    ]

    peer_err = validate_dispatch_org_relationship(
        from_agent=_PEER_A, target_code=_PEER_B, roster=roster
    )
    cross_err = validate_dispatch_org_relationship(
        from_agent=_PEER_A, target_code=_FOREIGN, roster=roster
    )
    user_err = validate_dispatch_org_relationship(
        from_agent="user", target_code=_FOREIGN, roster=roster
    )
    mgr_err = validate_dispatch_org_relationship(
        from_agent=_MGR, target_code=_PEER_A, roster=roster
    )
    xiaomi_err = validate_dispatch_org_relationship(
        from_agent="xiaomi", target_code=_FOREIGN, roster=roster
    )

    assertions = [
        check(
            "same_org_peer_allowed",
            peer_err is None,
            inputs={"from": _PEER_A, "to": _PEER_B},
            expected="同组织平级可叫醒协作",
            actual=peer_err or "allowed",
            api="validate_dispatch_org_relationship",
        ),
        check(
            "manager_to_report_allowed",
            mgr_err is None,
            inputs={"from": _MGR, "to": _PEER_A},
            expected="上级可派给直属下级",
            actual=mgr_err or "allowed",
            api="validate_dispatch_org_relationship",
        ),
        check(
            "cross_org_denied",
            cross_err is not None and ("跨组织" in str(cross_err) or "组织" in str(cross_err)),
            inputs={"from": _PEER_A, "to": _FOREIGN},
            expected="跨组织禁止派发",
            actual=cross_err,
            api="validate_dispatch_org_relationship",
        ),
        check(
            "human_user_can_dispatch",
            user_err is None,
            inputs={"from": "user", "to": _FOREIGN},
            expected="真人用户不受组织互派限制",
            actual=user_err or "allowed",
            api="validate_dispatch_org_relationship",
        ),
        check(
            "xiaomi_front_desk_can_dispatch",
            xiaomi_err is None,
            inputs={"from": "xiaomi", "to": _FOREIGN},
            expected="小V系统前台不受组织互派限制",
            actual=xiaomi_err or "allowed",
            api="validate_dispatch_org_relationship",
        ),
    ]
    persist = [
        expect_agent(_PEER_A),
        expect_agent(_PEER_B),
        expect_agent(_FOREIGN),
        expect_role(_PEER_A, role_name="同组织平级A"),
        expect_role(_FOREIGN, role_name="外组织员工"),
    ]
    metrics = runtime_contract_metrics(
        agent_codes=[_MGR, _PEER_A, _PEER_B, _FOREIGN],
        extra={
            "eval_pack": "employees",
            "arch": "emp.collab.org_gate",
            "peer_err": peer_err,
            "cross_err": cross_err,
        },
    )
    return finalize(
        assertions + persist,
        metrics=metrics,
        steps=[
            {"step": 1, "api": "hire same-org mgr+peers + foreign"},
            {"step": 2, "api": "validate peer allow / cross deny / user+xiaomi allow"},
        ],
    )


def run(**_kwargs) -> dict:
    return run_scenario(_run)
