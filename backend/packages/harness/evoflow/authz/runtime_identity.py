"""Inject / resolve human identity for LangGraph runs and session stamps.

Field contract: ``principal_id`` (who), ``owner_scope_id`` / ``created_by`` (resource).

Per-run identity is also exposed through a ``ContextVar`` so tools/middleware can
read the current principal without threading a ``runtime`` parameter everywhere
(avoids the manual-passing barrier across asset/experience/memory writes).
"""

from __future__ import annotations

import contextvars
import logging
from typing import Any

logger = logging.getLogger(__name__)

# Current run's principal id, set once at context construction. Tools fall back
# to this when no runtime handle is available — the identity is ambient.
_current_principal_var: contextvars.ContextVar[str] = contextvars.ContextVar(
    "evoflow_current_principal_id", default=""
)


def set_current_principal_id(principal_id: str | None) -> str:
    """Bind the current run's principal id (ambient identity for this async context).

    Explicitly sets even on empty so a legacy/no-identity run clears any stale
    value from a previous run in the same async context.
    """
    pid = str(principal_id or "").strip()
    _current_principal_var.set(pid)
    return pid


def get_current_principal_id() -> str:
    """Read the ambient principal id (empty when unauthenticated/legacy)."""
    return _current_principal_var.get()


def principal_id_from_personal_scope(owner_scope_id: str | None) -> str | None:
    owner = str(owner_scope_id or "").strip()
    if owner.startswith("personal:"):
        return owner[len("personal:") :] or None
    return None


def identity_from_principal_id(principal_id: str | None, *, org_id: str | None = None) -> dict[str, str]:
    pid = str(principal_id or "").strip()
    if not pid:
        return {}
    try:
        from evoflow.authz.scope import personal_scope
        from evoflow.authz.types import DEFAULT_ORG_ID

        oid = str(org_id or DEFAULT_ORG_ID).strip() or DEFAULT_ORG_ID
        return {
            "principal_id": pid,
            "created_by": pid,
            "owner_scope_id": personal_scope(pid),
            "org_id": oid,
        }
    except Exception:
        return {"principal_id": pid, "created_by": pid}


def resolve_identity_from_session(session_key: str | None) -> dict[str, str]:
    sk = str(session_key or "").strip()
    if not sk:
        return {}
    try:
        from evoflow.persistence.db import get_db

        cols = {str(r[1]) for r in get_db().execute("PRAGMA table_info(evoflow_chat_sessions)").fetchall()}
        if "created_by" not in cols:
            return {}
        fields = ["created_by"]
        if "scope_id" in cols:
            fields.append("scope_id")
        if "org_id" in cols:
            fields.append("org_id")
        row = get_db().execute(
            f"SELECT {', '.join(fields)} FROM evoflow_chat_sessions "
            "WHERE session_key = ? AND COALESCE(is_deleted, 0) = 0",
            (sk,),
        ).fetchone()
        if not row:
            return {}
        data = dict(zip(fields, row, strict=False))
        pid = str(data.get("created_by") or "").strip()
        scope = str(data.get("scope_id") or "").strip()
        org = str(data.get("org_id") or "").strip()
        out = identity_from_principal_id(pid, org_id=org or None)
        if scope:
            out["owner_scope_id"] = scope
        if org:
            out["org_id"] = org
        return out
    except Exception:
        logger.debug("resolve_identity_from_session failed sk=%s", sk, exc_info=True)
        return {}


def resolve_identity_from_automation(task_id: str | None) -> dict[str, str]:
    tid = str(task_id or "").strip()
    if not tid:
        return {}
    try:
        from evoflow.persistence.db import get_db

        cols = {str(r[1]) for r in get_db().execute("PRAGMA table_info(evoflow_automations)").fetchall()}
        if "owner_scope_id" not in cols and "created_by" not in cols:
            return {}
        parts = []
        if "created_by" in cols:
            parts.append("created_by")
        if "owner_scope_id" in cols:
            parts.append("owner_scope_id")
        if "org_id" in cols:
            parts.append("org_id")
        row = get_db().execute(
            f"SELECT {', '.join(parts)} FROM evoflow_automations WHERE task_id = ?",
            (tid,),
        ).fetchone()
        if not row:
            return {}
        idx = 0
        created_by = ""
        owner = ""
        org = ""
        if "created_by" in cols:
            created_by = str(row[idx] or "").strip()
            idx += 1
        if "owner_scope_id" in cols:
            owner = str(row[idx] or "").strip()
            idx += 1
        if "org_id" in cols:
            org = str(row[idx] or "").strip()
        pid = created_by or principal_id_from_personal_scope(owner)
        out = identity_from_principal_id(pid, org_id=org or None)
        if owner:
            out["owner_scope_id"] = owner
        if org:
            out["org_id"] = org
        return out
    except Exception:
        logger.debug("resolve_identity_from_automation failed tid=%s", tid, exc_info=True)
        return {}


