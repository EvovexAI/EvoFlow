"""Principal + identity persistence helpers."""

from __future__ import annotations

import json
import logging
import secrets
import time
import uuid
from typing import Any

from evoflow.authz.scope import org_scope, personal_scope
from evoflow.authz.types import DEFAULT_ORG_ID, Principal, PrincipalType
from evoflow.persistence.db import get_db, run_db_transaction

logger = logging.getLogger(__name__)


def _row_dict(row: Any) -> dict[str, Any]:
    return {k: row[k] for k in row.keys()}


def _parse_json_list(raw: Any) -> list[str]:
    try:
        data = json.loads(raw or "[]")
        if isinstance(data, list):
            return [str(x) for x in data]
    except Exception:
        pass
    return []


def _parse_json_obj(raw: Any) -> dict[str, Any]:
    try:
        data = json.loads(raw or "{}")
        if isinstance(data, dict):
            return data
    except Exception:
        pass
    return {}


def principal_from_row(row: Any) -> Principal:
    d = _row_dict(row)
    return Principal(
        principal_id=str(d["principal_id"]),
        org_id=str(d.get("org_id") or DEFAULT_ORG_ID),
        principal_type=str(d.get("principal_type") or "internal"),  # type: ignore[typeddict-item]
        display_name=str(d.get("display_name") or ""),
        primary_email=(str(d["primary_email"]) if d.get("primary_email") else None),
        status=str(d.get("status") or "active"),
        team_ids=_parse_json_list(d.get("team_ids_json")),
        attrs=_parse_json_obj(d.get("attrs_json")),
    )


def get_principal(principal_id: str, *, org_id: str = DEFAULT_ORG_ID) -> Principal | None:
    pid = str(principal_id or "").strip()
    if not pid:
        return None
    row = (
        get_db()
        .execute(
            """
            SELECT * FROM evoflow_principals
            WHERE principal_id = ? AND org_id = ?
            LIMIT 1
            """,
            (pid, org_id),
        )
        .fetchone()
    )
    return principal_from_row(row) if row else None


def resolve_principal_by_identity(
    provider: str,
    external_id: str,
    *,
    org_id: str = DEFAULT_ORG_ID,
) -> Principal | None:
    prov = str(provider or "").strip()
    ext = str(external_id or "").strip()
    if not prov or not ext:
        return None
    row = (
        get_db()
        .execute(
            """
            SELECT p.*
            FROM evoflow_principal_identities i
            JOIN evoflow_principals p ON p.principal_id = i.principal_id
            WHERE i.org_id = ? AND i.provider = ? AND i.external_id = ?
            LIMIT 1
            """,
            (org_id, prov, ext),
        )
        .fetchone()
    )
    return principal_from_row(row) if row else None


def list_principals(*, org_id: str = DEFAULT_ORG_ID, include_deactivated: bool = False) -> list[Principal]:
    if include_deactivated:
        rows = get_db().execute(
            "SELECT * FROM evoflow_principals WHERE org_id = ? ORDER BY display_name ASC, principal_id ASC",
            (org_id,),
        ).fetchall()
    else:
        rows = get_db().execute(
            """
            SELECT * FROM evoflow_principals
            WHERE org_id = ? AND status = 'active'
            ORDER BY display_name ASC, principal_id ASC
            """,
            (org_id,),
        ).fetchall()
    return [principal_from_row(r) for r in rows]


def is_active_internal(principal: Principal | None) -> bool:
    if not principal:
        return False
    return (
        str(principal.get("status") or "") == "active"
        and str(principal.get("principal_type") or "") == "internal"
    )


