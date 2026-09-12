"""Meetings API router.

Endpoints:
- POST /api/meetings                  -> create a meeting
- GET  /api/meetings/{meeting_id}      -> get meeting details
- POST /api/meetings/{meeting_id}/discuss -> start a discussion round
- POST /api/meetings/{meeting_id}/mention -> @mention a specific participant
- GET  /api/meetings/{meeting_id}/turns  -> list discussion turns
- POST /api/meetings/{meeting_id}/conclude -> synthesize optimal plan from turns
"""

from __future__ import annotations

import json
import logging
import uuid
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from evoflow.a2a.agent_card import get_agent_card
from evoflow.a2a.orchestrator import (
    MeetingOrchestrator,
    create_meeting,
    get_meeting,
)
from evoflow.authz.http_guard import require_agent_visible, require_org_admin, require_session_visible
from evoflow.persistence.db import get_db
from evoflow.timeutil import utc_now_iso_z

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/meetings", tags=["meetings"])


# ── Request models ──────────────────────────────────────────


class CreateMeetingRequest(BaseModel):
    title: str = ""
    participants: list[str] = Field(default_factory=list)
    session_key: str = ""


class DiscussRequest(BaseModel):
    topic: str = ""
    speaker_order: list[str] | None = None
    allow_tools: bool = False


class MentionRequest(BaseModel):
    agent_code: str = ""
    text: str = ""
    context_summary: str = ""
    allow_tools: bool = False


class ConcludeRequest(BaseModel):
    topic: str = ""


# ── Endpoints ──────────────────────────────────────────────

def _require_meeting_visible(request: Request, meeting_id: str) -> dict[str, Any]:
    meeting = get_meeting(meeting_id)
    if not meeting:
        raise HTTPException(status_code=404, detail="meeting not found")
    sk = str(meeting.get("session_key") or "").strip()
    if sk:
        require_session_visible(request, sk)
        return meeting
    participants = meeting.get("participants") or []
    if not participants:
        require_org_admin(request)
        return meeting
    for code in participants:
        require_agent_visible(request, str(code or "").strip())
    return meeting



@router.post("")
async def create_meeting_endpoint(request: Request, req: CreateMeetingRequest) -> dict[str, Any]:
    """Create a new meeting session."""
    sk = str(req.session_key or "").strip()
    if sk:
        require_session_visible(request, sk)
    for code in req.participants or []:
        require_agent_visible(request, str(code or "").strip())
    meeting_id = f"mt_{uuid.uuid4().hex[:12]}"

    # Build participant metadata
    participants_meta: list[dict[str, Any]] = []
    for code in req.participants:
        card = get_agent_card(code)
        if card:
            participants_meta.append(
                {
                    "agent_code": code,
                    "role_name": card.get("name", code),
                    "agent_card": card,
                }
            )
        else:
            participants_meta.append(
                {"agent_code": code, "role_name": code, "agent_card": None}
            )

    create_meeting(
        meeting_id=meeting_id,
        session_key=req.session_key,
        title=req.title,
        participants=req.participants,
    )

    return {
        "meeting_id": meeting_id,
        "title": req.title,
        "participants": participants_meta,
        "status": "active",
    }


@router.get("/{meeting_id}")
async def get_meeting_endpoint(request: Request, meeting_id: str) -> dict[str, Any]:
    """Get meeting details including participants."""
    meeting = _require_meeting_visible(request, meeting_id)

    # Enrich participants with agent cards
    participants_meta: list[dict[str, Any]] = []
    for code in meeting.get("participants", []):
        card = get_agent_card(code)
        if card:
            participants_meta.append(
                {
                    "agent_code": code,
                    "role_name": card.get("name", code),
                    "agent_card": card,
                }
            )
        else:
            participants_meta.append(
                {"agent_code": code, "role_name": code, "agent_card": None}
            )

    meeting["participants"] = participants_meta
    return meeting


