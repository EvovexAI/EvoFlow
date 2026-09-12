"""Global + per-session tool approval policy API."""

from __future__ import annotations

from fastapi import Request, APIRouter, HTTPException
from evoflow.authz.http_guard import require_org_admin, require_session_visible
from pydantic import BaseModel, Field, AliasChoices, model_validator

from evoflow.execution_security.permission_preset import (
    VALID_PRESETS,
    preset_list_for_api,
)
from evoflow.persistence.permission_preset_store import (
    effective_preset,
    get_session_preset_raw,
    set_session_preset,
)
from evoflow.persistence.tool_approval_policy import (
    POLICY_GRANT_ALL,
    POLICY_PROMPT,
    POLICY_SESSION,
    VALID_POLICIES,
    effective_policy,
    get_global_default_policy,
    get_session_policy_raw,
    normalize_policy,
    set_global_default_policy,
    set_session_policy,
)

router = APIRouter(prefix="/api/settings", tags=["settings"])


class ToolApprovalPolicyResponse(BaseModel):
    default_policy: str = Field(..., description="Global default: prompt | session | grant_all")
    valid_policies: list[str] = Field(default_factory=lambda: [POLICY_PROMPT, POLICY_SESSION, POLICY_GRANT_ALL])
    permission_presets: list[dict[str, str]] = Field(default_factory=preset_list_for_api)


class ToolApprovalPolicyPatchBody(BaseModel):
    default_policy: str = Field(..., description="prompt | session | grant_all")


class SessionToolApprovalPolicyResponse(BaseModel):
    session_key: str
    tool_approval_policy: str | None = Field(
        None,
        description="Legacy session override; null = inherit global default",
    )
    effective_policy: str
    permission_preset: str | None = Field(
        None,
        description="runtime preset: read-only | default | full-access",
    )
    effective_permission_preset: str = Field(
        ...,
        description="Resolved runtime preset for UI",
    )


class SessionToolApprovalPolicyBody(BaseModel):
    tool_approval_policy: str | None = Field(
        None,
        description="Legacy: prompt | session | grant_all | null to clear override",
    )
    permission_preset: str | None = Field(
        None,
        description="runtime preset: read-only | default | full-access | null to clear",
        validation_alias=AliasChoices("permission_preset", "codex_permission_preset"),
    )

    @model_validator(mode="before")
    @classmethod
    def _accept_legacy_preset_key(cls, data):  # type: ignore[no-untyped-def]
        if isinstance(data, dict) and "permission_preset" not in data and "codex_permission_preset" in data:
            data = {**data, "permission_preset": data.get("codex_permission_preset")}
        return data


def _session_policy_response(sk: str) -> SessionToolApprovalPolicyResponse:
    return SessionToolApprovalPolicyResponse(
        session_key=sk,
        tool_approval_policy=get_session_policy_raw(sk),
        effective_policy=effective_policy(sk),
        permission_preset=get_session_preset_raw(sk),
        effective_permission_preset=effective_preset(sk),
    )


@router.get("/tool-approval", response_model=ToolApprovalPolicyResponse)
async def get_tool_approval_global_policy(request: Request) -> ToolApprovalPolicyResponse:
    require_org_admin(request)
    return ToolApprovalPolicyResponse(
        default_policy=get_global_default_policy(),
        valid_policies=sorted(VALID_POLICIES),
        permission_presets=preset_list_for_api(),
    )


@router.patch("/tool-approval", response_model=ToolApprovalPolicyResponse)
async def patch_tool_approval_global_policy(request: Request, body: ToolApprovalPolicyPatchBody) -> ToolApprovalPolicyResponse:
    require_org_admin(request)
    mode = normalize_policy(body.default_policy)
    if mode not in VALID_POLICIES:
        raise HTTPException(status_code=422, detail="default_policy must be prompt, session, or grant_all")
    set_global_default_policy(mode)
    return ToolApprovalPolicyResponse(
        default_policy=mode,
        valid_policies=sorted(VALID_POLICIES),
        permission_presets=preset_list_for_api(),
    )


@router.get(
    "/tool-approval/sessions/{session_key:path}",
    response_model=SessionToolApprovalPolicyResponse,
)
async def get_session_tool_approval_policy(request: Request, session_key: str) -> SessionToolApprovalPolicyResponse:
    require_session_visible(request, str(session_key or '').strip())
    sk = str(session_key or "").strip()
    if not sk:
        raise HTTPException(status_code=422, detail="session_key required")
    return _session_policy_response(sk)


@router.patch(
    "/tool-approval/sessions/{session_key:path}",
    response_model=SessionToolApprovalPolicyResponse,
)
async def patch_session_tool_approval_policy(request: Request, session_key: str,
    body: SessionToolApprovalPolicyBody,
) -> SessionToolApprovalPolicyResponse:
    require_session_visible(request, str(session_key or '').strip())
    sk = str(session_key or "").strip()
    if not sk:
        raise HTTPException(status_code=422, detail="session_key required")

    preset_raw = body.permission_preset
    if preset_raw is not None and str(preset_raw).strip():
        pid = str(preset_raw).strip().lower()
        if pid not in VALID_PRESETS:
            raise HTTPException(
                status_code=422,
                detail="permission_preset must be read-only, default, or full-access",
            )
        set_session_preset(sk, pid)
    elif preset_raw is not None and not str(preset_raw).strip():
        set_session_preset(sk, None)
        raw = body.tool_approval_policy
        if raw is not None and str(raw).strip():
            mode = normalize_policy(raw)
            if mode not in VALID_POLICIES:
                raise HTTPException(status_code=422, detail="tool_approval_policy must be prompt, session, or grant_all")
            set_session_policy(sk, mode)
        elif raw is None:
            set_session_policy(sk, None)
    else:
        raw = body.tool_approval_policy
        if raw is not None and str(raw).strip():
            mode = normalize_policy(raw)
            if mode not in VALID_POLICIES:
                raise HTTPException(status_code=422, detail="tool_approval_policy must be prompt, session, or grant_all")
            set_session_policy(sk, mode)
            # Legacy policy patch → sync runtime preset column for consistent UI
            from evoflow.execution_security.permission_preset import preset_from_legacy_tool_policy

            mapped = preset_from_legacy_tool_policy(mode)
            set_session_preset(sk, mapped)
        else:
            set_session_policy(sk, None)

    return _session_policy_response(sk)