def create_principal(
    *,
    display_name: str,
    org_id: str = DEFAULT_ORG_ID,
    principal_type: PrincipalType = "internal",
    primary_email: str | None = None,
    username: str | None = None,
    password: str | None = None,
    attrs: dict[str, Any] | None = None,
    principal_id: str | None = None,
) -> Principal:
    """Create an internal/guest principal; optionally mint a WebUI login row."""
    pid = str(principal_id or "").strip() or f"user:{uuid.uuid4().hex}"
    name = str(display_name or "").strip() or pid
    email = (str(primary_email).strip() if primary_email else None) or None
    now = float(time.time())
    attrs_obj = dict(attrs or {})
    uname = str(username or "").strip()

    def _write(db: Any) -> None:
        db.execute(
            """
            INSERT INTO evoflow_principals (
                principal_id, org_id, principal_type, display_name, primary_email,
                status, team_ids_json, attrs_json, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, 'active', '[]', ?, ?, ?)
            """,
            (
                pid,
                org_id,
                principal_type,
                name,
                email,
                json.dumps(attrs_obj, ensure_ascii=False),
                now,
                now,
            ),
        )
        if uname and principal_type == "internal":
            from evoflow.webui.auth import hash_password

            pw = password or secrets.token_urlsafe(16)
            pw_hash = hash_password(pw)
            ts = int(now)
            cur = db.execute(
                """
                INSERT INTO evoflow_webui_users (username, password_hash, is_primary, created_at, updated_at)
                VALUES (?, ?, 0, ?, ?)
                """,
                (uname, pw_hash, ts, ts),
            )
            webui_id = int(cur.lastrowid)
            attrs_obj["webui_user_id"] = webui_id
            attrs_obj["username"] = uname
            # Stash one-time plaintext for caller via attrs (not persisted after update below)
            attrs_obj["_initial_password"] = pw
            db.execute(
                "UPDATE evoflow_principals SET attrs_json = ?, updated_at = ? WHERE principal_id = ?",
                (json.dumps({k: v for k, v in attrs_obj.items() if k != "_initial_password"}, ensure_ascii=False), now, pid),
            )
            db.execute(
                """
                INSERT OR IGNORE INTO evoflow_principal_identities
                    (org_id, provider, external_id, principal_id)
                VALUES (?, 'webui', ?, ?)
                """,
                (org_id, str(webui_id), pid),
            )
            db.execute(
                """
                INSERT OR IGNORE INTO evoflow_principal_identities
                    (org_id, provider, external_id, principal_id)
                VALUES (?, 'webui_username', ?, ?)
                """,
                (org_id, uname, pid),
            )

    run_db_transaction(_write)
    created = get_principal(pid, org_id=org_id)
    if not created:
        raise RuntimeError("failed to create principal")
    try:
        from evoflow.authz.scope_paths import ensure_principal_home

        ensure_principal_home(created)
    except Exception:
        logger.debug("ensure_principal_home after create failed", exc_info=True)
    # Re-attach one-time password for API response if minted
    if uname and "_initial_password" in attrs_obj:
        created = dict(created)
        created["attrs"] = {**(created.get("attrs") or {}), "_initial_password": attrs_obj["_initial_password"]}
    return created  # type: ignore[return-value]


def set_principal_status(principal_id: str, status: str, *, org_id: str = DEFAULT_ORG_ID) -> bool:
    st = str(status or "").strip()
    if st not in {"active", "deactivated"}:
        raise ValueError("status must be active|deactivated")
    now = float(time.time())
    ptype = "guest" if st == "deactivated" else "internal"

    def _write(db: Any) -> bool:
        cur = db.execute(
            """
            UPDATE evoflow_principals
            SET status = ?, principal_type = CASE
                WHEN ? = 'deactivated' THEN 'guest'
                WHEN principal_type = 'guest' THEN 'internal'
                ELSE principal_type
            END,
            updated_at = ?
            WHERE principal_id = ? AND org_id = ?
            """,
            (st, st, now, principal_id, org_id),
        )
        return cur.rowcount > 0

    ok = run_db_transaction(_write)
    del ptype
    return ok


