"""Meeting Orchestrator: A2A Client that serially dispatches tasks to participants.

Acts as the A2A Client described in the design doc. For each participant,
it sends an A2A Task (via the adapter's ``send_task``), waits for completion,
then passes the accumulated context to the next speaker.

The orchestration itself runs as a background ``asyncio.Task`` so the HTTP
caller gets an immediate response and subscribes to SSE for updates.
"""

from __future__ import annotations

import asyncio
import json
import logging
import uuid
from typing import Any

from evoflow.a2a.adapter import (
    _get_a2a_task,
    _update_a2a_task_state,
    extract_text_from_message,
    is_agent_busy,
    meeting_speak_mode,
    record_terminal_a2a_task,
    sanitize_meeting_reply,
    send_task,
)
from evoflow.persistence.chat_message_repositories import list_messages
from evoflow.persistence.db import get_db
from evoflow.proactive.repositories import ProactiveRepository
from evoflow.timeutil import utc_now_iso_z

logger = logging.getLogger(__name__)


# ── Meeting DB CRUD ────────────────────────────────────────


def create_meeting(
    meeting_id: str,
    session_key: str,
    title: str,
    participants: list[str],
) -> None:
    """Insert a meeting row."""
    now = utc_now_iso_z()
    participants_json = json.dumps(participants, ensure_ascii=False)
    get_db().execute(
        """
        INSERT INTO evoflow_meetings
            (meeting_id, session_key, title, participants, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'active', ?, ?)
        """,
        (meeting_id, session_key, title, participants_json, now, now),
    )
    get_db().commit()


def get_meeting(meeting_id: str) -> dict[str, Any] | None:
    """Fetch a meeting by ID."""
    row = get_db().execute(
        "SELECT * FROM evoflow_meetings WHERE meeting_id = ?",
        (meeting_id,),
    ).fetchone()
    if not row:
        return None
    d = dict(row)
    try:
        d["participants"] = json.loads(d.get("participants") or "[]")
    except Exception:
        d["participants"] = []
    raw_c = str(d.get("conclusion_json") or "").strip()
    if raw_c:
        try:
            d["conclusion"] = json.loads(raw_c)
        except Exception:
            d["conclusion"] = None
    else:
        d["conclusion"] = None
    return d


def update_meeting_status(meeting_id: str, status: str) -> None:
    """Update meeting status."""
    get_db().execute(
        "UPDATE evoflow_meetings SET status = ?, updated_at = ? WHERE meeting_id = ?",
        (status, utc_now_iso_z(), meeting_id),
    )
    get_db().commit()


def create_meeting_turn(
    meeting_id: str,
    topic: str,
    speaker_order: list[str],
) -> str:
    """Create a meeting turn (one round of discussion)."""
    turn_id = f"turn_{uuid.uuid4().hex[:12]}"
    now = utc_now_iso_z()
    get_db().execute(
        """
        INSERT INTO evoflow_meeting_turns
            (turn_id, meeting_id, topic, speaker_order, status, created_at)
        VALUES (?, ?, ?, ?, 'pending', ?)
        """,
        (turn_id, meeting_id, topic, json.dumps(speaker_order, ensure_ascii=False), now),
    )
    get_db().commit()
    return turn_id


def update_turn_status(turn_id: str, status: str) -> None:
    get_db().execute(
        "UPDATE evoflow_meeting_turns SET status = ? WHERE turn_id = ?",
        (status, turn_id),
    )
    get_db().commit()


# ── Orchestrator ──────────────────────────────────────────


def _append_meeting_context(
    prev: str,
    role_name: str,
    reply: str,
    *,
    mode: str,
) -> str:
    """Accumulate prior oral turns for later speakers (full room when debating)."""
    clip = 260 if mode in ("proposal", "rebuttal") else 120
    turn_line = f"【{role_name}】：{(reply or '（无内容）')[:clip]}"
    lines = [ln for ln in str(prev or "").splitlines() if ln.strip()]
    lines.append(turn_line)
    cap = 2800 if mode in ("proposal", "rebuttal") else 800
    joined = "\n".join(lines)
    while len(lines) > 1 and len(joined) > cap:
        lines.pop(0)
        joined = "\n".join(lines)
    return joined


