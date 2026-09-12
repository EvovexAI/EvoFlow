"""Identity / ACL human-facing API (Phase 0/1)."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from evoflow.authz import admin_grants as admin_mod
from evoflow.authz import groups as groups_mod
from evoflow.authz import membership as membership_mod
from evoflow.authz import principal_avatars as principal_avatars_mod
from evoflow.authz import principals as principals_mod
from evoflow.authz.acl_store import grant as acl_grant
from evoflow.authz.acl_store import list_grants_for_ref, revoke as acl_revoke
from evoflow.authz.context import me_payload, resolve_request_authz
from evoflow.authz.scope import group_scope
from evoflow.authz.types import DEFAULT_ORG_ID, Permission

router = APIRouter(prefix="/api/identity", tags=["identity"])


def _require_admin(request: Request) -> Any:
    ctx = resolve_request_authz(request)
    if not ctx.get("is_org_admin"):
        raise HTTPException(status_code=403, detail="org_admin required")
    return ctx


def _require_self_or_admin(request: Request, principal_id: str) -> Any:
    ctx = resolve_request_authz(request)
    pid = str(principal_id or "").strip()
    me = str((ctx.get("principal") or {}).get("principal_id") or "").strip()
    if ctx.get("is_org_admin") or (me and me == pid):
        return ctx
    raise HTTPException(status_code=403, detail="forbidden")


@router.get("/me")
async def get_me(request: Request) -> dict[str, Any]:
    ctx = resolve_request_authz(request)
    payload = getattr(request.state, "webui_user", None)
    auth_source = "jwt" if isinstance(payload, dict) else "local"
    username = None
    if isinstance(payload, dict):
        username = str(payload.get("username") or "").strip() or None
    return me_payload(ctx, auth_source=auth_source, username=username)


@router.get("/principals")
async def get_principals(request: Request) -> dict[str, Any]:
    ctx = _require_admin(request)
    org_id = str(ctx.get("org_id") or DEFAULT_ORG_ID)
    items = []
    for p in principals_mod.list_principals(org_id=org_id, include_deactivated=True):
        items.append(principals_mod.principal_to_public(p, org_id=org_id))
    return {"orgId": org_id, "principals": items}


class CreatePrincipalBody(BaseModel):
    displayName: str = Field(..., min_length=1)
    username: str | None = None
    password: str | None = None
    primaryEmail: str | None = None
    promoteAdmin: bool = False


@router.get("/principals/{principal_id}")
async def get_principal_detail(request: Request, principal_id: str) -> dict[str, Any]:
    ctx = _require_admin(request)
    org_id = str(ctx.get("org_id") or DEFAULT_ORG_ID)
    p = principals_mod.get_principal(principal_id, org_id=org_id)
    if not p:
        raise HTTPException(status_code=404, detail="principal not found")
    return principals_mod.principal_to_public(p, org_id=org_id)


class UpdatePrincipalBody(BaseModel):
    displayName: str | None = None
    primaryEmail: str | None = None
    username: str | None = None


@router.patch("/principals/{principal_id}")
async def patch_principal(
    request: Request,
    principal_id: str,
    body: UpdatePrincipalBody,
) -> dict[str, Any]:
    ctx = _require_self_or_admin(request, principal_id)
    org_id = str(ctx.get("org_id") or DEFAULT_ORG_ID)
    is_admin = bool(ctx.get("is_org_admin"))
    me = str((ctx.get("principal") or {}).get("principal_id") or "").strip()
    fields_set = getattr(body, "model_fields_set", None) or body.__fields_set__  # pydantic v1/v2
    # Non-admins may only edit their own display name / email (not username).
    if not is_admin:
        if me != str(principal_id or "").strip():
            raise HTTPException(status_code=403, detail="forbidden")
        if "username" in fields_set:
            raise HTTPException(status_code=403, detail="username change requires org_admin")
    try:
        updated = principals_mod.update_principal(
            principal_id,
            display_name=body.displayName if "displayName" in fields_set else None,
            primary_email=body.primaryEmail if "primaryEmail" in fields_set else None,
            update_primary_email="primaryEmail" in fields_set,
            username=body.username if ("username" in fields_set and is_admin) else None,
            org_id=org_id,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e)) from e
    return principals_mod.principal_to_public(updated, org_id=org_id)


@router.get(
    "/principals/{principal_id}/avatar",
    summary="Get principal avatar image",
    responses={404: {"description": "No avatar file"}},
)
async def get_principal_avatar(principal_id: str):
    path = principal_avatars_mod.avatar_path_for(principal_id)
    if path is None:
        raise HTTPException(status_code=404, detail="avatar not found")
    rev = principal_avatars_mod.avatar_revision_for(principal_id)
    headers = {"Cache-Control": "public, max-age=3600"}
    if rev:
        headers["ETag"] = f'"{rev}"'
    return FileResponse(
        path,
        media_type=principal_avatars_mod.content_type_for(path),
        headers=headers,
    )


@router.post("/principals/{principal_id}/avatar", summary="Upload principal avatar")
async def upload_principal_avatar(
    request: Request,
    principal_id: str,
    file: UploadFile = File(...),
) -> dict[str, Any]:
    ctx = _require_self_or_admin(request, principal_id)
    org_id = str(ctx.get("org_id") or DEFAULT_ORG_ID)
    if not principals_mod.get_principal(principal_id, org_id=org_id):
        raise HTTPException(status_code=404, detail="principal not found")
    data = await file.read()
    try:
        principal_avatars_mod.save_avatar_bytes(principal_id, data)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    p = principals_mod.get_principal(principal_id, org_id=org_id)
    assert p is not None
    return principals_mod.principal_to_public(p, org_id=org_id)


@router.delete("/principals/{principal_id}/avatar", summary="Delete principal avatar")
async def delete_principal_avatar(request: Request, principal_id: str) -> dict[str, Any]:
    ctx = _require_self_or_admin(request, principal_id)
    org_id = str(ctx.get("org_id") or DEFAULT_ORG_ID)
    if not principals_mod.get_principal(principal_id, org_id=org_id):
        raise HTTPException(status_code=404, detail="principal not found")
    principal_avatars_mod.delete_avatar_file(principal_id)
    p = principals_mod.get_principal(principal_id, org_id=org_id)
    assert p is not None
    return principals_mod.principal_to_public(p, org_id=org_id)


class ResetPasswordBody(BaseModel):
    newPassword: str | None = None


@router.post("/principals/{principal_id}/reset-password")
async def post_reset_password(
    request: Request,
    principal_id: str,
    body: ResetPasswordBody | None = None,
) -> dict[str, Any]:
    ctx = _require_admin(request)
    org_id = str(ctx.get("org_id") or DEFAULT_ORG_ID)
    if not principals_mod.get_principal(principal_id, org_id=org_id):
        raise HTTPException(status_code=404, detail="principal not found")
    try:
        pw = principals_mod.reset_principal_password(
            principal_id,
            new_password=(body.newPassword if body else None),
            org_id=org_id,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e)) from e
    return {"principalId": principal_id, "newPassword": pw}


@router.post("/principals")
async def post_principal(request: Request, body: CreatePrincipalBody) -> dict[str, Any]:
    ctx = _require_admin(request)
    org_id = str(ctx.get("org_id") or DEFAULT_ORG_ID)
    actor = str((ctx.get("principal") or {}).get("principal_id") or "")
    try:
        created = principals_mod.create_principal(
            display_name=body.displayName,
            org_id=org_id,
            username=body.username,
            password=body.password,
            primary_email=body.primaryEmail,
        )
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    pid = str(created.get("principal_id") or "")
    if body.promoteAdmin:
        admin_mod.promote_org_admin(pid, granted_by=actor, org_id=org_id)
    initial_pw = None
    attrs = created.get("attrs") or {}
    if isinstance(attrs, dict):
        initial_pw = attrs.pop("_initial_password", None)
    return {
        "principalId": pid,
        "displayName": created.get("display_name") or "",
        "username": body.username,
        "initialPassword": initial_pw,
        "isOrgAdmin": admin_mod.is_org_admin(pid, org_id=org_id),
        "personalScopeId": principals_mod.personal_scope_for(created),
    }


class PrincipalStatusBody(BaseModel):
    status: str = Field(..., pattern="^(active|deactivated)$")


@router.post("/principals/{principal_id}/status")
async def post_principal_status(
    request: Request,
    principal_id: str,
    body: PrincipalStatusBody,
) -> dict[str, Any]:
    ctx = _require_admin(request)
    org_id = str(ctx.get("org_id") or DEFAULT_ORG_ID)
    if not principals_mod.set_principal_status(principal_id, body.status, org_id=org_id):
        raise HTTPException(status_code=404, detail="principal not found")
    return {"principalId": principal_id, "status": body.status}


@router.post("/principals/{principal_id}/promote-admin")
async def post_promote_admin(request: Request, principal_id: str) -> dict[str, Any]:
    ctx = _require_admin(request)
    org_id = str(ctx.get("org_id") or DEFAULT_ORG_ID)
    actor = str((ctx.get("principal") or {}).get("principal_id") or "")
    if not principals_mod.get_principal(principal_id, org_id=org_id):
        raise HTTPException(status_code=404, detail="principal not found")
    admin_mod.promote_org_admin(principal_id, granted_by=actor, org_id=org_id)
    return {"principalId": principal_id, "isOrgAdmin": True}


@router.delete("/principals/{principal_id}/admin")
async def delete_admin(request: Request, principal_id: str) -> dict[str, Any]:
    ctx = _require_admin(request)
    org_id = str(ctx.get("org_id") or DEFAULT_ORG_ID)
    actor = str((ctx.get("principal") or {}).get("principal_id") or "")
    try:
        admin_mod.revoke_org_admin(principal_id, org_id=org_id, actor_id=actor)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return {"principalId": principal_id, "isOrgAdmin": False}


class CreateGroupBody(BaseModel):
    name: str = Field(..., min_length=1)
    kind: str = "project"


@router.get("/groups")
async def get_groups(request: Request) -> dict[str, Any]:
    ctx = resolve_request_authz(request)
    org_id = str(ctx.get("org_id") or DEFAULT_ORG_ID)
    return {"orgId": org_id, "groups": groups_mod.list_groups(org_id=org_id)}


@router.post("/groups")
async def post_group(request: Request, body: CreateGroupBody) -> dict[str, Any]:
    ctx = resolve_request_authz(request)
    org_id = str(ctx.get("org_id") or DEFAULT_ORG_ID)
    actor = str((ctx.get("principal") or {}).get("principal_id") or "")
    if not actor:
        raise HTTPException(status_code=401, detail="principal required")
    g = groups_mod.create_group(name=body.name, created_by=actor, org_id=org_id, kind=body.kind)
    return {
        "groupId": g["group_id"],
        "scopeId": g["scope_id"],
        "name": g["name"],
        "kind": g["kind"],
        "createdBy": g["created_by"],
    }


class GroupMemberBody(BaseModel):
    principalId: str = Field(..., min_length=1)
    role: str = Field(default="member", pattern="^(member|manager)$")


@router.get("/groups/{group_id}/members")
async def get_group_members(request: Request, group_id: str) -> dict[str, Any]:
    ctx = resolve_request_authz(request)
    org_id = str(ctx.get("org_id") or DEFAULT_ORG_ID)
    scope = group_scope(group_id)
    if not membership_mod.can_read_scope(ctx["principal"], scope, org_id=org_id) and not ctx.get(
        "is_org_admin"
    ):
        raise HTTPException(status_code=403, detail="not a member")
    return {"groupId": group_id, "scopeId": scope, "members": membership_mod.list_scope_members(scope, org_id=org_id)}


@router.put("/groups/{group_id}/members")
async def put_group_member(request: Request, group_id: str, body: GroupMemberBody) -> dict[str, Any]:
    ctx = resolve_request_authz(request)
    org_id = str(ctx.get("org_id") or DEFAULT_ORG_ID)
    scope = group_scope(group_id)
    if not membership_mod.can_manage_scope(ctx["principal"], scope, org_id=org_id) and not ctx.get(
        "is_org_admin"
    ):
        raise HTTPException(status_code=403, detail="manager required")
    if not principals_mod.get_principal(body.principalId, org_id=org_id):
        raise HTTPException(status_code=404, detail="principal not found")
    membership_mod.add_scope_member(
        scope,
        body.principalId,
        role=body.role,  # type: ignore[arg-type]
        org_id=org_id,
    )
    return {"groupId": group_id, "principalId": body.principalId, "role": body.role}


@router.delete("/groups/{group_id}/members/{principal_id}")
async def delete_group_member(request: Request, group_id: str, principal_id: str) -> dict[str, Any]:
    ctx = resolve_request_authz(request)
    org_id = str(ctx.get("org_id") or DEFAULT_ORG_ID)
    scope = group_scope(group_id)
    if not membership_mod.can_manage_scope(ctx["principal"], scope, org_id=org_id) and not ctx.get(
        "is_org_admin"
    ):
        raise HTTPException(status_code=403, detail="manager required")
    membership_mod.remove_scope_member(scope, principal_id, org_id=org_id)
    return {"groupId": group_id, "principalId": principal_id, "removed": True}


class GrantBody(BaseModel):
    ownerScopeId: str
    ref: str
    granteeScopeId: str
    permission: Permission = "read"


@router.post("/acl/grants")
async def post_grant(request: Request, body: GrantBody) -> dict[str, Any]:
    ctx = resolve_request_authz(request)
    org_id = str(ctx.get("org_id") or DEFAULT_ORG_ID)
    actor = str((ctx.get("principal") or {}).get("principal_id") or "")
    if not membership_mod.can_manage_scope(ctx["principal"], body.ownerScopeId, org_id=org_id) and not ctx.get(
        "is_org_admin"
    ):
        raise HTTPException(status_code=403, detail="cannot manage owner scope")
    acl_grant(
        owner_scope_id=body.ownerScopeId,
        ref=body.ref,
        grantee_scope_id=body.granteeScopeId,
        permission=body.permission,
        granted_by=actor,
        org_id=org_id,
    )
    return {
        "ownerScopeId": body.ownerScopeId,
        "ref": body.ref,
        "granteeScopeId": body.granteeScopeId,
        "permission": body.permission,
    }


@router.delete("/acl/grants")
async def delete_grant(request: Request, body: GrantBody) -> dict[str, Any]:
    ctx = resolve_request_authz(request)
    org_id = str(ctx.get("org_id") or DEFAULT_ORG_ID)
    if not membership_mod.can_manage_scope(ctx["principal"], body.ownerScopeId, org_id=org_id) and not ctx.get(
        "is_org_admin"
    ):
        raise HTTPException(status_code=403, detail="cannot manage owner scope")
    acl_revoke(
        owner_scope_id=body.ownerScopeId,
        ref=body.ref,
        grantee_scope_id=body.granteeScopeId,
        permission=body.permission,
        org_id=org_id,
    )
    return {"revoked": True}


@router.get("/acl/grants")
async def get_grants(
    request: Request,
    ownerScopeId: str,
    ref: str,
) -> dict[str, Any]:
    ctx = resolve_request_authz(request)
    org_id = str(ctx.get("org_id") or DEFAULT_ORG_ID)
    grants = list_grants_for_ref(ownerScopeId, ref, org_id=org_id)
    return {
        "ownerScopeId": ownerScopeId,
        "ref": ref,
        "grants": [
            {
                "granteeScopeId": g["grantee_scope_id"],
                "permission": g["permission"],
                "grantedBy": g["granted_by"],
                "createdAt": g["created_at"],
            }
            for g in grants
        ],
    }
