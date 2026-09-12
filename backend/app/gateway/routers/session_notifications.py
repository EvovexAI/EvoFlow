"""REST API for persistent session notifications (``/api/session-notifications``)."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request
from pydantic import BaseModel, Field

from evoflow.authz.http_guard import require_session_visible, resolve_authz_from_request
from evoflow.authz.resource_visibility import stamp_kwargs_from_request
from evoflow.persistence.session_notification_repositories import (
    clear_all_session_notifications,
    clear_session_notifications,
    get_unread_count,
    list_session_notifications,
    mark_all_session_notifications_read,
    mark_session_notification_read,
    push_session_notification,
)

router = APIRouter(prefix="/api/session-notifications", tags=["session-notifications"])


class SessionNotificationListResponse(BaseModel):
    notifications: list[dict[str, Any]] = Field(default_factory=list)
    unread_count: int = 0


class PushNotificationBody(BaseModel):
    session_key: str = ""
    session_title: str = ""
    kind: str = "goal_closure"
    title: str = "通知"
    outcome: str = ""
    body: str = ""
    ts_ms: int | None = None
    notification_id: str = ""


class PushNotificationResponse(BaseModel):
    created: bool = False


class MarkReadBody(BaseModel):
    notification_id: str = ""


def _owner_kwargs(request: Request) -> dict[str, Any]:
    authz = resolve_authz_from_request(request)
    return {
        "created_by": str(authz.get("principal_id") or "").strip() or None,
        "is_admin": bool(authz.get("is_admin")),
    }


@router.get("", response_model=SessionNotificationListResponse)
async def get_session_notifications(request: Request) -> SessionNotificationListResponse:
    """List visible (non-cleared) notifications for the current principal."""
    kw = _owner_kwargs(request)
    return SessionNotificationListResponse(
        notifications=list_session_notifications(**kw),
        unread_count=get_unread_count(**kw),
    )


@router.post("", response_model=PushNotificationResponse)
async def create_session_notification(
    request: Request, body: PushNotificationBody
) -> PushNotificationResponse:
    """Push a notification. Server deduplicates by fingerprint (UNIQUE constraint)."""
    sk = str(body.session_key or "").strip()
    if sk:
        require_session_visible(request, sk)
    stamp = stamp_kwargs_from_request(request)
    created = push_session_notification(
        session_key=body.session_key,
        session_title=body.session_title,
        kind=body.kind,
        title=body.title,
        outcome=body.outcome,
        body=body.body,
        ts_ms=body.ts_ms,
        notification_id=body.notification_id,
        created_by=stamp.get("created_by"),
    )
    return PushNotificationResponse(created=created)


@router.patch("/read", response_model=dict)
async def mark_read(request: Request, body: MarkReadBody) -> dict[str, Any]:
    kw = _owner_kwargs(request)
    updated = mark_session_notification_read(body.notification_id, **kw)
    return {"updated": updated, "unread_count": get_unread_count(**kw)}


@router.patch("/read-all", response_model=dict)
async def mark_all_read(request: Request) -> dict[str, Any]:
    kw = _owner_kwargs(request)
    updated = mark_all_session_notifications_read(**kw)
    return {"updated": updated, "unread_count": get_unread_count(**kw)}


@router.delete("", response_model=dict)
async def clear_all(request: Request) -> dict[str, Any]:
    """Soft-delete visible notifications for the current principal."""
    kw = _owner_kwargs(request)
    deleted = clear_all_session_notifications(**kw)
    return {"deleted": deleted}


@router.delete("/session", response_model=dict)
async def clear_session(request: Request, session_key: str = "") -> dict[str, Any]:
    """Soft-delete all visible notifications for a specific session."""
    sk = str(session_key or "").strip()
    if sk:
        require_session_visible(request, sk)
    kw = _owner_kwargs(request)
    deleted = clear_session_notifications(sk, **kw)
    return {"deleted": deleted}
