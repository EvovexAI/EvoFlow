"""HTTP request guards for resource visibility (anti-IDOR)."""

from __future__ import annotations

from typing import Any

from fastapi import HTTPException, Request


def resolve_authz_from_request(request: Request | None) -> dict[str, Any]:
    """Return principal + admin/scopes for the current request (best-effort)."""
    try:
        from evoflow.authz.context import resolve_request_authz
        from evoflow.authz.scope import org_scope, personal_scope

        ctx = resolve_request_authz(request)  # type: ignore[arg-type]
        p = ctx.get("principal") or {}
        pid = str(p.get("principal_id") or "").strip()
        is_admin = bool(ctx.get("is_org_admin"))
        return {
            "principal": p,
            "principal_id": pid,
            "is_admin": is_admin,
            "personal_scope": personal_scope(pid) if pid else None,
            "org_scope": org_scope(str(ctx.get("org_id") or "local")),
            "org_id": str(ctx.get("org_id") or "local"),
        }
    except Exception:
        return {
            "principal": {},
            "principal_id": "",
            "is_admin": False,
            "personal_scope": None,
            "org_scope": None,
            "org_id": "local",
        }


def require_thread_visible(request: Request | None, thread_id: str) -> None:
    """404 if the LangGraph thread's bound session is not visible to the caller."""
    from evoflow.persistence import session_repositories as sess_repo

    tid = str(thread_id or "").strip()
    if not tid:
        raise HTTPException(status_code=400, detail="thread_id required")
    authz = resolve_authz_from_request(request)
    if authz.get("is_admin"):
        return
    if not str(authz.get("principal_id") or "").strip():
        return
    # Collab subtask threads bind to the lead session via the root lead thread id.
    try:
        from evoflow.collab.thread_ids import (
            is_collab_executor_thread,
            lead_thread_from_executor_thread,
        )

        if is_collab_executor_thread(tid):
            lead = lead_thread_from_executor_thread(tid)
            if lead:
                tid = lead
    except Exception:
        pass
    sk = sess_repo.find_session_key_by_thread_id(tid)
    if not sk:
        # No bound session — fail closed for authenticated non-admin.
        raise HTTPException(status_code=404, detail="thread not found")
    require_session_visible(request, sk)


def require_org_admin(request: Request | None) -> None:
    """403 unless caller is org admin (local bootstrap admin counts)."""
    authz = resolve_authz_from_request(request)
    if authz.get("is_admin"):
        return
    # Unauthenticated local gateway: treat as admin for single-user installs.
    if not str(authz.get("principal_id") or "").strip():
        return
    raise HTTPException(status_code=403, detail="org_admin required")


def require_item_visible(request: Request | None, item_id: str) -> None:
    from evoflow.items import service as items_svc

    iid = str(item_id or "").strip()
    if not iid:
        raise HTTPException(status_code=404, detail="item not found")
    authz = resolve_authz_from_request(request)
    if authz.get("is_admin"):
        return
    if not str(authz.get("principal_id") or "").strip():
        return
    if not items_svc.item_visible_to_principal(
        iid,
        is_admin=False,
        personal_scope=authz.get("personal_scope"),
        org_scope=authz.get("org_scope"),
        principal=authz.get("principal"),
    ):
        raise HTTPException(status_code=404, detail="item not found")


def require_vault_visible(request: Request | None, vault_id: str) -> None:
    from evoflow.knowledge.vault import store as vault_store
    from evoflow.knowledge.vault.builtin import is_builtin_vault_id
    from evoflow.authz.resource_visibility import owner_scope_visible_to_principal

    vid = str(vault_id or "").strip()
    if not vid:
        raise HTTPException(status_code=404, detail="vault not found")
    if is_builtin_vault_id(vid):
        return
    cfg = vault_store.get_vault_config(vid)
    if cfg is None:
        raise HTTPException(status_code=404, detail="vault not found")
    if bool(getattr(cfg, "builtin", False)):
        return
    authz = resolve_authz_from_request(request)
    if authz.get("is_admin"):
        return
    if not str(authz.get("principal_id") or "").strip():
        return
    owner = getattr(cfg, "owner_scope_id", None) or None
    if not owner_scope_visible_to_principal(
        owner,
        authz.get("principal"),
        is_admin=False,
        personal_scope=authz.get("personal_scope"),
        org_scope=authz.get("org_scope"),
    ):
        raise HTTPException(status_code=404, detail="vault not found")


