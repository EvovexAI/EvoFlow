"""Organization-aware validation for Task handler handoff (交工下游).

Rules:
- Same workspace org as the dispatcher (when dispatcher is bound).
- No self-assign.
- Employee dispatcher may only assign to **direct reports** (逐级派发) or same-manager peers.
- ``from_agent`` in {\"\", \"user\"} = human override: same-org only when ``org_anchor`` set.
- ``xiaomi`` (系统前台) = user steward: any active employee, no org/reporting gate.
"""

from __future__ import annotations

from evoflow.proactive.models import ProactiveRole
from evoflow.proactive.org import (
    filter_roster_same_org,
    find_role,
    list_direct_reports,
    reports_to_code,
    role_org_key,
)


def is_descendant(
    ancestor: ProactiveRole,
    candidate: ProactiveRole,
    roster: list[ProactiveRole],
) -> bool:
    """True if ``candidate`` is under ``ancestor`` in the reporting tree (not self)."""
    anc = str(ancestor.agent_code or "").strip()
    cur = str(candidate.agent_code or "").strip()
    if not anc or not cur or anc == cur:
        return False
    seen: set[str] = set()
    while cur and cur not in seen:
        seen.add(cur)
        peer = find_role(roster, cur)
        if peer is None:
            break
        mgr = reports_to_code(peer)
        if mgr == anc:
            return True
        cur = mgr
    return False


def first_hop_toward_descendant(
    manager: ProactiveRole,
    target: ProactiveRole,
    roster: list[ProactiveRole],
) -> ProactiveRole | None:
    """Direct report of ``manager`` that leads toward ``target`` (or is target)."""
    for report in list_direct_reports(manager, roster):
        code = str(report.agent_code or "").strip()
        tgt = str(target.agent_code or "").strip()
        if code == tgt or is_descendant(report, target, roster):
            return report
    return None


def validate_handler_assignee(
    *,
    from_agent: str,
    target_code: str,
    roster: list[ProactiveRole],
    org_anchor: str | None = None,
) -> str | None:
    """Return an error message if handoff is illegal; else None.

    - Human (``user`` / empty): optional ``org_anchor`` enforces same workspace org.
    - ``xiaomi`` (系统前台): same privilege as human without org_anchor — may assign any
      active employee (acts for the user; not bound by reporting line).
    - Employee: same org + target must be a direct report (or same-manager peer).
    """
    from_code = str(from_agent or "").strip()
    tgt_code = str(target_code or "").strip()
    if not tgt_code:
        return "缺少处理人 agent_code"

    try:
        from evoflow.agents.xiaomi.identity import is_xiaomi_agent
    except Exception:
        def is_xiaomi_agent(_name: str | None) -> bool:  # type: ignore[misc]
            return False

    if from_code and from_code.lower() != "user" and from_code == tgt_code:
        return "不能把下游指派给自己"
    if is_xiaomi_agent(from_code) and is_xiaomi_agent(tgt_code):
        return "不能把下游指派给自己"

    target = find_role(roster, tgt_code)
    if target is None:
        if from_code.lower() in {"", "user"} or is_xiaomi_agent(from_code):
            return None
        return f"处理人 `{tgt_code}` 不在岗位花名册中"

    if str(target.status or "").strip().lower() == "archived":
        return f"处理人 `{tgt_code}` 已归档，无法派发"

    def _same_org_or_err(anchor_code: str) -> str | None:
        anchor = find_role(roster, anchor_code)
        if anchor is None:
            return None
        a_key = role_org_key(anchor)
        t_key = role_org_key(target)
        if a_key and t_key and a_key != t_key:
            return (
                f"禁止跨组织直派：`{tgt_code}` 与 `{anchor_code}` 不在同一工作区组织。"
                "请先经共同上级或调整 workspace。"
            )
        if a_key and not t_key:
            return f"处理人 `{tgt_code}` 未绑定工作区，无法确认同组织"
        return None

    # Human + 小V（系统前台）：代表用户，可指派任意在岗员工。
    if from_code.lower() in {"", "user"} or is_xiaomi_agent(from_code):
        if from_code.lower() in {"", "user"}:
            anchor = str(org_anchor or "").strip()
            if anchor:
                return _same_org_or_err(anchor)
        return None

    dispatcher = find_role(roster, from_code)
    if dispatcher is None:
        return f"派发人 `{from_code}` 不在花名册，无法校验组织；请用用户确认或修正 raised_by/assignee"

    org_err = _same_org_or_err(from_code)
    if org_err:
        return org_err

    peers = filter_roster_same_org(dispatcher, roster) if role_org_key(dispatcher) else list(roster)
    peer_codes = {str(r.agent_code or "").strip() for r in peers}
    if tgt_code not in peer_codes:
        return f"禁止跨组织直派：`{tgt_code}` 不在 `{from_code}` 的同组织花名册内"

    reports = list_direct_reports(dispatcher, peers)
    report_codes = {str(r.agent_code or "").strip() for r in reports}
    if tgt_code in report_codes:
        return None

    dispatcher_mgr = reports_to_code(dispatcher)
    target_mgr = reports_to_code(target)

    # 平级协作白名单：同组织内、reports_to 指向同一上级的直属平级允许交接。
    # （平级协作是允许的，不要拦）
    if (
        dispatcher_mgr
        and dispatcher_mgr == target_mgr
        and dispatcher_mgr not in (tgt_code, from_code)
    ):
        return None

    # 下级不能派给上级（含更上层）。
    if dispatcher_mgr and dispatcher_mgr == tgt_code:
        return (
            f"下级不能派给上级：`{tgt_code}` 是 `{from_code}` 的直属上级。"
            "请由上级向本岗派活，或经平级协作通道（同一上级下的平级岗位）交接。"
        )

    if is_descendant(dispatcher, target, peers):
        hop = first_hop_toward_descendant(dispatcher, target, peers)
        if hop is not None:
            hop_code = str(hop.agent_code or "").strip()
            hop_name = str(hop.role_name or hop_code).strip()
            return (
                f"须逐级派发：不能跳过中间层直派 `{tgt_code}`。"
                f"请先派给直属下级 `{hop_name}`（`{hop_code}`），再由其向下交工。"
            )
        return f"须逐级派发：`{tgt_code}` 不在你的直属下级中"

    return (
        f"只能派给直属下级或同组织平级：`{tgt_code}` 不是 `{from_code}` 的直属下级，"
        "也不在同一上级下的平级岗位。跨岗请经共同上级逐级交工，或由用户在确认页改派。"
    )


def assert_handlers_org_ok(
    *,
    from_agent: str,
    handlers: list[dict],
    roster: list[ProactiveRole] | None = None,
    org_anchor: str | None = None,
) -> None:
    """Raise ``ValidationError`` if any handler fails org rules."""
    from evoflow.admin.errors import ValidationError

    if roster is None:
        from evoflow.proactive.repositories import ProactiveRepository

        roster = [
            r
            for r in ProactiveRepository.list_roles()
            if str(r.status or "").strip().lower() != "archived"
        ]

    errors: list[str] = []
    for h in handlers or []:
        if not isinstance(h, dict):
            continue
        code = str(h.get("agent_code") or "").strip()
        if not code:
            continue
        err = validate_handler_assignee(
            from_agent=from_agent,
            target_code=code,
            roster=roster,
            org_anchor=org_anchor,
        )
        if err:
            errors.append(err)
    if errors:
        raise ValidationError("handlers 组织校验失败：\n- " + "\n- ".join(errors))


__all__ = [
    "assert_handlers_org_ok",
    "first_hop_toward_descendant",
    "is_descendant",
    "validate_handler_assignee",
]
