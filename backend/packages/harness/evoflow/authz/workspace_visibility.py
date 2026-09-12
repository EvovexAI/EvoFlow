"""Workspace path visibility: personal files private; host picks org-shared."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from evoflow.authz.resource_visibility import owner_scope_visible_to_principal
from evoflow.authz.scope import org_scope, personal_scope, parse_scope_id
from evoflow.authz.types import DEFAULT_ORG_ID, Principal


def _norm_key(path: str | Path) -> str:
    try:
        from evoflow.persistence.session_context_fields import normalize_workspace_group_key

        return normalize_workspace_group_key(str(path))
    except Exception:
        s = str(path or "").strip().replace("\\", "/").rstrip("/").lower()
        return s


def personal_principal_id_from_files_path(path: str | Path) -> str | None:
    """If ``path`` is under ``scopes/personal/<id>/…``, return that principal id."""
    try:
        from evoflow.authz.scope_paths import scopes_root

        target = Path(str(path or "")).expanduser()
        try:
            target = target.resolve()
        except OSError:
            pass
        root = scopes_root().resolve()
        try:
            rel = target.relative_to(root)
        except ValueError:
            return None
        parts = rel.parts
        if len(parts) >= 2 and parts[0] == "personal":
            return str(parts[1]) or None
    except Exception:
        return None
    return None


def is_under_personal_files(path: str | Path, principal_id: str) -> bool:
    pid = str(principal_id or "").strip()
    if not pid:
        return False
    try:
        from evoflow.authz.scope_paths import scope_files_dir

        files = scope_files_dir(personal_scope(pid))
        try:
            files_r = files.resolve()
            target = Path(str(path)).expanduser().resolve()
        except OSError:
            return _norm_key(path).startswith(_norm_key(files))
        try:
            target.relative_to(files_r)
            return True
        except ValueError:
            return False
    except Exception:
        return False


def default_owner_scope_for_path(
    path: str,
    *,
    principal_id: str | None = None,
    org_id: str = DEFAULT_ORG_ID,
) -> str:
    """Stamp rule: personal files → personal; other host paths → org (shared pick)."""
    pid = str(principal_id or "").strip()
    if pid and is_under_personal_files(path, pid):
        return personal_scope(pid)
    owned = personal_principal_id_from_files_path(path)
    if owned:
        return personal_scope(owned)
    return org_scope(org_id or DEFAULT_ORG_ID)


def default_workspace_root_for_principal(principal: Principal | None) -> str | None:
    """Ensure personal home and return ``…/scopes/personal/<id>/files``."""
    if not principal:
        return None
    pid = str(principal.get("principal_id") or "").strip()
    if not pid:
        return None
    try:
        from evoflow.authz.scope_paths import ensure_principal_home, scope_files_dir

        ensure_principal_home(principal)
        return str(scope_files_dir(personal_scope(pid)).resolve())
    except Exception:
        return None


def workspace_path_visible_to_principal(
    path: str,
    principal: Principal | None,
    *,
    is_admin: bool = False,
    personal_scope_id: str | None = None,
    org_scope_id: str | None = None,
    owner_scope_id: str | None = None,
) -> bool:
    """Whether a catalog/host path may be listed, bound, or browsed."""
    if is_admin:
        return True
    p = str(path or "").strip()
    if not p:
        return False
    pid = ""
    if principal:
        pid = str(principal.get("principal_id") or "").strip()
    # Own personal files bucket is always visible (path segment may sanitize id).
    if pid and is_under_personal_files(p, pid):
        return True
    # Any other scopes/personal/<…>/ tree is foreign.
    if personal_principal_id_from_files_path(p):
        return False

    owner = str(owner_scope_id or "").strip() if owner_scope_id is not None else None
    if owner is None:
        try:
            from evoflow.persistence import workspace_repositories as ws_repo

            owner = ws_repo.get_workspace_owner_scope(p)
        except Exception:
            owner = None

    # Not in catalog (or empty owner): host pick / legacy → shared
    if not owner:
        return True

    return owner_scope_visible_to_principal(
        owner,
        principal,
        is_admin=False,
        personal_scope=personal_scope_id,
        org_scope=org_scope_id,
    )


def filter_visible_workspace_paths(
    paths: list[str],
    principal: Principal | None,
    *,
    is_admin: bool = False,
    personal_scope_id: str | None = None,
    org_scope_id: str | None = None,
) -> list[str]:
    out: list[str] = []
    for raw in paths or []:
        p = str(raw or "").strip()
        if not p:
            continue
        if workspace_path_visible_to_principal(
            p,
            principal,
            is_admin=is_admin,
            personal_scope_id=personal_scope_id,
            org_scope_id=org_scope_id,
        ):
            out.append(p)
    return out


def resolve_stamp_for_workspace_path(
    path: str,
    stamp: dict[str, Any] | None,
) -> dict[str, str]:
    """Build org_id / owner_scope_id for create-or-stamp."""
    from evoflow.authz.types import DEFAULT_ORG_ID as _ORG

    st = dict(stamp or {})
    oid = str(st.get("org_id") or _ORG)
    pid = str(st.get("principal_id") or st.get("created_by") or "").strip()
    owner = default_owner_scope_for_path(path, principal_id=pid or None, org_id=oid)
    # Explicit personal override only when path is that user's files
    explicit = str(st.get("owner_scope_id") or "").strip()
    if explicit:
        try:
            kind, _ = parse_scope_id(explicit)
        except ValueError:
            kind = ""
        if kind == "personal" and pid and is_under_personal_files(path, pid):
            owner = explicit
        elif kind in {"org", "group", "channel"}:
            owner = explicit
    return {"org_id": oid, "owner_scope_id": owner, "created_by": pid}