def ensure_webui_principal(
    *,
    webui_user_id: int | str,
    username: str,
    is_primary: bool = False,
    org_id: str = DEFAULT_ORG_ID,
) -> Principal:
    """Idempotently link a WebUI user row to a principal (+ org_admin if primary)."""
    import time

    from evoflow.authz import admin_grants as admin_mod

    uid = str(webui_user_id).strip()
    uname = str(username or "admin").strip() or "admin"
    existing = resolve_principal_by_identity("webui", uid, org_id=org_id)
    if existing:
        if is_primary and not admin_mod.is_org_admin(str(existing["principal_id"]), org_id=org_id):
            admin_mod.promote_org_admin(str(existing["principal_id"]), granted_by=None, org_id=org_id)
        return existing

    principal_id = f"webui:{uid}"
    now = float(time.time())

    def _write(db: Any) -> None:
        db.execute(
            """
            INSERT OR IGNORE INTO evoflow_principals (
                principal_id, org_id, principal_type, display_name, primary_email,
                status, team_ids_json, attrs_json, created_at, updated_at
            ) VALUES (?, ?, 'internal', ?, NULL, 'active', '[]', ?, ?, ?)
            """,
            (
                principal_id,
                org_id,
                uname,
                json.dumps({"webui_user_id": int(uid) if uid.isdigit() else uid, "username": uname}, ensure_ascii=False),
                now,
                now,
            ),
        )
        db.execute(
            """
            INSERT OR IGNORE INTO evoflow_principal_identities
                (org_id, provider, external_id, principal_id)
            VALUES (?, 'webui', ?, ?)
            """,
            (org_id, uid, principal_id),
        )
        db.execute(
            """
            INSERT OR IGNORE INTO evoflow_principal_identities
                (org_id, provider, external_id, principal_id)
            VALUES (?, 'webui_username', ?, ?)
            """,
            (org_id, uname, principal_id),
        )

    try:
        run_db_transaction(_write)
    except Exception:
        logger.debug("ensure_webui_principal write failed", exc_info=True)
    p = get_principal(principal_id, org_id=org_id) or resolve_principal_by_identity("webui", uid, org_id=org_id)
    if not p:
        raise RuntimeError("failed to ensure webui principal")
    if is_primary:
        admin_mod.promote_org_admin(str(p["principal_id"]), granted_by=None, org_id=org_id)
    try:
        from evoflow.authz.scope_paths import ensure_principal_home

        ensure_principal_home(p)
    except Exception:
        logger.debug("ensure_principal_home after webui sync failed", exc_info=True)
    return p


def get_or_create_local_admin(*, org_id: str = DEFAULT_ORG_ID) -> Principal:
    """Resolve the bootstrap local admin (localhost / no JWT)."""
    p = resolve_principal_by_identity("local", "admin", org_id=org_id)
    if p:
        try:
            from evoflow.authz.scope_paths import ensure_principal_home

            ensure_principal_home(p)
        except Exception:
            logger.debug("ensure_principal_home for local admin failed", exc_info=True)
        return p
    # Prefer primary webui admin if present
    row = (
        get_db()
        .execute(
            """
            SELECT p.*
            FROM evoflow_admin_grants g
            JOIN evoflow_principals p ON p.principal_id = g.principal_id
            WHERE g.org_id = ? AND g.role = 'org_admin' AND g.scope_id = ?
            ORDER BY g.created_at ASC
            LIMIT 1
            """,
            (org_id, org_scope(org_id)),
        )
        .fetchone()
    )
    if row:
        found = principal_from_row(row)
        try:
            from evoflow.authz.scope_paths import ensure_principal_home

            ensure_principal_home(found)
        except Exception:
            logger.debug("ensure_principal_home for admin failed", exc_info=True)
        return found
    # Last resort create
    created = create_principal(
        display_name="Local Admin",
        org_id=org_id,
        principal_id="local-admin",
        attrs={"bootstrap": True},
    )
    return created


def personal_scope_for(principal: Principal) -> str:
    return personal_scope(str(principal["principal_id"]))


def _webui_user_id_for(principal: Principal) -> int | None:
    attrs = principal.get("attrs") if isinstance(principal.get("attrs"), dict) else {}
    raw = attrs.get("webui_user_id")
    if raw is None:
        return None
    try:
        return int(raw)
    except (TypeError, ValueError):
        return None


def username_for(principal: Principal) -> str | None:
    attrs = principal.get("attrs") if isinstance(principal.get("attrs"), dict) else {}
    uname = str(attrs.get("username") or "").strip()
    return uname or None