def resolve_identity_from_agent(agent_code: str | None) -> dict[str, str]:
    code = str(agent_code or "").strip()
    if not code:
        return {}
    try:
        from evoflow.persistence.config_repositories import get_agent_owner_scope

        org, owner = get_agent_owner_scope(code)
        pid = principal_id_from_personal_scope(owner)
        out = identity_from_principal_id(pid, org_id=org)
        if owner:
            out["owner_scope_id"] = owner
        if org:
            out["org_id"] = str(org)
        return out
    except Exception:
        logger.debug("resolve_identity_from_agent failed code=%s", code, exc_info=True)
        return {}


def enrich_run_context_identity(run_context: dict[str, Any] | None) -> dict[str, Any]:
    """Fill principal_id / created_by / owner_scope_id on a run context dict (idempotent)."""
    ctx = dict(run_context or {})
    existing = str(ctx.get("principal_id") or ctx.get("created_by") or "").strip()
    if existing:
        # Normalize aliases
        ctx.setdefault("principal_id", existing)
        ctx.setdefault("created_by", existing)
        if not str(ctx.get("owner_scope_id") or "").strip():
            filled = identity_from_principal_id(existing, org_id=str(ctx.get("org_id") or "") or None)
            if filled.get("owner_scope_id"):
                ctx["owner_scope_id"] = filled["owner_scope_id"]
        set_current_principal_id(existing)
        return ctx

    identity: dict[str, str] = {}
    sk = str(ctx.get("session_key") or "").strip()
    if sk:
        identity = resolve_identity_from_session(sk)
    if not identity.get("principal_id"):
        identity = resolve_identity_from_automation(str(ctx.get("automation_task_id") or ""))
    if not identity.get("principal_id"):
        agent = (
            str(ctx.get("proactive_agent_code") or "").strip()
            or str(ctx.get("agent_id") or "").strip()
            or str(ctx.get("agent_name") or "").strip()
        )
        if agent and agent not in ("main", "lead_agent"):
            identity = resolve_identity_from_agent(agent)
    for k, v in identity.items():
        if v and not str(ctx.get(k) or "").strip():
            ctx[k] = v
    set_current_principal_id(str(identity.get("principal_id") or "").strip())
    return ctx


def stamp_session_from_identity(session_key: str | None, identity: dict[str, Any] | None) -> bool:
    """Stamp session ownership from an identity dict (force=False: don't overwrite)."""
    sk = str(session_key or "").strip()
    pid = str((identity or {}).get("principal_id") or (identity or {}).get("created_by") or "").strip()
    if not sk or not pid:
        return False
    try:
        from evoflow.authz.principals import get_principal
        from evoflow.authz.session_ownership import stamp_session_ownership

        owner = get_principal(pid)
        if not owner:
            return False
        scope = str((identity or {}).get("owner_scope_id") or "").strip() or None
        stamp_session_ownership(sk, owner, scope_id=scope, force=False)
        return True
    except Exception:
        logger.debug("stamp_session_from_identity failed sk=%s", sk, exc_info=True)
        return False


def principal_id_from_runtime(runtime: Any = None, context: Any = None) -> str | None:
    """Read principal_id from LangGraph Runtime.context or a plain mapping.

    Falls back to the ambient per-run ContextVar so tools without a runtime
    handle still resolve the current user (no manual threading needed).
    """
    ctx = context
    if ctx is None and runtime is not None:
        ctx = getattr(runtime, "context", None)
    if ctx is not None:
        try:
            if hasattr(ctx, "get"):
                pid = ctx.get("principal_id") or ctx.get("created_by")
                if pid:
                    return str(pid).strip() or None
            pid = getattr(ctx, "principal_id", None) or getattr(ctx, "created_by", None)
            if pid:
                return str(pid).strip() or None
        except Exception:
            pass
    ambient = get_current_principal_id()
    return ambient or None
