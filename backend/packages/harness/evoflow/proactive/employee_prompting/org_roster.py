"""``<employee_org>`` — org structure + roster only (no task-handoff essay).

Data: ``evoflow.proactive.org``. Collaboration / handlers copy lives in
``collab_rules.py``. Assemble order: job → org_roster → collab_rules → …
"""

from __future__ import annotations

from typing import Literal

from evoflow.proactive.models import ProactiveRole

OrgDetail = Literal["compact", "full"]

ORG_OPEN = "<employee_org>"
ORG_CLOSE = "</employee_org>"

_WIRING_WARN = (
    "⚠ 汇报线未挂通：同组织已有同事，但无人配置 ``reports_to``。"
    "顶级可无上级；**下属必须** ``reports_to``=上级 ``agent_code``，"
    "否则本岗看不到直属下级。"
)


def _load_active_roster() -> list[ProactiveRole]:
    try:
        from evoflow.proactive.repositories import ProactiveRepository

        return list(ProactiveRepository.list_roles(status="active") or [])
    except Exception:
        return []


def _person_line(role: ProactiveRole) -> str:
    """``code · name（dept）`` — 名册不展示职责。"""
    code = str(role.agent_code or "").strip()
    name = str(role.role_name or "").strip() or code or "—"
    dept = str(role.department or "").strip()
    head = f"- `{code}` · {name}"
    if dept:
        head += f"（{dept}）"
    return head


def _peers_same_manager(role: ProactiveRole, peers: list[ProactiveRole]) -> list[ProactiveRole]:
    from evoflow.proactive.org import reports_to_code

    self_code = str(role.agent_code or "").strip()
    self_mgr = reports_to_code(role)
    out = [
        r
        for r in peers
        if str(r.agent_code or "").strip() != self_code
        and reports_to_code(r) == self_mgr
        and self_mgr
        and self_mgr != str(r.agent_code or "").strip()
    ]
    out.sort(key=lambda r: (str(r.role_name or ""), str(r.agent_code or "")))
    return out


def build_employee_org_roster_block(
    role: ProactiveRole | None,
    *,
    roster: list[ProactiveRole] | None = None,
    detail: OrgDetail = "compact",
) -> str:
    """People + reporting tree for system prompt. No handlers/wake copy."""
    if role is None:
        return ""

    from evoflow.proactive.org import (
        describe_org_wiring,
        filter_roster_same_org,
        get_manager,
        list_direct_reports,
        reports_to_code,
        role_org_key,
        role_workspace_display,
    )

    raw = roster if roster is not None else _load_active_roster()
    wiring = describe_org_wiring(role, raw)
    peers = filter_roster_same_org(role, raw)
    self_code = str(role.agent_code or "").strip()
    self_key = role_org_key(role)
    self_ws = role_workspace_display(role)
    manager = get_manager(role, peers)
    reports = list_direct_reports(role, peers)
    peers_same_mgr = _peers_same_manager(role, peers)

    if wiring.get("is_true_solo"):
        who = f"agent_code=`{self_code}`" if self_code else "本岗"
        if self_ws:
            tip = f"独立岗（{who} · workspace=`{self_ws}`）；无上下级/平级名册。"
        else:
            tip = f"独立岗（{who}）；未绑 workspace、无上下级/平级。"
        return "\n".join([ORG_OPEN, tip, ORG_CLOSE])

    if self_key:
        ws_label = self_ws or self_key
        boundary = (
            f"组织边界：相同 ``workspace_path``（`{ws_label}`）；本岗 ``agent_code``=`{self_code or '—'}`。"
            "上下级由 ``reports_to``（直属上级 agent_code）定义；``department`` 仅展示。"
            "顶级可无上级；有下级时由下属的 ``reports_to`` 指向本岗。"
        )
    else:
        boundary = (
            "组织边界：未绑定 workspace → 名册为全部 active。"
            "上下级由 ``reports_to`` 定义；绑定 workspace 后按同 workspace 划分。"
        )

    lines: list[str] = [
        ORG_OPEN,
        "# 组织架构（本岗视角 · 名册）",
        boundary,
        "",
    ]
    if wiring.get("needs_reports_to_wiring"):
        lines.extend([_WIRING_WARN, ""])

    lines.append("## 直属上级")
    if manager:
        lines.append(_person_line(manager))
    else:
        mgr_raw = reports_to_code(role)
        if mgr_raw:
            lines.append(f"- 已配置 `reports_to={mgr_raw}`，但对方不在本组织名册（不在同 workspace）")
        else:
            lines.append("- （未设置 · 视为本组织顶层，合法）")

    lines.extend(["", "## 直属下级"])
    if reports:
        for r in reports:
            lines.append(_person_line(r))
    elif wiring.get("needs_reports_to_wiring"):
        lines.append("- （无——同组织有人，但尚未有人 ``reports_to`` 指向本岗）")
    else:
        lines.append("- （无直属下级）")

    lines.extend(["", "## 同组织平级（同一上级）"])
    if peers_same_mgr:
        for r in peers_same_mgr:
            lines.append(_person_line(r))
    else:
        lines.append("- （无）")

    show_roster = detail == "full" or bool(wiring.get("needs_reports_to_wiring"))
    if show_roster:
        lines.extend(
            [
                "",
                "## 同组织名册",
                "| agent_code | 岗位 | 上级 | 部门 |",
                "|---|---|---|---|",
            ]
        )
        if not peers:
            lines.append("| （空） | — | — | — |")
        else:
            for peer in peers:
                code = str(peer.agent_code or "").strip()
                mark = " ←你" if code == self_code else ""
                mgr = reports_to_code(peer) or "—"
                lines.append(
                    f"| `{code}`{mark} | {peer.role_name} | `{mgr}` | {peer.department or '—'} |"
                )

    lines.append(ORG_CLOSE)
    return "\n".join(lines)