def require_memory_namespace_visible(request: Request | None, namespace_id: str) -> None:
    """404 if the memory namespace is not visible to the caller."""
    from evoflow.memory.namespaces_api import namespace_visible_to_request

    ns = str(namespace_id or "").strip()
    if not ns:
        raise HTTPException(status_code=400, detail="namespace required")
    if not namespace_visible_to_request(request, ns):
        raise HTTPException(status_code=404, detail="namespace not found")


def require_app_visible(request: Request | None, app_id: str) -> None:
    from evoflow.persistence import app_repositories

    aid = str(app_id or "").strip()
    if not aid:
        raise HTTPException(status_code=404, detail="Application not found")
    if app_repositories.load_app(aid) is None:
        raise HTTPException(status_code=404, detail=f"Application not found: {aid}")
    authz = resolve_authz_from_request(request)
    if authz.get("is_admin"):
        return
    if not app_repositories.app_visible_to_principal(
        aid,
        str(authz.get("principal_id") or ""),
        is_admin=False,
        personal_scope=authz.get("personal_scope"),
        org_scope=authz.get("org_scope"),
        principal=authz.get("principal"),
    ):
        raise HTTPException(status_code=404, detail=f"Application not found: {aid}")


def require_agent_visible(request: Request | None, agent_code: str) -> None:
    from evoflow.persistence import config_repositories as cfg_repo

    code = str(agent_code or "").strip().lower()
    if not code or code == "main":
        return  # install-shared / default
    authz = resolve_authz_from_request(request)
    if authz.get("is_admin"):
        return
    if not cfg_repo.agent_visible_to_principal(
        code,
        str(authz.get("principal_id") or ""),
        is_admin=False,
        personal_scope=authz.get("personal_scope"),
        org_scope=authz.get("org_scope"),
    ):
        raise HTTPException(status_code=404, detail=f"Agent '{code}' not found")


def require_session_visible(request: Request | None, session_key: str) -> None:
    from evoflow.authz.session_ownership import session_visible_to_principal
    from evoflow.persistence.db import get_db

    sk = str(session_key or "").strip()
    if not sk:
        raise HTTPException(status_code=422, detail="session_key required")
    authz = resolve_authz_from_request(request)
    if authz.get("is_admin"):
        return
    principal = authz.get("principal") or {}
    if not str(principal.get("principal_id") or "").strip():
        # No principal resolved (odd) — allow local/legacy rather than lock out
        return
    cols = {str(r[1]) for r in get_db().execute("PRAGMA table_info(evoflow_chat_sessions)").fetchall()}
    if "created_by" not in cols:
        return
    fields = ["created_by"]
    if "scope_id" in cols:
        fields.append("scope_id")
    row = get_db().execute(
        f"SELECT {', '.join(fields)} FROM evoflow_chat_sessions "
        "WHERE session_key = ? AND COALESCE(is_deleted, 0) = 0",
        (sk,),
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="session not found")
    data = dict(zip(fields, row, strict=False))
    if not session_visible_to_principal(data, principal, is_admin=False):  # type: ignore[arg-type]
        raise HTTPException(status_code=404, detail="session not found")


def require_automation_visible(request: Request | None, task_id: str) -> None:
    from evoflow.persistence import automation_repositories as auto_repo

    tid = str(task_id or "").strip()
    if not tid:
        raise HTTPException(status_code=404, detail="Automation not found")
    authz = resolve_authz_from_request(request)
    if authz.get("is_admin"):
        return
    if not auto_repo.automation_visible_to_principal(
        tid,
        is_admin=False,
        personal_scope=authz.get("personal_scope"),
        org_scope=authz.get("org_scope"),
        principal=authz.get("principal"),
    ):
        raise HTTPException(status_code=404, detail=f"Automation '{tid}' not found")


