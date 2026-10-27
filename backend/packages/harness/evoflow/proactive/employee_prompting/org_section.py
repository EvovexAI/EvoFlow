"""Single org-chart prompt section (compact for chat, full for duty).

Data from ``proactive.org``; collaboration copy aligned with product docs:
formal handoff handlers = direct reports only; peers use create (auto-wake) / 小V.

Solo posts (no manager / reports / peers) get a one-line org stub — no handoff essay.
Job text owns identity; this block does not repeat「你是…」.
"""

from __future__ import annotations

from typing import Literal

from evoflow.proactive.models import ProactiveRole

OrgDetail = Literal["compact", "full"]

ORG_OPEN = '<employee_org version="1">'
ORG_CLOSE = "</employee_org>"


def _load_active_roster() -> list[ProactiveRole]:
    try:
        from evoflow.proactive.repositories import ProactiveRepository

        return list(ProactiveRepository.list_roles(status="active") or [])
    except Exception:
        return []


def _resp_blurb(role: ProactiveRole, *, max_len: int = 72) -> str:
    items = [str(x).strip() for x in (role.config.responsibilities or []) if str(x).strip()]
    if not items:
        return "（职责未配置）"
    text = "；".join(items[:2])
    if len(items) > 2:
        text += "…"
    if len(text) > max_len:
        return text[: max_len - 1] + "…"
    return text


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


def build_employee_org_section(
    role: ProactiveRole | None,
    *,
    roster: list[ProactiveRole] | None = None,
    detail: OrgDetail = "compact",
) -> str:
    """Org block for the shared employee skeleton."""
    if role is None:
        return ""

    from evoflow.proactive.org import (
        filter_roster_same_org,
        get_manager,
        list_direct_reports,
        reports_to_code,
        role_org_key,
    )

    raw = roster if roster is not None else _load_active_roster()
    peers = filter_roster_same_org(role, raw)
    self_code = str(role.agent_code or "").strip()
    self_key = role_org_key(role)
    manager = get_manager(role, peers)
    reports = list_direct_reports(role, peers)
    peers_same_mgr = _peers_same_manager(role, peers)
    solo = manager is None and not reports and not peers_same_mgr and not reports_to_code(role)

    if solo:
        # Independent post: no reporting tree — skip handoff essay noise.
        if self_key:
            tip = f"独立岗（同 workspace=`{self_key}`）；无上下级/平级名册。"
        else:
            tip = "独立岗；未绑 workspace、无上下级/平级。需要跨岗协作时 ``tasks create``（系统自动叫醒）/ 小V。"
        return "\n".join([ORG_OPEN, tip, ORG_CLOSE])

    if self_key:
        boundary = (
            f"组织边界：相同 ``workspace_path``（key=`{self_key}`）。"
            "上下级由 ``reports_to``（直属上级 agent_code）定义；``department`` 仅展示。"
        )
    else:
        boundary = (
            "组织边界：未绑定 workspace → 名册为全部 active。"
            "上下级由 ``reports_to`` 定义；绑定 workspace 后按同 workspace 划分。"
        )

    lines: list[str] = [
        ORG_OPEN,
        "# 组织架构（本岗视角）",
        boundary,
        "",
        "## 直属上级",
    ]
    if manager:
        lines.append(
            f"- `{manager.agent_code}` · {manager.role_name}"
            f"（{manager.department or '—'}）· {_resp_blurb(manager)}"
        )
    else:
        mgr_raw = reports_to_code(role)
        if mgr_raw:
            lines.append(f"- 已配置 `reports_to={mgr_raw}`，但对方不在本组织名册（不在同 workspace）")
        else:
            lines.append("- （未设置 · 视为本组织顶层）")

    lines.extend(["", "## 直属下级（正式交工 handlers 仅限下列）"])
    if reports:
        for r in reports:
            lines.append(
                f"- `{r.agent_code}` · {r.role_name}（{r.department or '—'}）· {_resp_blurb(r)}"
            )
    else:
        lines.append("- （无直属下级）")

    lines.extend(["", "## 同组织平级岗位（可相互派活，与上下级协作同等）"])
    if peers_same_mgr:
        for r in peers_same_mgr:
            lines.append(
                f"- `{r.agent_code}` · {r.role_name}（{r.department or '—'}）· {_resp_blurb(r)}"
            )
    else:
        lines.append("- （无同一上级下的平级岗位）")

    lines.extend(
        [
            "",
            "## 协作要点",
            "- **向下（直属下级）**：本岗做完要下游继续 → 结案时 ``tasks state`` + **handlers**（系统建单并叫醒）；**禁止**对下级再 ``create``+``wake`` 做同一次交接。",
            "- **平级（同一上级）**：新事项 ``tasks create``（assignee + ``start=true`` 默认）→ **建单即开工**，不必再 wake；只排队用 ``start=false``；已有未结单才 ``wake`` + ``task_id`` 续跑。",
            "- **向上**：叶子岗对本岗 Task ``completed`` 结案即可；禁止给上级新建验收单。",
            "- **写权限**：本岗只能 ``tasks progress/state`` 自己的单（``assigned_to``=本岗）；禁止改他人/上级状态。小V 代用户不受此限。progress 可选，干完直接 completed 即可。",
            "- **wake 用途**：仅续跑/催办已有未结单；**禁止**「刚 create 完立刻再 wake」同一次派活。小V 代用户 ``create`` 同样自动叫醒。",
        ]
    )

    if detail == "full":
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


def build_org_system_section(
    role: ProactiveRole,
    *,
    roster: list[ProactiveRole] | None = None,
) -> str:
    """Compat alias — full org section."""
    return build_employee_org_section(role, roster=roster, detail="full")


def build_org_collab_section(
    role: ProactiveRole,
    *,
    roster: list[ProactiveRole] | None = None,
) -> str:
    """Compat alias."""
    return build_employee_org_section(role, roster=roster, detail="full")


def build_collab_rules_section(
    role: ProactiveRole,
    *,
    roster: list[ProactiveRole] | None = None,
) -> str:
    """Compat alias used by older duty templates."""
    return build_employee_org_section(role, roster=roster, detail="full")
