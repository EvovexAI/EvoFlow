"""A2A Agent Server router.

Exposes A2A standard endpoints for each internal agent:
- GET  /.well-known/agent.json           -> discover all agents
- GET  /api/a2a/agents                   -> list agent cards
- GET  /api/a2a/{agent_code}/.well-known/agent.json -> single card
- POST /api/a2a/{agent_code}             -> JSON-RPC 2.0 (tasks/send|get|cancel)
- GET  /api/a2a/{agent_code}/tasks/{task_id}/stream  -> SSE streaming
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

from evoflow.a2a.agent_card import get_agent_card, list_agent_cards
from evoflow.authz.http_guard import require_agent_visible, resolve_authz_from_request
from evoflow.persistence import config_repositories as cfg_repo
from evoflow.a2a.adapter import (
    cancel_task,
    get_task,
    is_agent_busy,
    poll_new_messages,
    send_task,
)
from evoflow.a2a.models import JSONRPCRequest
from evoflow.timeutil import utc_now_iso_z

logger = logging.getLogger(__name__)

router = APIRouter(tags=["a2a"])


# ── Helpers ─────────────────────────────────────────────────


def _rpc_result(req_id: str | int | None, result: Any) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "result": result, "id": req_id}


def _rpc_error(
    req_id: str | int | None, code: int, message: str
) -> dict[str, Any]:
    return {
        "jsonrpc": "2.0",
        "error": {"code": code, "message": message},
        "id": req_id,
    }


# ── Agent Card discovery ────────────────────────────────────

def _filter_agent_cards(request: Request, cards: list[dict[str, Any]]) -> list[dict[str, Any]]:
    authz = resolve_authz_from_request(request)
    if authz.get("is_admin") or not str(authz.get("principal_id") or "").strip():
        return list(cards)
    out = []
    for card in cards:
        code = str((card or {}).get("agent_code") or (card or {}).get("name") or (card or {}).get("id") or "").strip()
        if not code:
            continue
        if cfg_repo.agent_visible_to_principal(
            code,
            str(authz.get("principal_id") or ""),
            is_admin=False,
            personal_scope=authz.get("personal_scope"),
            org_scope=authz.get("org_scope"),
        ):
            out.append(card)
    return out



@router.get("/.well-known/agent.json")
async def well_known_agent_card(request: Request) -> dict[str, Any]:
    """A2A standard: return all active agents' Agent Cards."""
    cards = _filter_agent_cards(request, list_agent_cards(status="active"))
    return {"agents": cards}


@router.get("/api/a2a/agents")
async def list_agents(request: Request) -> dict[str, Any]:
    """List all agent cards (for desktop panel)."""
    cards = _filter_agent_cards(request, list_agent_cards(status="active"))
    return {"agents": cards}


@router.get("/api/a2a/{agent_code}/.well-known/agent.json")
async def single_agent_card(request: Request, agent_code: str) -> Any:
    """Single agent's Agent Card."""
    require_agent_visible(request, agent_code)
    card = get_agent_card(agent_code)
    if not card:
        return JSONResponse(status_code=404, content={"error": "agent not found"})
    return card


# ── JSON-RPC 2.0 endpoint ───────────────────────────────────


@router.post("/api/a2a/{agent_code}")
async def a2a_jsonrpc(request: Request, agent_code: str, req: JSONRPCRequest) -> Any:
    """A2A JSON-RPC 2.0 endpoint.

    Supported methods:
    - tasks/send      Send message / create task
    - tasks/get       Query task status and messages
    - tasks/cancel    Cancel a task
    - tasks/subscribe Get SSE subscription URL
    """
    require_agent_visible(request, agent_code)
    if req.method == "tasks/send":
        return await _handle_tasks_send(agent_code, req)
    elif req.method == "tasks/get":
        return await _handle_tasks_get(agent_code, req)
    elif req.method == "tasks/cancel":
        return await _handle_tasks_cancel(agent_code, req)
    elif req.method == "tasks/subscribe":
        task_id = req.params.get("taskId", "")
        return _rpc_result(
            req.id,
            {
                "subscribeUrl": (
                    f"/api/a2a/{agent_code}/tasks/{task_id}/stream"
                )
            },
        )
    else:
        return _rpc_error(req.id, -32601, f"method not found: {req.method}")


