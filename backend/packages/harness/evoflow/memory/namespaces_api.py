"""List visible memory namespaces for the memory hub UI."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from evoflow.agents.memory.workspace_memory import workspace_scope_id
from evoflow.knowledge.owned.db import db
from evoflow.memory.document_codec import namespace_for_agent_key
from evoflow.memory.namespaces import person_ns, workspace_ns
from evoflow.memory import store as mem_store


def _atom_count(namespace_id: str) -> int:
    try:
        return mem_store.count_active_atoms(namespace_id)
    except Exception:
        return 0


def _ns_rows() -> list[dict[str, Any]]:
    try:
        with db() as conn:
            cols = {str(r[1]) for r in conn.execute("PRAGMA table_info(mem_namespaces)").fetchall()}
            if "owner_scope_id" in cols:
                rows = conn.execute(
                    """
                    SELECT id, kind, owner_ref, title, updated_at, owner_scope_id, org_id, created_by
                    FROM mem_namespaces
                    ORDER BY kind ASC, updated_at DESC
                    """
                ).fetchall()
            else:
                rows = conn.execute(
                    """
                    SELECT id, kind, owner_ref, title, updated_at
                    FROM mem_namespaces
                    ORDER BY kind ASC, updated_at DESC
                    """
                ).fetchall()
        return [dict(r) for r in rows]
    except Exception:
        return []


def _visibility_ctx(request: object | None) -> dict[str, Any] | None:
    if request is None:
        return None
    try:
        from evoflow.authz.context import resolve_request_authz
        from evoflow.authz.scope import org_scope, personal_scope

        ctx = resolve_request_authz(request)  # type: ignore[arg-type]
        p = ctx.get("principal") or {}
        pid = str(p.get("principal_id") or "")
        return {
            "principal": p,
            "principal_id": pid,
            "is_admin": bool(ctx.get("is_org_admin")),
            "personal_scope": personal_scope(pid) if pid else None,
            "org_scope": org_scope(str(ctx.get("org_id") or "local")),
        }
    except Exception:
        return None


def _ns_owner_visible(owner_scope_id: str | None, vctx: dict[str, Any] | None) -> bool:
    if vctx is None:
        return True
    from evoflow.authz.resource_visibility import owner_scope_visible_to_principal

    return owner_scope_visible_to_principal(
        owner_scope_id,
        vctx.get("principal"),
        is_admin=bool(vctx.get("is_admin")),
        personal_scope=vctx.get("personal_scope"),
        org_scope=vctx.get("org_scope"),
    )


def _agent_visible(agent_code: str | None, vctx: dict[str, Any] | None) -> bool:
    if vctx is None:
        return True
    if not agent_code:
        return True  # global / default namespace
    try:
        from evoflow.persistence.config_repositories import agent_visible_to_principal

        return agent_visible_to_principal(
            agent_code,
            str(vctx.get("principal_id") or ""),
            is_admin=bool(vctx.get("is_admin")),
            personal_scope=vctx.get("personal_scope"),
            org_scope=vctx.get("org_scope"),
        )
    except Exception:
        return True


def list_memory_namespaces(request: object | None = None) -> dict[str, Any]:
    """Assemble hub scopes: agent / workspace / person (filtered by ownership)."""
    existing = {str(r.get("id") or ""): r for r in _ns_rows()}
    vctx = _visibility_ctx(request)

    agents: list[dict[str, Any]] = []
    # Global / default
    global_ns = namespace_for_agent_key(None)
    agents.append(
        {
            "kind": "agent",
            "id": None,
            "namespace": global_ns,
            "label": "全局",
            "description": "未指定自定义助手时的默认用户记忆",
            "atom_count": _atom_count(global_ns),
            "href": None,
        }
    )
    try:
        from evoflow.admin import agents as agents_admin

        listed = agents_admin.list_agents() or {}
        for row in listed.get("agents") or []:
            if not isinstance(row, dict):
                continue
            code = str(row.get("agent_code") or "").strip()
            if not code:
                continue
            if not _agent_visible(code, vctx):
                continue
            ns = namespace_for_agent_key(code)
            # Prefer stamped namespace ownership when present
            ns_row = existing.get(ns) or {}
            if ns_row.get("owner_scope_id") and not _ns_owner_visible(
                str(ns_row.get("owner_scope_id") or ""), vctx
            ):
                continue
            agents.append(
                {
                    "kind": "agent",
                    "id": code,
                    "namespace": ns,
                    "label": str(row.get("agent_name") or code).strip() or code,
                    "description": str(row.get("description") or "")[:240],
                    "atom_count": _atom_count(ns),
                    "href": None,
                }
            )
    except Exception:
        # Ensure main exists
        if not any(a.get("id") == "main" for a in agents) and _agent_visible("main", vctx):
            ns = namespace_for_agent_key("main")
            agents.append(
                {
                    "kind": "agent",
                    "id": "main",
                    "namespace": ns,
                    "label": "主智能体",
                    "description": "",
                    "atom_count": _atom_count(ns),
                    "href": None,
                }
            )

    workspaces: list[dict[str, Any]] = []
    seen_ws: set[str] = set()
    try:
        from evoflow.persistence.workspace_repositories import list_global_workspace_paths

        paths = list_global_workspace_paths(limit=40)
    except Exception:
        paths = []
    for path in paths:
        p = str(path or "").strip()
        if not p:
            continue
        try:
            scope = workspace_scope_id(p)
            ns = workspace_ns(scope)
        except Exception:
            continue
        if ns in seen_ws:
            continue
        ns_row = existing.get(ns) or {}
        if ns_row.get("owner_scope_id") and not _ns_owner_visible(
            str(ns_row.get("owner_scope_id") or ""), vctx
        ):
            continue
        seen_ws.add(ns)
        workspaces.append(
            {
                "kind": "workspace",
                "id": scope,
                "namespace": ns,
                "path": p,
                "label": Path(p).name or p,
                "description": p,
                "atom_count": _atom_count(ns),
                "href": None,
            }
        )
    # Also surface workspace ns already in DB but not in history
    for nid, row in existing.items():
        if str(row.get("kind") or "") != "workspace":
            continue
        if nid in seen_ws:
            continue
        if row.get("owner_scope_id") and not _ns_owner_visible(
            str(row.get("owner_scope_id") or ""), vctx
        ):
            continue
        owner = str(row.get("owner_ref") or "")
        workspaces.append(
            {
                "kind": "workspace",
                "id": owner,
                "namespace": nid,
                "path": "",
                "label": str(row.get("title") or owner or nid),
                "description": "已有记忆的工作区命名空间",
                "atom_count": _atom_count(nid),
                "href": None,
            }
        )

    persons: list[dict[str, Any]] = []
    seen_person: set[str] = set()
    try:
        from evoflow.proactive.repositories import ProactiveRepository

        roles = ProactiveRepository.list_roles() or []
        for role in roles:
            code = str(getattr(role, "agent_code", None) or "").strip()
            if not code:
                continue
            if not _agent_visible(code, vctx):
                continue
            ns = person_ns(code)
            seen_person.add(ns)
            persons.append(
                {
                    "kind": "person",
                    "id": code,
                    "namespace": ns,
                    "label": str(getattr(role, "role_name", None) or code).strip() or code,
                    "description": "员工自传 / 本事（成长页为主）",
                    "atom_count": _atom_count(ns),
                    "href": f"#/proactive/{code}",
                }
            )
    except Exception:
        roles = []
    for nid, row in existing.items():
        if str(row.get("kind") or "") != "person":
            continue
        if nid in seen_person:
            continue
        if row.get("owner_scope_id") and not _ns_owner_visible(
            str(row.get("owner_scope_id") or ""), vctx
        ):
            continue
        owner = str(row.get("owner_ref") or "")
        if owner and not _agent_visible(owner, vctx):
            continue
        persons.append(
            {
                "kind": "person",
                "id": owner,
                "namespace": nid,
                "label": str(row.get("title") or owner or nid),
                "description": "员工记忆命名空间",
                "atom_count": _atom_count(nid),
                "href": f"#/proactive/{owner}" if owner else None,
            }
        )

    return {
        "agents": agents,
        "workspaces": workspaces,
        "persons": persons,
        "hints": {
            "agent": "关于用户 / 该助手槽的记忆；对话默认注入这里",
            "workspace": "仅本工作区生效的项目约定；聊天侧栏也可编辑",
            "person": "员工自己的人生（日记/本事）；完整视图在成长 Tab",
        },
    }


def namespace_visible_to_request(request: object | None, namespace_id: str) -> bool:
    """True if the caller may read/write atoms in ``namespace_id``."""
    ns = str(namespace_id or "").strip()
    if not ns:
        return False
    vctx = _visibility_ctx(request)
    if vctx is None:
        return True
    if bool(vctx.get("is_admin")):
        return True
    if not str(vctx.get("principal_id") or "").strip():
        return True

    # Prefer stamped mem_namespaces ownership
    for row in _ns_rows():
        if str(row.get("id") or "") != ns:
            continue
        owner = row.get("owner_scope_id")
        if owner:
            return _ns_owner_visible(str(owner), vctx)
        kind = str(row.get("kind") or "")
        owner_ref = str(row.get("owner_ref") or "").strip()
        if kind in {"agent", "person"} and owner_ref:
            return _agent_visible(owner_ref, vctx)
        break

    # Infer from namespace shape when not yet stamped
    if ns.startswith("agent:"):
        code = ns.split(":", 1)[1].strip()
        if not code or code in {"main", "default", "global"}:
            return True
        return _agent_visible(code, vctx)
    if ns.startswith("person:"):
        code = ns.split(":", 1)[1].strip()
        return _agent_visible(code, vctx) if code else False
    # workspace / other: require stamped owner when principal present
    for row in _ns_rows():
        if str(row.get("id") or "") == ns:
            return _ns_owner_visible(str(row.get("owner_scope_id") or ""), vctx)
    # Unstamped workspace ns: fail closed for authenticated non-admin
    if ns.startswith("workspace:"):
        return False
    return True