def require_task_visible(request: Request | None, task_id: str) -> None:
    from evoflow.persistence import task_repositories as task_repo

    tid = str(task_id or "").strip()
    if not tid:
        raise HTTPException(status_code=404, detail="Task not found")
    authz = resolve_authz_from_request(request)
    if authz.get("is_admin"):
        return
    if not task_repo.task_visible_to_principal(
        tid,
        is_admin=False,
        personal_scope=authz.get("personal_scope"),
        org_scope=authz.get("org_scope"),
        principal=authz.get("principal"),
    ):
        raise HTTPException(status_code=404, detail="Task not found")


def require_kb_visible(request: Request | None, kb_id: str) -> None:
    from evoflow.knowledge.owned import service as owned_service

    kid = str(kb_id or "").strip()
    if not kid:
        raise HTTPException(status_code=404, detail="knowledge base not found")
    authz = resolve_authz_from_request(request)
    if authz.get("is_admin"):
        return
    if not owned_service.kb_visible_to_principal(
        kid,
        is_admin=False,
        personal_scope=authz.get("personal_scope"),
        org_scope=authz.get("org_scope"),
        principal=authz.get("principal"),
    ):
        raise HTTPException(status_code=404, detail="knowledge base not found")


def require_owned_doc_visible(request: Request | None, doc_id: str) -> None:
    from evoflow.knowledge.owned import service as owned_service

    did = str(doc_id or "").strip()
    if not did:
        raise HTTPException(status_code=404, detail="document not found")
    doc = owned_service.get_document(did)
    if not doc:
        raise HTTPException(status_code=404, detail="document not found")
    kid = str(doc.get("kbId") or doc.get("kb_id") or "").strip()
    require_kb_visible(request, kid)


def require_owned_job_visible(request: Request | None, job_id: str) -> None:
    from evoflow.knowledge.owned import service as owned_service

    jid = str(job_id or "").strip()
    if not jid:
        raise HTTPException(status_code=404, detail="job not found")
    job = owned_service.get_job(jid)
    if not job:
        raise HTTPException(status_code=404, detail="job not found")
    kid = str(job.get("kbId") or job.get("kb_id") or "").strip()
    if kid:
        require_kb_visible(request, kid)


def require_workspace_path_visible(request: Request | None, path: str) -> None:
    """404 if the host workspace path is not visible to the caller."""
    from evoflow.authz.workspace_visibility import workspace_path_visible_to_principal

    p = str(path or "").strip()
    if not p:
        raise HTTPException(status_code=422, detail="workspace path required")
    authz = resolve_authz_from_request(request)
    if authz.get("is_admin"):
        return
    if not str(authz.get("principal_id") or "").strip():
        return  # local/legacy unauthenticated
    if not workspace_path_visible_to_principal(
        p,
        authz.get("principal"),
        is_admin=False,
        personal_scope_id=authz.get("personal_scope"),
        org_scope_id=authz.get("org_scope"),
    ):
        raise HTTPException(status_code=404, detail="workspace not found")


def require_workspace_root_access(
    request: Request | None,
    *,
    root: str | None = None,
    thread_id: str | None = None,
) -> None:
    """Guard browse/read/write: bound root must be visible; thread sandbox via session."""
    root_s = str(root or "").strip()
    tid = str(thread_id or "").strip()
    if root_s:
        require_workspace_path_visible(request, root_s)
        return
    if tid:
        # Thread sandbox is per-thread FS under install; gate via owning session when possible.
        try:
            from evoflow.persistence import session_repositories as sess_repo

            sk = sess_repo.find_session_key_by_thread_id(tid)
            if sk:
                require_session_visible(request, sk)
        except Exception:
            pass


def workspace_path_for_asset_entity_id(entity_id: str) -> str | None:
    """Reverse ``ws-{hash}`` → registered workspace_path when possible."""
    from evoflow.assets.paths import workspace_entity_ref
    from evoflow.persistence.db import get_db

    eid = str(entity_id or "").strip().lower()
    if not eid.startswith("ws-"):
        return None
    try:
        rows = get_db().execute("SELECT workspace_path FROM evoflow_workspaces").fetchall()
    except Exception:
        return None
    for row in rows:
        wp = str(row[0] or "").strip()
        if not wp:
            continue
        try:
            if workspace_entity_ref(wp).entity_id == eid:
                return wp
        except ValueError:
            continue
    return None