@router.post("/{meeting_id}/discuss")
async def start_discussion_endpoint(
    request: Request, meeting_id: str, req: DiscussRequest
) -> dict[str, Any]:
    """Start a discussion round. The orchestrator serially dispatches
    the topic to each participant in the background."""
    meeting = _require_meeting_visible(request, meeting_id)

    if not req.topic.strip():
        raise HTTPException(status_code=400, detail="topic is required")

    participants = meeting.get("participants", [])
    if not participants:
        raise HTTPException(status_code=400, detail="no participants in meeting")

    orchestrator = MeetingOrchestrator()
    result = await orchestrator.start_discussion(
        meeting_id=meeting_id,
        topic=req.topic,
        participants=participants,
        speaker_order=req.speaker_order,
        allow_tools=bool(req.allow_tools),
    )

    return result


@router.post("/{meeting_id}/mention")
async def meeting_mention_endpoint(
    request: Request, meeting_id: str, req: MentionRequest
) -> dict[str, Any]:
    """User @mentions a specific participant during a meeting."""
    meeting = _require_meeting_visible(request, meeting_id)

    if not req.agent_code or not req.text.strip():
        raise HTTPException(
            status_code=400, detail="agent_code and text are required"
        )

    orchestrator = MeetingOrchestrator()
    result = await orchestrator.send_mention(
        meeting_id=meeting_id,
        agent_code=req.agent_code,
        text=req.text,
        context_summary=str(req.context_summary or ""),
        allow_tools=bool(req.allow_tools),
    )

    if result.get("error"):
        raise HTTPException(status_code=409, detail=result["error"])

    return result


@router.get("/{meeting_id}/turns")
async def list_turns_endpoint(request: Request, meeting_id: str) -> dict[str, Any]:
    """List all discussion turns for a meeting."""
    _require_meeting_visible(request, meeting_id)
    rows = get_db().execute(
        """
        SELECT turn_id, meeting_id, topic, speaker_order, status, created_at
        FROM evoflow_meeting_turns
        WHERE meeting_id = ?
        ORDER BY created_at
        """,
        (meeting_id,),
    ).fetchall()

    turns = []
    for row in rows:
        d = dict(row)
        try:
            d["speaker_order"] = json.loads(d.get("speaker_order") or "[]")
        except Exception:
            d["speaker_order"] = []
        turns.append(d)

    return {"meeting_id": meeting_id, "turns": turns}


@router.get("/{meeting_id}/tasks")
async def list_meeting_tasks_endpoint(request: Request, meeting_id: str) -> dict[str, Any]:
    """List all A2A tasks associated with a meeting."""
    _require_meeting_visible(request, meeting_id)
    rows = get_db().execute(
        """
        SELECT task_id, agent_code, meeting_id, session_id, state,
               goal, context_summary, result_text, created_at, updated_at, completed_at
        FROM evoflow_a2a_tasks
        WHERE meeting_id = ?
        ORDER BY created_at
        """,
        (meeting_id,),
    ).fetchall()

    tasks = [dict(row) for row in rows]
    return {"meeting_id": meeting_id, "tasks": tasks}


@router.post("/{meeting_id}/conclude")
async def conclude_meeting_endpoint(
    request: Request, meeting_id: str, req: ConcludeRequest = ConcludeRequest()
) -> dict[str, Any]:
    """Synthesize an optimal plan from employee oral turns (host conclusion)."""
    from evoflow.a2a.meeting_conclude import conclude_meeting

    mid = str(meeting_id or "").strip()
    if not mid:
        raise HTTPException(status_code=422, detail="meeting_id required")
    meeting = _require_meeting_visible(request, mid)
    topic = str(req.topic or "").strip()
    result = await conclude_meeting(mid, topic=topic)
    if not result.get("ok"):
        raise HTTPException(status_code=400, detail=str(result.get("error") or "conclude failed"))
    return result
