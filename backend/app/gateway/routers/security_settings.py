"""Security center API — OS execution security, policy overlays, audit logs.

Endpoints under ``/api/settings/security``:
  GET    /                  — full security config (+ live execution_security status)
  PATCH  /                  — deep-merge partial update (may include execution_security)
  PUT    /                  — replace entire policy config
  GET    /execution         — host OS sandbox status
  PATCH  /execution         — update profile / enablement (SQLite + memory)
  GET    /audit             — paginated audit records (all threads)
  DELETE /audit             — clear all audit records
  GET    /audit/export      — export audit records as downloadable text
"""

from __future__ import annotations

import csv
import io
from typing import Any

from fastapi import APIRouter, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from evoflow.authz.http_guard import require_org_admin
from evoflow.persistence.sandbox_audit_repositories import (
    clear_all_sandbox_audit,
    list_all_sandbox_audit,
)
from evoflow.persistence.security_settings_repositories import (
    DEFAULT_SECURITY_SETTINGS,
    get_security_settings,
    patch_security_settings,
    replace_security_settings,
)

router = APIRouter(prefix="/api/settings/security", tags=["settings"])


def _detect_runtime_versions() -> dict[str, dict[str, str]]:
    """Detect installed runtime versions via subprocess (best-effort)."""
    import shutil
    import subprocess

    result: dict[str, dict[str, str]] = {}
    probes = [
        ("python", ["python", "--version"]),
        ("python3", ["python3", "--version"]),
        ("node", ["node", "--version"]),
        ("git_bash", ["git", "--version"]),
    ]
    for key, cmd in probes:
        exe = shutil.which(cmd[0])
        if not exe:
            continue
        try:
            proc = subprocess.run(cmd, capture_output=True, text=True, timeout=5)
            version = (proc.stdout or proc.stderr or "").strip()
            normalized = "python" if key.startswith("python") else key
            if normalized not in result or not result[normalized].get("version"):
                result[normalized] = {"enabled": True, "path": exe, "version": version}
        except Exception:
            pass
    return result


# ── Config endpoints ──────────────────────────────────────────


class SecuritySettingsResponse(BaseModel):
    settings: dict[str, Any] = Field(default_factory=dict)
    defaults: dict[str, Any] = Field(default_factory=lambda: dict(DEFAULT_SECURITY_SETTINGS))


class SecuritySettingsPatchBody(BaseModel):
    settings: dict[str, Any] = Field(default_factory=dict)


class ExecutionSecurityPatchBody(BaseModel):
    """Editable host OS sandbox fields (persisted to SQLite ``execution.security``)."""

    enabled: bool | None = None
    profile: str | None = None
    approval: str | None = None
    windows_level: str | None = None
    allow_passthrough: bool | None = None
    auto_enable_when_helpers_ready: bool | None = None


def _merge_execution_security(settings: dict[str, Any]) -> dict[str, Any]:
    try:
        from evoflow.execution_security.status import execution_security_status

        return {**settings, "execution_security": execution_security_status()}
    except Exception:
        return settings


@router.get("/execution")
async def get_execution_security_status(request: Request) -> dict[str, Any]:
    """Host OS sandbox readiness + current profile (not a runtime product dependency)."""
    require_org_admin(request)
    from evoflow.execution_security.status import execution_security_status

    return execution_security_status()


@router.patch("/execution")
async def patch_execution_security(
    request: Request, body: ExecutionSecurityPatchBody
) -> dict[str, Any]:
    """Update host OS sandbox profile / enablement from Security Center."""
    require_org_admin(request)
    from evoflow.execution_security.persist import patch_execution_security_settings

    patch = body.model_dump(exclude_none=True)
    return patch_execution_security_settings(patch)


@router.get("", response_model=SecuritySettingsResponse)
async def get_security_center_settings(request: Request) -> SecuritySettingsResponse:
    require_org_admin(request)
    settings = get_security_settings()
    # Do NOT call _detect_runtime_versions() here — sequential subprocess probes
    # (python/node/git, timeout=5s each) blocked Security Center first paint for seconds.
    # Runtime paths/versions are optional metadata; UI does not need them to render.
    settings = _merge_execution_security(settings)
    return SecuritySettingsResponse(settings=settings)


@router.patch("", response_model=SecuritySettingsResponse)
async def patch_security_center_settings(
    request: Request, body: SecuritySettingsPatchBody
) -> SecuritySettingsResponse:
    require_org_admin(request)
    patch = dict(body.settings or {})
    # Allow nesting execution_security in the general PATCH for a single save path.
    exec_patch = patch.pop("execution_security", None)
    if isinstance(exec_patch, dict):
        from evoflow.execution_security.persist import patch_execution_security_settings

        patch_execution_security_settings(exec_patch)
    settings = patch_security_settings(patch) if patch else get_security_settings()
    return SecuritySettingsResponse(settings=_merge_execution_security(settings))


@router.put("", response_model=SecuritySettingsResponse)
async def put_security_center_settings(
    request: Request, body: SecuritySettingsPatchBody
) -> SecuritySettingsResponse:
    require_org_admin(request)
    return SecuritySettingsResponse(
        settings=_merge_execution_security(replace_security_settings(body.settings or {}))
    )


# ── Audit endpoints ──────────────────────────────────────────


class AuditListResponse(BaseModel):
    records: list[dict[str, Any]]
    total: int
    limit: int
    offset: int


@router.get("/audit", response_model=AuditListResponse)
async def list_security_audit(
    request: Request,
    limit: int = Query(default=200, ge=1, le=2000),
    offset: int = Query(default=0, ge=0),
    event_type: str = Query(default="", description="Filter by event type"),
) -> AuditListResponse:
    require_org_admin(request)
    records = list_all_sandbox_audit(limit=limit + 1, offset=offset, event_type=event_type or None)
    # We fetched limit+1 to know if there are more; trim to limit
    has_more = len(records) > limit
    records = records[:limit]
    return AuditListResponse(
        records=records,
        total=offset + len(records) + (1 if has_more else 0),
        limit=limit,
        offset=offset,
    )


@router.delete("/audit")
async def clear_security_audit(request: Request) -> dict[str, Any]:
    require_org_admin(request)
    deleted = clear_all_sandbox_audit()
    return {"deleted": deleted}


@router.get("/audit/export")
async def export_security_audit(request: Request) -> StreamingResponse:
    require_org_admin(request)
    records = list_all_sandbox_audit(limit=10000, offset=0)
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(
        [
            "id",
            "event_type",
            "path",
            "tool_name",
            "tool_call_id",
            "reason",
            "session_key",
            "thread_id",
            "created_at",
        ]
    )
    for r in records:
        writer.writerow(
            [
                r.get("id", ""),
                r.get("event_type", ""),
                r.get("path", ""),
                r.get("tool_name", ""),
                r.get("tool_call_id", ""),
                r.get("reason", ""),
                r.get("session_key", ""),
                r.get("thread_id", ""),
                r.get("created_at", ""),
            ]
        )
    buf.seek(0)
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=security-audit.csv"},
    )
