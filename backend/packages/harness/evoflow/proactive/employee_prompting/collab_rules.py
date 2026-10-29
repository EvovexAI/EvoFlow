"""``<employee_collab>`` — task handoff / wake rules (no org roster table).

Depends on ``describe_org_wiring`` for whether handlers are available.
Roster of who is who lives in ``org_roster.py``.
"""

from __future__ import annotations

from evoflow.proactive.models import ProactiveRole

COLLAB_OPEN = '<employee_collab version="1">'
COLLAB_CLOSE = "</employee_collab>"


def _load_active_roster() -> list[ProactiveRole]:
    try:
        from evoflow.proactive.repositories import ProactiveRepository

        return list(ProactiveRepository.list_roles(status="active") or [])
    except Exception:
        return []


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


def build_employee_collab_block(
    role: ProactiveRole | None,
    *,
    roster: list[ProactiveRole] | None = None,
) -> str:
    """Task-flow rules for system prompt. Empty when role missing."""
    if role is None:
        return ""

    from evoflow.proactive.org import describe_org_wiring, list_direct_reports, filter_roster_same_org

    raw = roster if roster is not None else _load_active_roster()
    wiring = describe_org_wiring(role, raw)
    peers = filter_roster_same_org(role, raw)
    reports = list_direct_reports(role, peers)
    same_mgr_peers = _peers_same_manager(role, peers)
    has_downstream = bool(reports)
    needs_wiring = bool(wiring.get("needs_reports_to_wiring"))
    is_solo = bool(wiring.get("is_true_solo"))

    lines: list[str] = [
        COLLAB_OPEN,
        "# 协作与任务流转",
    ]

    if is_solo:
        lines.extend(
            [
                "本岗无组织同事：完成后直接结案；跨岗协作经小V / ``tasks create``。",
                COLLAB_CLOSE,
            ]
        )
        return "\n".join(lines)

    if needs_wiring:
        lines.append(
            "⚠ 汇报线未挂通：正式 ``handlers`` 交工尚不可用。"
            "先用 ``tasks create``（assignee + ``start=true``）按 ``<employee_org>`` 名册派活；"
            "并尽快给下属配置 ``reports_to``=本岗 ``agent_code``（本岗作顶级可无上级）。"
        )
    elif has_downstream:
        lines.append(
            "本岗有直属下级：做完自己的部分后，结案时 ``tasks state`` + **handlers** 派给下级；"
            "**禁止**空 handlers 结案（系统会拒绝）；也禁止对下级再 ``create``+``wake`` 做同一次交接。"
        )
        lines.append(
            "下级若已自行平级交接下一环，回执时**禁止**再当传令兵重派；只验收/闭环本编排单。"
        )
        lines.append("")
        lines.append("## 本轮 handlers 候选（直属下级 · 结案必填）")
        for r in reports:
            lines.append(
                f"- `{r.agent_code}` · {r.role_name}（{r.department or '—'}）"
            )
        tip_code = str(reports[0].agent_code or "").strip()
        lines.append(
            f'示例：``handlers=[{{"agent_code":"{tip_code}","content":"按方案实现…","read_outputs":["docs/需求方案.md"]}}]``'
        )
        lines.append(
            "本轮确无下游时才许 ``handlers_empty_reason``（短因）；不要用「等用户审核」当理由——"
            "用户派单的下游确认由系统在 handlers 交工时卡住。"
        )
    elif same_mgr_peers:
        # Leaf with same-manager peers (e.g. 全栈 → 验证)：代码允许 handlers 平级交接。
        lines.append(
            "本岗无直属下级，但有**同一上级下的平级同事**。"
            "本岗做完若流水线还有下一环（如验证/联调），**直接** ``state=completed`` + **handlers** 交给平级；"
            "**不要**只结案等上级再派——那会多醒上级一轮传令。"
        )
        lines.append("向上勿新建验收单；勿 handlers 指向上级。")
        lines.append("")
        lines.append("## 本轮 handlers 候选（平级 · 有下一环时优先）")
        for r in same_mgr_peers:
            lines.append(
                f"- `{r.agent_code}` · {r.role_name}（{r.department or '—'}）"
            )
        tip = str(same_mgr_peers[0].agent_code or "").strip()
        lines.append(
            f'示例：``handlers=[{{"agent_code":"{tip}","content":"按方案验收…；如何起服务/端口约定写清","read_outputs":["…"]}}]``'
        )
        lines.append(
            "本岗即最终环（无下一环）→ 对本岗 ``completed`` 即可，勿自造验收单、勿 handlers 指向自己。"
        )
    else:
        lines.append(
            "本岗无直属下级、也无同级平级：本岗做完对本岗 Task ``completed``；"
            "向上勿新建验收单。"
        )

    lines.extend(
        [
            "",
            "## 规则",
            "- **向下（直属下级）**：``state=completed`` + **handlers**（系统建单并叫醒）。空 handlers 会断链，系统拒绝。",
            "- **平级（同一上级）**：下一环优先 ``completed`` + **handlers**（与向下相同机制）；"
            "仅新开无关事项才 ``tasks create``（``start=true``）。已有未结单才 ``wake``，禁止自造重复单。",
            "- **向上**：叶子/平级结案即可；禁止给上级新建「验收」单；禁止指望上级代派本可平级交接的下一环。",
            "- **写权限**：只能 ``progress/state`` 自己的单（``assigned_to``=本岗）；小V 代用户除外。",
            "- **wake**：仅续跑/催办已有未结单；禁止刚 create 完立刻再 wake；禁止 handlers/create 指向自己。",
            "- **资源**：交付用的端口/进程写进 handlers content；结案后勿再 taskkill 他人已接管的服务。",
            COLLAB_CLOSE,
        ]
    )
    return "\n".join(lines)