class MeetingOrchestrator:
    """Serially dispatches A2A Tasks to meeting participants.

    Each participant gets the accumulated context from previous speakers.
    The orchestration runs as a background task; results are stored in DB
    and can be polled via SSE.
    """

    async def start_discussion(
        self,
        meeting_id: str,
        topic: str,
        participants: list[str],
        speaker_order: list[str] | None = None,
        *,
        allow_tools: bool = False,
    ) -> dict[str, Any]:
        """Run a discussion round: send topic to each participant serially.

        Returns immediately with turn_id + task_ids; the actual dispatch
        runs as a background asyncio task.
        """
        order = speaker_order or participants
        turn_id = create_meeting_turn(meeting_id, topic, order)

        # Spawn the serial dispatch in the background
        asyncio.create_task(
            self._run_discussion(
                meeting_id=meeting_id,
                turn_id=turn_id,
                topic=topic,
                speaker_order=order,
                allow_tools=bool(allow_tools),
            )
        )

        return {
            "meeting_id": meeting_id,
            "turn_id": turn_id,
            "topic": topic,
            "speaker_order": order,
            "status": "running",
            "allow_tools": bool(allow_tools),
        }

    async def _speak_one(
        self,
        *,
        meeting_id: str,
        agent_code: str,
        topic: str,
        context_summary: str,
        allow_tools: bool,
        results: list[dict[str, Any]],
        mode: str,
    ) -> str:
        """Dispatch one oral turn; append to results; return updated context."""
        role = ProactiveRepository.get_role(agent_code)
        role_name = role.role_name if role else agent_code
        task_id = ""
        try:
            task_result = await send_task(
                agent_code=agent_code,
                session_id=meeting_id,
                message_text=topic,
                context_summary=context_summary,
                from_agent="meeting_orchestrator",
                meeting_id=meeting_id,
                allow_tools=bool(allow_tools),
            )

            task = task_result.get("task") or {}
            task_id = str(task.get("id") or "")
            reply = sanitize_meeting_reply(
                str(task_result.get("reply") or task.get("result_text") or "")
            )

            if task_result.get("error") and not reply:
                err = str(task_result.get("error") or "speak failed")
                if not task_id:
                    task_id = record_terminal_a2a_task(
                        agent_code=agent_code,
                        meeting_id=meeting_id,
                        session_id=meeting_id,
                        goal=topic[:2000],
                        state="failed",
                        result_text=f"（未能发言）{err}",
                        context_summary=context_summary,
                    )
                results.append(
                    {
                        "agent_code": agent_code,
                        "role_name": role_name,
                        "task_id": task_id,
                        "reply": "",
                        "error": err,
                    }
                )
                return context_summary

            if not reply and task_id:
                stored = _get_a2a_task(task_id) or {}
                reply = sanitize_meeting_reply(str(stored.get("result_text") or ""))

            if task_id and reply:
                _update_a2a_task_state(task_id, "completed", result_text=reply)

            context_summary = _append_meeting_context(
                context_summary, role_name, reply, mode=mode
            )
            results.append(
                {
                    "agent_code": agent_code,
                    "role_name": role_name,
                    "task_id": task_id,
                    "reply": reply,
                }
            )
            await asyncio.sleep(0.4)
            return context_summary

        except Exception:
            logger.exception(
                "meeting.discussion error agent=%s meeting=%s",
                agent_code,
                meeting_id,
            )
            if task_id:
                _update_a2a_task_state(
                    task_id,
                    "failed",
                    result_text="（内部错误，发言中断）",
                )
            else:
                task_id = record_terminal_a2a_task(
                    agent_code=agent_code,
                    meeting_id=meeting_id,
                    session_id=meeting_id,
                    goal=topic[:2000],
                    state="failed",
                    result_text="（内部错误，发言中断）",
                    context_summary=context_summary,
                )
            results.append(
                {
                    "agent_code": agent_code,
                    "role_name": role_name,
                    "task_id": task_id,
                    "reply": "",
                    "error": "internal error",
                }
            )
            return context_summary

    async def _run_discussion(
        self,
        meeting_id: str,
        turn_id: str,
        topic: str,
        speaker_order: list[str],
        *,
        allow_tools: bool = False,
    ) -> None:
        """Background: serially ask each speaker, then optional rebuttal round."""
        mode = meeting_speak_mode(topic)
        context_summary = ""
        results: list[dict[str, Any]] = []

        for agent_code in speaker_order:
            context_summary = await self._speak_one(
                meeting_id=meeting_id,
                agent_code=agent_code,
                topic=topic,
                context_summary=context_summary,
                allow_tools=bool(allow_tools),
                results=results,
                mode=mode,
            )

        # Proposal rooms get a short second pass so people actually collide,
        # instead of each reading a one-shot position paper.
        ok_speakers = [r for r in results if (r.get("reply") or "").strip()]
        if mode == "proposal" and len(ok_speakers) >= 2:
            transcript = "\n".join(
                f"【{r.get('role_name') or r.get('agent_code')}】：{r.get('reply')}"
                for r in ok_speakers
            )
            rebuttal_topic = (
                f"{topic}\n\n"
                "【第二轮·碰撞】上面是第一轮发言。请只回应分歧："
                "同意谁/反对谁、你拍板的一点。不要复述全文，不要汇报自己任务。"
            )
            for agent_code in speaker_order:
                context_summary = await self._speak_one(
                    meeting_id=meeting_id,
                    agent_code=agent_code,
                    topic=rebuttal_topic,
                    context_summary=transcript[:2800],
                    allow_tools=False,
                    results=results,
                    mode="rebuttal",
                )

        update_turn_status(turn_id, "completed")

        logger.info(
            "meeting.discussion done meeting=%s turn=%s speakers=%d mode=%s",
            meeting_id,
            turn_id,
            len(results),
            mode,
        )

    async def _wait_for_completion(
        self,
        agent_code: str,
        task_id: str,
        timeout: int = 180,
    ) -> bool:
        """Poll until the agent is no longer busy or timeout.

        Returns True if timed out.
        """
        elapsed = 0.0
        poll_interval = 2.0
        # Brief grace so dispatch can mark the role busy
        await asyncio.sleep(0.4)
        while elapsed < timeout:
            if not is_agent_busy(agent_code):
                # Allow journal/message flush
                await asyncio.sleep(0.6)
                if not is_agent_busy(agent_code):
                    return False
            await asyncio.sleep(poll_interval)
            elapsed += poll_interval

        logger.warning(
            "meeting.wait_for_completion timeout agent=%s task=%s",
            agent_code,
            task_id,
        )
        return True

    def _collect_reply(self, agent_code: str) -> str:
        """Collect the latest assistant reply from the proactive session."""
        session_key = f"proactive:{agent_code}"
        messages = list_messages(session_key=session_key, limit=20)
        for msg in reversed(messages):
            if msg.get("role") == "assistant":
                text = extract_text_from_message(msg)
                if text:
                    return text
        return ""

    async def send_mention(
        self,
        meeting_id: str,
        agent_code: str,
        text: str,
        context_summary: str = "",
        *,
        allow_tools: bool = False,
    ) -> dict[str, Any]:
        """User @mentions a specific participant during a meeting."""
        role = ProactiveRepository.get_role(agent_code)
        if not role:
            return {"error": f"agent '{agent_code}' not found"}

        task_result = await send_task(
            agent_code=agent_code,
            session_id=meeting_id,
            message_text=text,
            context_summary=context_summary,
            from_agent="user",
            meeting_id=meeting_id,
            allow_tools=bool(allow_tools),
        )

        if task_result.get("error") and not (task_result.get("task") or {}).get("result_text"):
            return task_result

        task = task_result.get("task") or {}
        return {
            "agent_code": agent_code,
            "role_name": role.role_name,
            "task": task,
            "reply": task_result.get("reply") or task.get("result_text") or "",
        }
