"""Shared resource visibility: owner_scope_id isolation (always on)."""

from __future__ import annotations

from evoflow.authz.types import Principal


def owner_scope_visible_to_principal(
    owner_scope_id: str | None,
    principal: Principal | None,
    *,
    is_admin: bool = False,
    personal_scope: str | None = None,
    org_scope: str | None = None,
) -> bool:
    """Visibility for resources stamped with ``owner_scope_id``.

    - Admin → always visible.
    - Empty / missing owner → **admin only** (legacy unstamped no longer shared).
    - Otherwise: own personal, org shared, or group/channel membership.
    """
    if is_admin:
        return True
    owner = str(owner_scope_id or "").strip()
    if not owner:
        return False
    if personal_scope and owner == personal_scope:
        return True
    if org_scope and owner == org_scope:
        return True
    if owner.startswith("group:") or owner.startswith("channel:"):
        if not principal:
            return False
        try:
            from evoflow.authz.membership import can_read_scope

            return can_read_scope(principal, owner)
        except Exception:
            return False
    return False


def stamp_kwargs_from_request(request: object | None) -> dict[str, str]:
    """Resolve org_id / owner_scope_id / created_by for the current request."""
    try:
        from evoflow.authz.context import resolve_request_authz
        from evoflow.authz.scope import personal_scope
        from evoflow.authz.types import DEFAULT_ORG_ID

        ctx = resolve_request_authz(request)  # type: ignore[arg-type]
        p = ctx.get("principal") or {}
        pid = str(p.get("principal_id") or "").strip()
        oid = str(ctx.get("org_id") or DEFAULT_ORG_ID)
        if not pid:
            return {"org_id": oid}
        return {
            "org_id": oid,
            "owner_scope_id": personal_scope(pid),
            "created_by": pid,
            "principal_id": pid,
        }
    except Exception:
        return {}
