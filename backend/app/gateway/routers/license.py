"""Product license activation + issued-code ledger API."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from evoflow.license.codec import (
    LicenseCodecError,
    code_fingerprint,
    issue_activation_code,
    resolve_bind_machine_id,
    verify_activation_code,
)
from evoflow.license.entitlements import (
    build_activated_state,
    get_license_status,
)
from evoflow.license.issued_store import (
    insert_issued_code,
    list_issued_codes,
    revoke_issued_code,
)
from evoflow.license.keys import can_issue_activation_codes
from evoflow.license.machine import get_machine_id, normalize_machine_id
from evoflow.license.store import clear_license_state, set_license_state

router = APIRouter(prefix="/api/license", tags=["license"])


class ActivateBody(BaseModel):
    code: str = Field(..., min_length=8, description="Activation code")


class LicenseStatusResponse(BaseModel):
    machine_id: str
    activated: bool
    expires_at: str | None = None
    features: list[str] = Field(default_factory=list)
    status: str
    activated_at: str | None = None
    premium: bool = False
    days_remaining: int | None = None
    duration_days: int | None = None


class IssueCodeBody(BaseModel):
    days: int | None = Field(None, ge=1, le=3650, description="Validity days from now")
    expires: str | None = Field(
        None,
        description="Absolute expiry as YYYY-MM-DD or ISO datetime (UTC end-of-day for date)",
    )
    issued_to: str = Field("", max_length=200, description="Customer / assignee label")
    note: str = Field("", max_length=2000, description="Ops note")
    machine_id: str = Field(
        "",
        max_length=64,
        description="Optional 16-hex machine id to pre-bind; empty = floating",
    )


def _parse_expires(value: str) -> int:
    text = str(value or "").strip()
    if not text:
        raise ValueError("empty expiry")
    if len(text) == 10 and text[4] == "-" and text[7] == "-":
        dt = datetime.fromisoformat(text).replace(
            hour=23, minute=59, second=59, tzinfo=UTC
        )
        return int(dt.timestamp())
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    dt = datetime.fromisoformat(text)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    return int(dt.astimezone(UTC).timestamp())


def _require_can_issue() -> None:
    if not can_issue_activation_codes():
        raise HTTPException(
            status_code=503,
            detail={
                "error": "no_private_key",
                "message": (
                    "未配置签发私钥：请设置 EVOFLOW_LICENSE_PRIVATE_KEY，"
                    "或放置 backend/.evoflow-license-private.key"
                ),
            },
        )


@router.get("/status", response_model=LicenseStatusResponse)
async def license_status() -> LicenseStatusResponse:
    # get_license_status → SQLite; never run on the event loop (schema/backfill can stall).
    import asyncio

    st = await asyncio.to_thread(get_license_status)
    return LicenseStatusResponse(**st.to_dict())


@router.post("/activate", response_model=LicenseStatusResponse)
async def license_activate(body: ActivateBody) -> LicenseStatusResponse:
    local_mid = get_machine_id()
    try:
        claims = verify_activation_code(
            body.code,
            expected_machine_id=local_mid,
        )
        bind_mid = resolve_bind_machine_id(claims, local_mid)
    except LicenseCodecError as e:
        raise HTTPException(
            status_code=400,
            detail={"error": e.code, "message": str(e)},
        ) from e

    state = build_activated_state(
        machine_id=bind_mid,
        expires_at_unix=claims.expires_at_unix,
        features=claims.features,
        code_fp=code_fingerprint(body.code),
    )
    set_license_state(state)
    st = get_license_status()
    return LicenseStatusResponse(**st.to_dict())


@router.post("/deactivate", response_model=LicenseStatusResponse)
async def license_deactivate() -> LicenseStatusResponse:
    clear_license_state()
    st = get_license_status()
    return LicenseStatusResponse(**st.to_dict())


@router.get("/codes/meta")
async def license_codes_meta() -> dict[str, Any]:
    return {
        "can_issue": can_issue_activation_codes(),
        "machine_id": get_machine_id(),
    }


@router.get("/codes")
async def license_codes_list(
    q: str = Query("", description="Search issued_to / note / machine_id / code"),
    status: str = Query(
        "",
        description="active | expired | revoked | expiring_soon | empty=all",
    ),
    limit: int = Query(200, ge=1, le=500),
    offset: int = Query(0, ge=0),
) -> dict[str, Any]:
    return list_issued_codes(q=q, status=status, limit=limit, offset=offset)


@router.post("/codes")
async def license_codes_issue(body: IssueCodeBody) -> dict[str, Any]:
    _require_can_issue()

    mid_arg = str(body.machine_id or "").strip()
    mid: str | None = None
    if mid_arg:
        mid = normalize_machine_id(mid_arg)
        if len(mid) != 16:
            raise HTTPException(
                status_code=400,
                detail={"error": "invalid_machine", "message": "machine_id 须为 16 位十六进制"},
            )

    if body.expires:
        try:
            exp = _parse_expires(body.expires)
        except ValueError as e:
            raise HTTPException(
                status_code=400,
                detail={"error": "invalid_expiry", "message": f"有效期无效: {e}"},
            ) from e
    else:
        days = int(body.days or 30)
        if days <= 0:
            raise HTTPException(
                status_code=400,
                detail={"error": "invalid_expiry", "message": "days 须 > 0"},
            )
        exp = int((datetime.now(UTC) + timedelta(days=days)).timestamp())

    try:
        code = issue_activation_code(machine_id=mid, expires_at_unix=exp)
    except LicenseCodecError as e:
        status = 503 if e.code == "no_private_key" else 400
        raise HTTPException(
            status_code=status,
            detail={"error": e.code, "message": str(e)},
        ) from e

    row = insert_issued_code(
        code=code,
        expires_at_unix=exp,
        issued_to=body.issued_to,
        note=body.note,
        machine_id=mid or "",
    )
    return {"item": row, "code": row.get("code") or code}


@router.post("/codes/{code_id}/revoke")
async def license_codes_revoke(code_id: str) -> dict[str, Any]:
    row = revoke_issued_code(code_id)
    if not row:
        raise HTTPException(
            status_code=404,
            detail={"error": "not_found", "message": "签发记录不存在"},
        )
    return {"item": row}
