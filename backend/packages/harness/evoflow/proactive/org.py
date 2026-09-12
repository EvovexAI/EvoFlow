"""Organization boundaries and reporting lines for proactive employees.

Org membership (v1): same bound ``workspace_path``.
Reporting line: ``config.reports_to`` = manager's ``agent_code`` (user-editable).
``department`` remains display-only.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from evoflow.proactive.models import ProactiveRole


def workspace_org_key(workspace_path: str | None) -> str:
    """Normalize workspace path into a comparable org key (empty = unbound)."""
    raw = str(workspace_path or "").strip()
    if not raw:
        return ""
    try:
        resolved = Path(raw).expanduser().resolve()
        return str(resolved).replace("\\", "/").casefold()
    except Exception:
        return raw.replace("\\", "/").casefold()


def role_org_key(role: ProactiveRole) -> str:
    return workspace_org_key(getattr(getattr(role, "config", None), "workspace_path", None))


def filter_roster_same_org(
    self_role: ProactiveRole,
    roster: list[ProactiveRole],
) -> list[ProactiveRole]:
    """Keep active peers in the same org as ``self_role``.

    - Self always included when present in ``roster`` (or prepended).
    - Empty self workspace → return full roster (no org boundary).
    - Peers with empty workspace are excluded when self is bound.
    """
    self_code = str(self_role.agent_code or "").strip()
    self_key = role_org_key(self_role)
    if not self_key:
        return list(roster)

    peers = [r for r in roster if role_org_key(r) == self_key]
    codes = {str(r.agent_code or "").strip() for r in peers}
    if self_code and self_code not in codes:
        peers = [self_role, *peers]
    return peers


def reports_to_code(role: ProactiveRole) -> str:
    return str(getattr(getattr(role, "config", None), "reports_to", "") or "").strip()


def find_role(roster: list[ProactiveRole], agent_code: str) -> ProactiveRole | None:
    code = str(agent_code or "").strip()
    if not code:
        return None
    for r in roster:
        if str(r.agent_code or "").strip() == code:
            return r
    return None


def get_manager(
    role: ProactiveRole,
    roster: list[ProactiveRole],
) -> ProactiveRole | None:
    mgr_code = reports_to_code(role)
    if not mgr_code:
        return None
    return find_role(roster, mgr_code)


def list_direct_reports(
    role: ProactiveRole,
    roster: list[ProactiveRole],
) -> list[ProactiveRole]:
    self_code = str(role.agent_code or "").strip()
    if not self_code:
        return []
    out = [
        r
        for r in roster
        if reports_to_code(r) == self_code and str(r.agent_code or "").strip() != self_code
    ]
    out.sort(key=lambda r: (str(r.role_name or ""), str(r.agent_code or "")))
    return out


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


# Alias used by dispatch validation (runner) — same semantics, clearer name.
is_descendant_in_tree = is_descendant


def would_create_cycle(
    agent_code: str,
    new_reports_to: str,
    roster: list[ProactiveRole],
) -> bool:
    """True if setting ``agent_code.reports_to = new_reports_to`` forms a cycle."""
    self_code = str(agent_code or "").strip()
    target = str(new_reports_to or "").strip()
    if not self_code or not target:
        return False
    if self_code == target:
        return True
    by_code = {str(r.agent_code or "").strip(): r for r in roster if str(r.agent_code or "").strip()}
    seen: set[str] = {self_code}
    cur = target
    while cur:
        if cur in seen:
            return True
        seen.add(cur)
        peer = by_code.get(cur)
        if not peer:
            break
        cur = reports_to_code(peer)
    return False


def with_reporting_bridges(
    visible: list[ProactiveRole],
    full_roster: list[ProactiveRole],
) -> list[ProactiveRole]:
    """Keep inactive/paused ancestors so a filtered org tree does not flatten.

    When the UI loads ``status=active`` only, a paused manager would otherwise
    fall out of the roster and every direct report becomes a false root.
    Bridge nodes restore the reporting chain without changing stored
    ``reports_to`` values.
    """
    by_code = {
        str(r.agent_code or "").strip(): r
        for r in full_roster
        if str(r.agent_code or "").strip()
    }
    included: dict[str, ProactiveRole] = {
        str(r.agent_code or "").strip(): r
        for r in visible
        if str(r.agent_code or "").strip()
    }
    for role in list(included.values()):
        cur = reports_to_code(role)
        seen: set[str] = set()
        while cur and cur not in seen:
            seen.add(cur)
            peer = by_code.get(cur)
            if peer is None:
                break
            included[cur] = peer
            cur = reports_to_code(peer)
    return list(included.values())


def build_org_forest(
    roster: list[ProactiveRole],
    *,
    roots_only_in_roster: bool = True,
) -> list[dict[str, Any]]:
    """Build nested tree nodes for UI / API.

    Each node: ``{ agent_code, role_name, department, reports_to, status, children }``.
    Roots = roles whose ``reports_to`` is empty or points outside the roster.
    """
    roles = [r for r in roster if str(r.agent_code or "").strip()]
    codes = {str(r.agent_code or "").strip() for r in roles}
    children_map: dict[str, list[ProactiveRole]] = {c: [] for c in codes}
    roots: list[ProactiveRole] = []

    for r in roles:
        code = str(r.agent_code or "").strip()
        mgr = reports_to_code(r)
        if not mgr or (roots_only_in_roster and mgr not in codes):
            roots.append(r)
        elif mgr in children_map:
            children_map[mgr].append(r)
        else:
            roots.append(r)

    def _node(r: ProactiveRole) -> dict[str, Any]:
        code = str(r.agent_code or "").strip()
        kids = sorted(
            children_map.get(code) or [],
            key=lambda x: (str(x.role_name or ""), str(x.agent_code or "")),
        )
        return {
            "agent_code": code,
            "role_name": r.role_name,
            "department": r.department or "",
            "reports_to": reports_to_code(r),
            "status": r.status,
            "children": [_node(c) for c in kids],
        }

    roots.sort(key=lambda r: (str(r.role_name or ""), str(r.agent_code or "")))
    return [_node(r) for r in roots]


def org_chart_for_role(
    role: ProactiveRole,
    roster: list[ProactiveRole] | None = None,
) -> dict[str, Any]:
    """Snapshot used by system prompt + org API for one duty role."""
    raw = list(roster) if roster is not None else []
    peers = filter_roster_same_org(role, raw)
    manager = get_manager(role, peers)
    reports = list_direct_reports(role, peers)
    self_code = str(role.agent_code or "").strip()
    peers_flat = [
        {
            "agent_code": str(p.agent_code or "").strip(),
            "role_name": p.role_name,
            "department": p.department or "",
            "reports_to": reports_to_code(p),
            "is_self": str(p.agent_code or "").strip() == self_code,
        }
        for p in peers
    ]
    return {
        "org_key": role_org_key(role),
        "self": {
            "agent_code": self_code,
            "role_name": role.role_name,
            "department": role.department or "",
            "reports_to": reports_to_code(role),
        },
        "manager": (
            {
                "agent_code": str(manager.agent_code or "").strip(),
                "role_name": manager.role_name,
                "department": manager.department or "",
            }
            if manager
            else None
        ),
        "direct_reports": [
            {
                "agent_code": str(r.agent_code or "").strip(),
                "role_name": r.role_name,
                "department": r.department or "",
            }
            for r in reports
        ],
        "peers": peers_flat,
        "forest": build_org_forest(peers),
    }
