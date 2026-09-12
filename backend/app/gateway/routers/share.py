"""Read-only chat session share links (immutable snapshots)."""

from __future__ import annotations

import secrets
from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field

from evoflow.authz.http_guard import require_session_visible
from evoflow.authz.resource_visibility import stamp_kwargs_from_request
from evoflow.persistence import chat_message_repositories as msg_repo
from evoflow.persistence import chat_share_repositories as share_repo
from evoflow.persistence import session_repositories as sess_repo

router = APIRouter(prefix="/api/share", tags=["share"])


class CreateShareBody(BaseModel):
    session_key: str = Field(..., description="Sidebar session key to snapshot")
    expires_in_days: int | None = Field(
        default=7,
        description="Days until expiry; null = never expires",
    )
    include_tools: bool = Field(
        default=False,
        description="Include condensed tool rows in the snapshot",
    )


class CreateShareResponse(BaseModel):
    token: str
    url_path: str
    title: str
    created_at: str
    expires_at: str | None = None
    include_tools: bool = False
    message_count: int = 0


class PublicShareResponse(BaseModel):
    ok: bool = True
    title: str = ""
    created_at: str | None = None
    expires_at: str | None = None
    include_tools: bool = False
    messages: list[dict[str, Any]] = Field(default_factory=list)
    message_count: int = 0
    reason: str | None = None


@router.post("", response_model=CreateShareResponse)
async def create_share(request: Request, body: CreateShareBody) -> CreateShareResponse:
    sk = str(body.session_key or "").strip()
    if not sk:
        raise HTTPException(status_code=400, detail="session_key is required")
    require_session_visible(request, sk)
    row = sess_repo.get_session_row_for_ui(sk)
    if not row:
        raise HTTPException(status_code=404, detail="Session not found")
    title = str(row.get("title") or row.get("session_title") or "").strip() or "未命名会话"
    packed = msg_repo.list_messages_for_display_all(sk)
    raw_messages = list(packed.get("messages") or [])
    messages = share_repo.build_share_snapshot_messages(
        raw_messages,
        include_tools=bool(body.include_tools),
    )
    if not messages:
        raise HTTPException(status_code=400, detail="会话暂无可见消息，无法分享")
    token = secrets.token_urlsafe(24)
    stamp = stamp_kwargs_from_request(request)
    try:
        created = share_repo.create_share(
            token=token,
            session_key=sk,
            title=title,
            messages=messages,
            include_tools=bool(body.include_tools),
            expires_in_days=body.expires_in_days,
            created_by=stamp.get("created_by"),
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return CreateShareResponse(
        token=created["token"],
        url_path=f"/#/share/{created['token']}",
        title=created["title"],
        created_at=created["created_at"],
        expires_at=created.get("expires_at"),
        include_tools=bool(created.get("include_tools")),
        message_count=int(created.get("message_count") or 0),
    )


@router.get("/by-session/latest")
async def latest_share_for_session(
    request: Request,
    session_key: str = Query(..., description="Session key"),
) -> dict[str, Any]:
    """Latest share meta for a session (may be revoked/expired)."""
    sk = str(session_key or "").strip()
    if not sk:
        raise HTTPException(status_code=400, detail="session_key is required")
    require_session_visible(request, sk)
    row = share_repo.latest_share_for_session(sk)
    if not row:
        return {"ok": True, "share": None}
    return {
        "ok": True,
        "share": {
            "token": row["token"],
            "title": row.get("title"),
            "created_at": row.get("created_at"),
            "expires_at": row.get("expires_at"),
            "active": bool(row.get("active")),
            "status": row.get("status"),
            "url_path": f"/#/share/{row['token']}",
        },
    }


@router.get("/{token}", response_model=PublicShareResponse)
async def get_share(token: str) -> PublicShareResponse:
    data = share_repo.get_public_share(token)
    if data is None:
        raise HTTPException(status_code=404, detail="分享不存在或已失效")
    if not data.get("ok"):
        reason = str(data.get("reason") or "invalid")
        detail = "分享已撤销" if reason == "revoked" else "分享已过期"
        raise HTTPException(status_code=410, detail=detail)
    return PublicShareResponse(
        ok=True,
        title=str(data.get("title") or ""),
        created_at=data.get("created_at"),
        expires_at=data.get("expires_at"),
        include_tools=bool(data.get("include_tools")),
        messages=list(data.get("messages") or []),
        message_count=int(data.get("message_count") or 0),
    )


@router.delete("/{token}")
async def revoke_share(request: Request, token: str) -> dict[str, Any]:
    row = share_repo.get_share_row(token)
    if not row:
        raise HTTPException(status_code=404, detail="分享不存在")
    sk = str(row.get("session_key") or "").strip()
    if sk:
        require_session_visible(request, sk)
    ok = share_repo.revoke_share(token)
    if not ok:
        raise HTTPException(status_code=404, detail="分享不存在")
    return {"ok": True, "revoked": True, "token": str(token or "").strip()}
