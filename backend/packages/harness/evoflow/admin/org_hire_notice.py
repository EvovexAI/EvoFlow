"""Hire/create/update org notices: wiring + same-dept / same-org overlap.

Keeps employee admin free of prompt-string sprawl. Returned on create/hire/update
as ``org_notice`` (and mirrored into assistant_guide).
"""

from __future__ import annotations

from typing import Any

from evoflow.proactive.models import ProactiveRole


def _norm_name(value: str) -> str:
    return "".join(str(value or "").strip().casefold().split())


def _role_brief(role: ProactiveRole) -> dict[str, str]:
    from evoflow.proactive.org import reports_to_code, role_org_key

    return {
        "agent_code": str(role.agent_code or "").strip(),
        "role_name": str(role.role_name or "").strip(),
        "department": str(role.department or "").strip(),
        "reports_to": reports_to_code(role),
        "workspace_key": role_org_key(role),
    }


def find_similar_in_department(
    *,
    role_name: str,
    department: str,
    agent_code: str,
    roster: list[ProactiveRole],
) -> list[dict[str, str]]:
    """Same department + similar/equal role_name (excluding self)."""
    dept = str(department or "").strip()
    name_n = _norm_name(role_name)
    code = str(agent_code or "").strip()
    if not dept or not name_n:
        return []
    out: list[dict[str, str]] = []
    for r in roster:
        other = str(r.agent_code or "").strip()
        if not other or other == code:
            continue
        if str(r.department or "").strip() != dept:
            continue
        other_name = _norm_name(r.role_name)
        if not other_name:
            continue
        if other_name == name_n or name_n in other_name or other_name in name_n:
            out.append(_role_brief(r))
    return out


def find_same_org_peers(
    role: ProactiveRole,
    roster: list[ProactiveRole],
) -> list[dict[str, str]]:
    from evoflow.proactive.org import list_same_org_others

    return [_role_brief(r) for r in list_same_org_others(role, roster)]


def build_org_hire_notice(
    role: ProactiveRole,
    *,
    roster: list[ProactiveRole] | None = None,
) -> dict[str, Any]:
    """Structured notice after create / hire / update."""
    from evoflow.proactive.org import describe_org_wiring
    from evoflow.proactive.repositories import ProactiveRepository

    raw = list(roster) if roster is not None else list(ProactiveRepository.list_roles(status="active") or [])
    wiring = describe_org_wiring(role, raw)
    dept_similar = find_similar_in_department(
        role_name=str(role.role_name or ""),
        department=str(role.department or ""),
        agent_code=str(role.agent_code or ""),
        roster=raw,
    )
    same_org = find_same_org_peers(role, raw)
    needs = bool(wiring.get("needs_reports_to_wiring"))
    reports_to = str(wiring.get("reports_to") or "").strip()
    code = str(role.agent_code or "").strip()

    warnings: list[str] = []
    tips: list[str] = []

    if dept_similar:
        names = "、".join(
            f"`{x['agent_code']}`（{x['role_name'] or '未命名'}）" for x in dept_similar[:5]
        )
        warnings.append(
            f"同部门「{role.department}」已有相似岗位：{names}。"
            "确认是否重复建岗；若是上下级关系，请用 reports_to 挂树，不要再建一个平级同名岗。"
        )

    if needs:
        peers = "、".join(f"`{c}`" for c in list(wiring.get("same_org_other_codes") or [])[:6])
        warnings.append(
            "同组织已有同事"
            + (f"（{peers}）" if peers else "")
            + "但汇报线未挂通：下属须 reports_to=上级 agent_code；"
            "顶级负责人可以没有上级。未挂通时值班提示词看不到直属下级。"
        )
    elif not reports_to and not wiring.get("direct_report_codes"):
        tips.append(
            f"本岗暂无上级也无下级（合法）。建团队时：下属 create/update 带 reports_to={code}；"
            "本岗作顶级可继续留空 reports_to。"
        )
    elif not reports_to and wiring.get("direct_report_codes"):
        tips.append("本岗为顶级负责人（无上级），已有直属下级——组织名册会列出他们。")
    elif reports_to:
        tips.append(f"已挂上级 `{reports_to}`。")

    if same_org and not needs and not dept_similar:
        tips.append(
            "同组织同事："
            + "、".join(f"`{x['agent_code']}`" for x in same_org[:8])
        )

    tips.append(
        "职责文案只写正常流转与 handlers；审核由系统在「用户派单 + handlers 交工」时卡住，"
        "勿写「停下等用户审核」。"
    )

    severity = "warning" if warnings else ("info" if tips else "ok")
    say_bits = warnings + tips
    return {
        "severity": severity,
        "reports_to": reports_to,
        "manager_code": str(wiring.get("manager_code") or ""),
        "direct_report_codes": list(wiring.get("direct_report_codes") or []),
        "same_org_other_codes": list(wiring.get("same_org_other_codes") or []),
        "same_department_similar": dept_similar,
        "needs_reports_to_wiring": needs,
        "warnings": warnings,
        "tips": tips,
        "hint": " ".join(say_bits),
        # Compat with earlier org_wiring shape used by assistant_guide.
        "needs_reports_to_wiring_flag": needs,
    }