async def _handle_tasks_send(agent_code: str, req: JSONRPCRequest) -> dict[str, Any]:
    """A2A tasks/send -> internal dispatch_task_fire_and_forget."""
    params = req.params
    session_id = params.get("sessionId", "")
    message = params.get("message", {})
    metadata = params.get("metadata", {})

    # Extract text from message parts
    goal_text = ""
    parts = message.get("parts", [])
    for part in parts:
        if isinstance(part, dict) and part.get("type") == "text":
            goal_text += part.get("text", "")

    if not goal_text.strip():
        return _rpc_error(req.id, -32602, "message text is required")

    context_summary = metadata.get("context_summary", "")
    from_agent = metadata.get("from_agent", "meeting_orchestrator")
    meeting_id = metadata.get("meeting_id", "")

    result = await send_task(
        agent_code=agent_code,
        session_id=session_id,
        message_text=goal_text,
        context_summary=context_summary,
        from_agent=from_agent,
        meeting_id=meeting_id,
    )

    if result.get("error") or result.get("busy"):
        # Agent busy or error -> return input-required
        return _rpc_result(
            req.id,
            {
                "task": {
                    "id": "",
                    "sessionId": session_id,
                    "status": {
                        "state": "input-required",
                        "timestamp": utc_now_iso_z(),
                        "message": {
                            "role": "agent",
                            "parts": [
                                {
                                    "type": "text",
                                    "text": result.get(
                                        "error", "agent is busy, try later"
                                    ),
                                }
                            ],
                        },
                    },
                }
            },
        )

    return _rpc_result(req.id, {"task": result.get("task", {})})


async def _handle_tasks_get(agent_code: str, req: JSONRPCRequest) -> dict[str, Any]:
    """A2A tasks/get -> query task status."""
    task_id = req.params.get("taskId", "")
    if not task_id:
        return _rpc_error(req.id, -32602, "taskId is required")

    result = get_task(agent_code, task_id)
    return _rpc_result(req.id, result)


async def _handle_tasks_cancel(
    agent_code: str, req: JSONRPCRequest
) -> dict[str, Any]:
    """A2A tasks/cancel -> cancel task."""
    task_id = req.params.get("taskId", "")
    if not task_id:
        return _rpc_error(req.id, -32602, "taskId is required")

    result = await cancel_task(agent_code, task_id)
    return _rpc_result(req.id, result)


# ── SSE streaming endpoint ──────────────────────────────────


@router.get("/api/a2a/{agent_code}/tasks/{task_id}/stream")
async def a2a_task_stream(request: Request, agent_code: str, task_id: str) -> StreamingResponse:
    """A2A SSE: subscribe to a Task's real-time updates.

    Polls the proactive session for new messages and emits A2A SSE events:
    - task:message    New message text (streaming delta)
    - task:artifact   Tool call / artifact
    - task:completed  Task completed
    - task:failed     Task failed
    """
    require_agent_visible(request, agent_code)

    async def event_generator():
        from evoflow.a2a.adapter import _get_a2a_task, _update_a2a_task_state

        last_seq = 0
        max_wait = 300  # 5 minute timeout
        elapsed = 0
        poll_interval = 1.5

        # Send initial connection event
        yield f"event: connected\ndata: {json.dumps({'taskId': task_id, 'agentCode': agent_code}, ensure_ascii=False)}\n\n"

        while elapsed < max_wait:
            # Poll for new messages
            events = poll_new_messages(agent_code, last_seq)
            for ev in events:
                last_seq = max(last_seq, ev.get("seq", last_seq))
                ev_data = ev["data"]
                ev_data["taskId"] = task_id
                yield f"event: {ev['event']}\ndata: {json.dumps(ev_data, ensure_ascii=False)}\n\n"

            # Check task completion
            busy = is_agent_busy(agent_code)
            task_record = _get_a2a_task(task_id)

            if task_record:
                state = task_record.get("state", "working")
                if state in ("completed", "failed", "canceled"):
                    # Emit completion event
                    completed_data = {
                        "taskId": task_id,
                        "agentCode": agent_code,
                        "status": {
                            "state": state,
                            "timestamp": utc_now_iso_z(),
                        },
                        "finalText": task_record.get("result_text", ""),
                    }
                    yield f"event: task:{'completed' if state == 'completed' else 'failed'}\ndata: {json.dumps(completed_data, ensure_ascii=False)}\n\n"
                    break
            elif not busy:
                # No task record but agent not busy -> assume completed
                _update_a2a_task_state(task_id, "completed")
                completed_data = {
                    "taskId": task_id,
                    "agentCode": agent_code,
                    "status": {
                        "state": "completed",
                        "timestamp": utc_now_iso_z(),
                    },
                }
                yield f"event: task:completed\ndata: {json.dumps(completed_data, ensure_ascii=False)}\n\n"
                break

            await asyncio.sleep(poll_interval)
            elapsed += poll_interval

        # Timeout
        if elapsed >= max_wait:
            timeout_data = {
                "taskId": task_id,
                "agentCode": agent_code,
                "error": "stream timeout",
            }
            yield f"event: task:failed\ndata: {json.dumps(timeout_data, ensure_ascii=False)}\n\n"

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