def principal_to_public(
    principal: Principal,
    *,
    org_id: str = DEFAULT_ORG_ID,
    is_org_admin: bool | None = None,
) -> dict[str, Any]:
    from evoflow.authz import admin_grants as admin_mod

    pid = str(principal.get("principal_id") or "")
    uname = username_for(principal)
    if is_org_admin is None:
        is_org_admin = admin_mod.is_org_admin(pid, org_id=org_id)
    return {
        "principalId": pid,
        "displayName": principal.get("display_name") or "",
        "principalType": principal.get("principal_type") or "internal",
        "status": principal.get("status") or "active",
        "primaryEmail": principal.get("primary_email"),
        "username": uname,
        "hasLogin": bool(_webui_user_id_for(principal) or uname),
        "isOrgAdmin": bool(is_org_admin),
        "personalScopeId": personal_scope_for(principal),
        "createdAt": (principal.get("attrs") or {}).get("created_at"),
        "updatedAt": (principal.get("attrs") or {}).get("updated_at"),
        **_avatar_public_fields(pid),
    }


def _avatar_public_fields(principal_id: str) -> dict[str, Any]:
    from evoflow.authz import principal_avatars as pav

    pid = str(principal_id or "").strip()
    if not pid:
        return {"hasAvatar": False, "avatarRev": None, "avatarUrl": None}
    has = pav.has_avatar_file(pid)
    rev = pav.avatar_revision_for(pid) if has else None
    url = f"/api/identity/principals/{pid}/avatar" + (f"?v={rev}" if rev else "") if has else None
    return {"hasAvatar": has, "avatarRev": rev, "avatarUrl": url}


def update_principal(
    principal_id: str,
    *,
    display_name: str | None = None,
    primary_email: str | None = None,
    update_primary_email: bool = False,
    username: str | None = None,
    org_id: str = DEFAULT_ORG_ID,
) -> Principal:
    """Update principal profile fields; optionally rename WebUI login username."""
    pid = str(principal_id or "").strip()
    current = get_principal(pid, org_id=org_id)
    if not current:
        raise ValueError("principal not found")

    new_name = str(display_name).strip() if display_name is not None else None
    if display_name is not None and not new_name:
        raise ValueError("displayName must not be empty")

    new_email = str(primary_email).strip() if primary_email else None
    new_username = str(username).strip() if username is not None else None
    if username is not None and not new_username:
        raise ValueError("username must not be empty")

    attrs = dict(current.get("attrs") or {})
    webui_id = _webui_user_id_for(current)
    old_username = username_for(current)
    now = float(time.time())

    def _write(db: Any) -> None:
        nonlocal attrs
        if new_name is not None:
            db.execute(
                "UPDATE evoflow_principals SET display_name = ?, updated_at = ? WHERE principal_id = ? AND org_id = ?",
                (new_name, now, pid, org_id),
            )
        if update_primary_email:
            db.execute(
                "UPDATE evoflow_principals SET primary_email = ?, updated_at = ? WHERE principal_id = ? AND org_id = ?",
                (new_email, now, pid, org_id),
            )
        if new_username is not None and new_username != (old_username or ""):
            if not webui_id:
                raise ValueError("principal has no login account; set username on create")
            clash = db.execute(
                "SELECT id FROM evoflow_webui_users WHERE username = ? AND id != ? LIMIT 1",
                (new_username, webui_id),
            ).fetchone()
            if clash:
                raise ValueError("username already taken")
            ts = int(now)
            db.execute(
                "UPDATE evoflow_webui_users SET username = ?, updated_at = ? WHERE id = ?",
                (new_username, ts, webui_id),
            )
            if old_username:
                db.execute(
                    """
                    DELETE FROM evoflow_principal_identities
                    WHERE org_id = ? AND provider = 'webui_username' AND external_id = ? AND principal_id = ?
                    """,
                    (org_id, old_username, pid),
                )
            db.execute(
                """
                INSERT OR REPLACE INTO evoflow_principal_identities
                    (org_id, provider, external_id, principal_id)
                VALUES (?, 'webui_username', ?, ?)
                """,
                (org_id, new_username, pid),
            )
            attrs["username"] = new_username
            db.execute(
                "UPDATE evoflow_principals SET attrs_json = ?, updated_at = ? WHERE principal_id = ? AND org_id = ?",
                (json.dumps(attrs, ensure_ascii=False), now, pid, org_id),
            )

    run_db_transaction(_write)
    updated = get_principal(pid, org_id=org_id)
    if not updated:
        raise RuntimeError("failed to update principal")
    return updated