def resolve_asset_entity_for_request(
    request: Request | None,
    entity_type: str,
    entity_id: str,
):
    """Resolve EntityRef for Asset Hub and enforce visibility (anti-IDOR).

    ``user`` entities: authenticated non-admins always use their personal bucket
    under ``assets/users/<id>/`` (legacy shared ``assets/user`` only for
    unauthenticated local / explicit admin legacy access).
    """
    from evoflow.assets.paths import EntityRef, sanitize_user_asset_id

    et = str(entity_type or "").strip().lower()
    eid = str(entity_id or "").strip()
    if et not in ("user", "agent", "employee", "workspace"):
        raise HTTPException(status_code=400, detail=f"invalid entity_type: {et!r}")

    authz = resolve_authz_from_request(request)
    pid = str(authz.get("principal_id") or "").strip()
    is_admin = bool(authz.get("is_admin"))

    if et == "user":
        if not pid:
            # Local/legacy unauthenticated → shared bucket.
            return EntityRef("user", "user").normalized()
        mine = sanitize_user_asset_id(pid)
        alias = (not eid) or eid.lower() in ("user", "me", "self")
        if is_admin:
            if alias:
                return EntityRef("user", mine).normalized()
            return EntityRef("user", sanitize_user_asset_id(eid)).normalized()
        requested = mine if alias else sanitize_user_asset_id(eid)
        if requested != mine:
            raise HTTPException(status_code=404, detail="entity not found")
        return EntityRef("user", mine).normalized()

    if et in ("agent", "employee"):
        if not eid:
            raise HTTPException(status_code=400, detail="entity_id required")
        require_agent_visible(request, eid)
        return EntityRef(et, eid).normalized()  # type: ignore[arg-type]

    # workspace
    if not eid:
        raise HTTPException(status_code=400, detail="entity_id required")
    wp = workspace_path_for_asset_entity_id(eid)
    if wp:
        require_workspace_path_visible(request, wp)
    elif pid and not is_admin:
        # Orphan workspace dir with no registry row — fail closed for non-admin.
        raise HTTPException(status_code=404, detail="entity not found")
    return EntityRef("workspace", eid).normalized()


def require_asset_entity_visible(
    request: Request | None,
    entity_type: str,
    entity_id: str,
) -> None:
    """404 if the Asset Hub entity is not visible to the caller."""
    resolve_asset_entity_for_request(request, entity_type, entity_id)


def filter_asset_entities_for_request(
    request: Request | None,
    entities: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Filter Asset Hub entity list and rewrite ``user`` to the caller's bucket."""
    from evoflow.assets.paths import EntityRef, entity_relative_dir, sanitize_user_asset_id

    authz = resolve_authz_from_request(request)
    pid = str(authz.get("principal_id") or "").strip()
    is_admin = bool(authz.get("is_admin"))
    out: list[dict[str, Any]] = []
    saw_user = False
    for raw in entities:
        if not isinstance(raw, dict):
            continue
        et = str(raw.get("entityType") or "").strip().lower()
        eid = str(raw.get("entityId") or "").strip()
        if et == "user":
            if saw_user:
                continue
            saw_user = True
            if pid:
                mine = sanitize_user_asset_id(pid)
                row = dict(raw)
                row["entityId"] = mine
                row["root"] = entity_relative_dir(EntityRef("user", mine))
                row["label"] = row.get("label") or "我"
                out.append(row)
            elif is_admin or not pid:
                out.append(dict(raw))
            continue
        try:
            require_asset_entity_visible(request, et, eid)
        except HTTPException:
            continue
        out.append(dict(raw))
    if pid and not saw_user:
        mine = sanitize_user_asset_id(pid)
        out.insert(
            0,
            {
                "entityType": "user",
                "entityId": mine,
                "label": "我",
                "root": entity_relative_dir(EntityRef("user", mine)),
            },
        )
    return out
