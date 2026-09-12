"""Resolve AuthzContext from HTTP / local requests."""

from __future__ import annotations

import logging
from typing import Any

from starlette.requests import Request

from evoflow.authz import admin_grants as admin_mod
from evoflow.authz import principals as principals_mod
from evoflow.authz.scope import org_scope, personal_scope
from evoflow.authz.types import AuthzContext, DEFAULT_ORG_ID, Principal

logger = logging.getLogger(__name__)


def build_authz_context(
    principal: Principal,
    *,
    session_key: str | None = None,
    scope_id: str | None = None,
    audience: list[Principal] | None = None,
) -> AuthzContext:
    oid = str(principal.get("org_id") or DEFAULT_ORG_ID)
    pid = str(principal.get("principal_id") or "")
    sid = scope_id or personal_scope(pid)
    aud = list(audience) if audience is not None else [principal]
    return AuthzContext(
        org_id=oid,
        principal=principal,
        session_key=session_key,
        scope_id=sid,
        audience=aud,
        is_org_admin=admin_mod.is_org_admin(pid, org_id=oid),
    )


def resolve_principal_from_webui_payload(payload: dict[str, Any] | None) -> Principal | None:
    if not payload:
        return None
    auth_method = str(payload.get("auth_method") or "").strip()
    pid_hint = str(payload.get("principal_id") or payload.get("user_id") or "").strip()
    sub = str(payload.get("sub") or "").strip()
    username = str(payload.get("username") or "").strip()
    webui_uid = payload.get("webui_user_id")

    if pid_hint:
        p = principals_mod.get_principal(pid_hint)
        if p:
            return p

    if auth_method == "oidc" and sub:
        p = principals_mod.get_principal(sub)
        if p:
            return p
        p = principals_mod.resolve_principal_by_identity("oidc", sub)
        if p:
            return p

    if sub:
        p = principals_mod.resolve_principal_by_identity("webui", sub)
        if p:
            return p
        p = principals_mod.get_principal(f"webui:{sub}")
        if p:
            return p
        p = principals_mod.get_principal(sub)
        if p:
            return p
    if webui_uid is not None and str(webui_uid).strip():
        uid = str(webui_uid).strip()
        p = principals_mod.resolve_principal_by_identity("webui", uid)
        if p:
            return p
        p = principals_mod.get_principal(f"webui:{uid}")
        if p:
            return p
    if username:
        p = principals_mod.resolve_principal_by_identity("webui_username", username)
        if p:
            return p
    return None


def ensure_principal_from_webui_payload(payload: dict[str, Any]) -> Principal | None:
    """Best-effort create/link principal when JWT is present but lookup missed."""
    username = str(payload.get("username") or "").strip()
    webui_uid = payload.get("webui_user_id")
    if webui_uid is None or not username:
        return None
    try:
        return principals_mod.ensure_webui_principal(
            webui_user_id=webui_uid,
            username=username,
            is_primary=False,
        )
    except Exception:
        logger.debug("ensure_principal_from_webui_payload failed", exc_info=True)
        return None


def resolve_request_principal(request: Request | None) -> Principal:
    """Resolve current principal: JWT → webui identity, else local admin.

    When a JWT is attached, never silently fall back to local admin — that
    causes switch-user 串台 and wrong account chip (shows Local Admin).
    """
    if request is not None:
        payload = getattr(request.state, "webui_user", None)
        if isinstance(payload, dict):
            p = resolve_principal_from_webui_payload(payload)
            if p:
                return p
            p = ensure_principal_from_webui_payload(payload)
            if p:
                return p
            # Last resort: synthetic principal from JWT claims (still not local admin).
            username = str(payload.get("username") or "").strip() or "user"
            pid = str(payload.get("principal_id") or "").strip()
            if not pid:
                wid = payload.get("webui_user_id")
                pid = f"webui:{wid}" if wid is not None else f"webui_username:{username}"
            return {
                "principal_id": pid,
                "org_id": DEFAULT_ORG_ID,
                "principal_type": "internal",
                "display_name": username,
                "primary_email": None,
                "status": "active",
                "team_ids": [],
                "attrs": {"username": username, "webui_user_id": payload.get("webui_user_id")},
            }
        # Optional header for shadow testing / future tokens
        hdr = request.headers.get("x-evoflow-principal-id")
        if hdr:
            p = principals_mod.get_principal(str(hdr).strip())
            if p:
                return p
    return principals_mod.get_or_create_local_admin()


def resolve_request_authz(
    request: Request | None,
    *,
    session_key: str | None = None,
    scope_id: str | None = None,
) -> AuthzContext:
    principal = resolve_request_principal(request)
    return build_authz_context(principal, session_key=session_key, scope_id=scope_id)


def me_payload(
    ctx: AuthzContext,
    *,
    auth_source: str = "local",
    username: str | None = None,
) -> dict[str, Any]:
    p = ctx["principal"]
    pid = str(p.get("principal_id") or "")
    attrs = p.get("attrs") if isinstance(p.get("attrs"), dict) else {}
    uname = username or (str(attrs.get("username") or "").strip() or None)
    source = "jwt" if auth_source == "jwt" else "local"
    display = str(p.get("display_name") or "").strip()
    # Prefer login username over bootstrap "Local Admin" when JWT is present.
    if source == "jwt" and uname and (not display or display.lower() in {"local admin", "admin"}):
        display = uname
    if not display:
        display = uname or pid or "用户"
    from evoflow.authz.principals import _avatar_public_fields

    out = {
        "orgId": ctx.get("org_id") or DEFAULT_ORG_ID,
        "orgScopeId": org_scope(str(ctx.get("org_id") or DEFAULT_ORG_ID)),
        "principalId": pid,
        "displayName": display,
        "principalType": p.get("principal_type") or "internal",
        "status": p.get("status") or "active",
        "primaryEmail": p.get("primary_email"),
        "isOrgAdmin": bool(ctx.get("is_org_admin")),
        "personalScopeId": personal_scope(pid) if pid else None,
        "teamIds": list(p.get("team_ids") or []),
        "authSource": source,
        "username": uname,
        "canLogout": source == "jwt",
    }
    out.update(_avatar_public_fields(pid))
    return out