def reset_principal_password(
    principal_id: str,
    *,
    new_password: str | None = None,
    org_id: str = DEFAULT_ORG_ID,
) -> str:
    pid = str(principal_id or "").strip()
    current = get_principal(pid, org_id=org_id)
    if not current:
        raise ValueError("principal not found")
    webui_id = _webui_user_id_for(current)
    if not webui_id:
        raise ValueError("principal has no login account")
    from evoflow.webui.auth import change_password, generate_password

    plaintext = str(new_password or "").strip() or generate_password()
    if len(plaintext) < 8:
        raise ValueError("password must be at least 8 characters")
    if not change_password(int(webui_id), plaintext):
        raise RuntimeError("failed to reset password")
    return plaintext


def _link_oidc_identity(
    db: Any,
    *,
    org_id: str,
    oidc_sub: str,
    principal_id: str,
) -> None:
    db.execute(
        """
        INSERT OR IGNORE INTO evoflow_principal_identities
            (org_id, provider, external_id, principal_id)
        VALUES (?, 'oidc', ?, ?)
        """,
        (org_id, oidc_sub, principal_id),
    )


def _find_principal_by_email(email: str, *, org_id: str = DEFAULT_ORG_ID) -> Principal | None:
    em = str(email or "").strip().lower()
    if not em:
        return None
    row = (
        get_db()
        .execute(
            """
            SELECT * FROM evoflow_principals
            WHERE org_id = ? AND lower(primary_email) = ?
            LIMIT 1
            """,
            (org_id, em),
        )
        .fetchone()
    )
    return principal_from_row(row) if row else None


def resolve_or_provision_oidc_principal(
    *,
    oidc_sub: str,
    email: str | None = None,
    display_name: str | None = None,
    org_id: str = DEFAULT_ORG_ID,
    auto_provision: bool = True,
) -> Principal:
    """Map OIDC subject → principal; JIT provision when allowed."""
    sub = str(oidc_sub or "").strip()
    if not sub:
        raise ValueError("oidc subject required")

    existing = resolve_principal_by_identity("oidc", sub, org_id=org_id)
    if existing:
        if str(existing.get("status") or "") == "deactivated":
            raise ValueError("principal is deactivated")
        return existing

    em = str(email or "").strip().lower() or None
    name = str(display_name or em or sub).strip() or sub

    by_email = _find_principal_by_email(em, org_id=org_id) if em else None
    if by_email:
        pid = str(by_email["principal_id"])

        def _link(db: Any) -> None:
            _link_oidc_identity(db, org_id=org_id, oidc_sub=sub, principal_id=pid)

        run_db_transaction(_link)
        linked = get_principal(pid, org_id=org_id)
        if not linked:
            raise RuntimeError("failed to link oidc identity")
        return linked

    if not auto_provision:
        raise ValueError("user is not provisioned; contact an administrator")

    created = create_principal(
        display_name=name,
        org_id=org_id,
        primary_email=em,
        attrs={"auth_method": "oidc", "oidc_sub": sub},
    )
    pid = str(created["principal_id"])

    def _link(db: Any) -> None:
        _link_oidc_identity(db, org_id=org_id, oidc_sub=sub, principal_id=pid)

    run_db_transaction(_link)
    try:
        from evoflow.authz.scope_paths import ensure_principal_home

        ensure_principal_home(created)
    except Exception:
        logger.debug("ensure_principal_home after oidc provision failed", exc_info=True)
    out = get_principal(pid, org_id=org_id)
    if not out:
        raise RuntimeError("failed to provision oidc principal")
    return out
