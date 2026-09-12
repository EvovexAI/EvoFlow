"""Business logic for collab peer messaging."""

from __future__ import annotations

import json
import logging
from datetime import UTC, datetime, timedelta
from typing import Any

from evoflow.collab.peer.thread_key import LEAD_PARTY, build_thread_key, resolve_subtask_ref
from evoflow.collab.sse_notify import broadcast_collab_peer_event
from evoflow.collab.storage import find_subtask_by_ids, get_project_storage, patch_collab_subtask_in_project_storage
from evoflow.collab.subtask_outcome import is_subtask_outcome_reported
from evoflow.persistence import peer_repositories as peer_repo
from evoflow.timeutil import utc_now_iso_z

logger = logging.getLogger(__name__)

_MAX_BODY = 4000
_MAX_PENDING_OUTBOUND = 3
_TERMINAL_SENDER = frozenset({"cancelled"})


def _visibility(from_party: str, to_subtask_id: str) -> list[str]:
    out = [from_party, to_subtask_id, LEAD_PARTY]
    seen: set[str] = set()
    ordered: list[str] = []
    for x in out:
        if x and x not in seen:
            seen.add(x)
            ordered.append(x)
    return ordered


def _subtask_row(storage: Any, main_task_id: str, subtask_id: str) -> dict[str, Any] | None:
    st = find_subtask_by_ids(storage, main_task_id, subtask_id)
    return st if isinstance(st, dict) else None


def _sender_may_ask(st: dict[str, Any] | None) -> tuple[bool, str]:
    if not st:
        return False, "sender subtask not found"
    status = str(st.get("status") or "pending").strip().lower()
    if status in _TERMINAL_SENDER:
        return False, f"sender status {status} cannot send peer messages"
    if is_subtask_outcome_reported(st) and status == "completed":
        return False, "completed subtasks cannot send peer messages; ask Lead to coordinate or retry_subtask"
    return True, ""


def _receiver_may_answer(st: dict[str, Any] | None) -> tuple[bool, str]:
    if not st:
        return False, "target subtask not found"
    status = str(st.get("status") or "pending").strip().lower()
    if status == "cancelled":
        return False, "target subtask is cancelled"
    return True, ""


def _bump_peer_state(storage: Any, main_task_id: str, subtask_id: str, *, outbound: int = 0, inbound: int = 0) -> None:
    st = _subtask_row(storage, main_task_id, subtask_id)
    if not st:
        return
    extra = st.get("extra_json")
    if isinstance(extra, str):
        try:
            extra = json.loads(extra)
        except json.JSONDecodeError:
            extra = {}
    if not isinstance(extra, dict):
        extra = {}
    peer_state = extra.get("peer_state")
    if not isinstance(peer_state, dict):
        peer_state = {}
    if outbound:
        peer_state["outbound_pending"] = max(0, int(peer_state.get("outbound_pending") or 0) + outbound)
    if inbound:
        peer_state["inbound_pending"] = max(0, int(peer_state.get("inbound_pending") or 0) + inbound)
    peer_state["last_peer_activity_at"] = utc_now_iso_z()
    extra["peer_state"] = peer_state
    patch_collab_subtask_in_project_storage(storage, main_task_id, subtask_id, {"extra_json": extra})


async def _send_message(
    *,
    main_task_id: str,
    from_party: str,
    to_token: str,
    body: str,
    expect_reply: bool = True,
) -> dict[str, Any]:
    mid = str(main_task_id or "").strip()
    text = str(body or "").strip()
    if not mid or not text:
        return {"ok": False, "error": "main_task_id and message body are required"}
    if len(text) > _MAX_BODY:
        return {"ok": False, "error": f"message exceeds {_MAX_BODY} characters"}

    storage = get_project_storage()
    from_party = str(from_party or "").strip()
    if from_party != LEAD_PARTY:
        ok, err = _sender_may_ask(_subtask_row(storage, mid, from_party))
        if not ok:
            return {"ok": False, "error": err}

    to_sid = resolve_subtask_ref(storage, mid, to_token, current_sid=from_party if from_party != LEAD_PARTY else "")
    if not to_sid:
        return {"ok": False, "error": f"could not resolve target subtask {to_token!r}"}
    if from_party == to_sid:
        return {"ok": False, "error": "cannot send peer message to yourself"}

    ok_recv, err_recv = _receiver_may_answer(_subtask_row(storage, mid, to_sid))
    if not ok_recv:
        return {"ok": False, "error": err_recv}

    if from_party != LEAD_PARTY:
        pending = peer_repo.count_pending_questions(mid, from_party)
        if pending >= _MAX_PENDING_OUTBOUND:
            return {"ok": False, "error": f"too many pending outbound peer questions (max {_MAX_PENDING_OUTBOUND})"}

    thread_key = build_thread_key(from_party, to_sid)
    now = utc_now_iso_z()
    expires = (datetime.now(UTC) + timedelta(minutes=30)).strftime("%Y-%m-%dT%H:%M:%SZ")
    message_id = peer_repo.insert_peer_message(
        {
            "main_task_id": mid,
            "thread_key": thread_key,
            "from_party": from_party,
            "to_subtask_id": to_sid,
            "direction": "question",
            "body": text,
            "status": "pending",
            "visibility_json": _visibility(from_party, to_sid),
            "created_at": now,
            "expires_at": expires,
        }
    )

    if from_party != LEAD_PARTY:
        _bump_peer_state(storage, mid, from_party, outbound=1)
    _bump_peer_state(storage, mid, to_sid, inbound=1)

    await broadcast_collab_peer_event(
        mid,
        "collab:peer_message",
        {
            "message_id": message_id,
            "thread_key": thread_key,
            "from_party": from_party,
            "to_subtask_id": to_sid,
        },
    )

    if expect_reply:
        from evoflow.collab.peer.scheduler import schedule_peer_wake

        schedule_peer_wake(
            main_task_id=mid,
            to_subtask_id=to_sid,
            thread_key=thread_key,
            trigger_message_id=message_id,
            reason="peer_question",
        )

    return {
        "ok": True,
        "messageId": message_id,
        "threadKey": thread_key,
        "toSubtaskId": to_sid,
    }


async def peer_send(
    *,
    main_task_id: str,
    from_subtask_id: str,
    to_subtask: str,
    message: str,
    expect_reply: bool = True,
) -> dict[str, Any]:
    return await _send_message(
        main_task_id=main_task_id,
        from_party=from_subtask_id,
        to_token=to_subtask,
        body=message,
        expect_reply=expect_reply,
    )


async def lead_peer_send(
    *,
    main_task_id: str,
    to_subtask: str,
    message: str,
    expect_reply: bool = True,
) -> dict[str, Any]:
    return await _send_message(
        main_task_id=main_task_id,
        from_party=LEAD_PARTY,
        to_token=to_subtask,
        body=message,
        expect_reply=expect_reply,
    )


async def peer_reply(
    *,
    main_task_id: str,
    subtask_id: str,
    in_reply_to: str,
    message: str,
) -> dict[str, Any]:
    mid = str(main_task_id or "").strip()
    sid = str(subtask_id or "").strip()
    text = str(message or "").strip()
    qid = str(in_reply_to or "").strip()
    if not mid or not sid or not text or not qid:
        return {"ok": False, "error": "main_task_id, subtask_id, in_reply_to, message are required"}
    if len(text) > _MAX_BODY:
        return {"ok": False, "error": f"message exceeds {_MAX_BODY} characters"}

    storage = get_project_storage()
    question = peer_repo.get_peer_message(qid)
    if not question or str(question.get("main_task_id") or "") != mid:
        return {"ok": False, "error": "question message not found"}
    if str(question.get("to_subtask_id") or "") != sid:
        return {"ok": False, "error": "only the target subtask may reply"}
    if str(question.get("status") or "") not in {"pending", "delivered"}:
        return {"ok": False, "error": "question is not awaiting reply"}

    from_party = str(question.get("from_party") or "")
    thread_key = str(question.get("thread_key") or build_thread_key(from_party, sid))
    now = utc_now_iso_z()
    reply_id = peer_repo.insert_peer_message(
        {
            "main_task_id": mid,
            "thread_key": thread_key,
            "from_party": sid,
            "to_subtask_id": from_party if from_party != LEAD_PARTY else sid,
            "direction": "reply",
            "body": text,
            "in_reply_to": qid,
            "status": "answered",
            "visibility_json": _visibility(from_party if from_party != LEAD_PARTY else sid, sid),
            "created_at": now,
            "answered_at": now,
        }
    )
    peer_repo.update_peer_message(qid, {"status": "answered", "answered_at": now})

    _bump_peer_state(storage, mid, sid, outbound=0, inbound=-1)

    await broadcast_collab_peer_event(
        mid,
        "collab:peer_reply",
        {
            "message_id": reply_id,
            "in_reply_to": qid,
            "thread_key": thread_key,
            "from_party": sid,
            "to_subtask_id": sid,
        },
    )

    if from_party != LEAD_PARTY:
        from evoflow.collab.peer.scheduler import schedule_peer_wake

        schedule_peer_wake(
            main_task_id=mid,
            to_subtask_id=from_party,
            thread_key=thread_key,
            trigger_message_id=reply_id,
            reason="peer_reply",
        )

    return {"ok": True, "messageId": reply_id, "threadKey": thread_key, "inReplyTo": qid}


def peer_read(
    *,
    main_task_id: str,
    reader_party: str,
    thread_key: str | None = None,
    limit: int = 20,
) -> dict[str, Any]:
    mid = str(main_task_id or "").strip()
    reader = str(reader_party or "").strip()
    if not mid or not reader:
        return {"ok": False, "error": "main_task_id and reader_party required"}

    all_msgs = peer_repo.list_peer_messages(mid, thread_key=thread_key, limit=max(limit, 50) * 3)
    threads: dict[str, list[dict[str, Any]]] = {}
    for msg in all_msgs:
        fp = str(msg.get("from_party") or "")
        to = str(msg.get("to_subtask_id") or "")
        tk = str(msg.get("thread_key") or "")
        if reader == LEAD_PARTY or reader in {fp, to}:
            threads.setdefault(tk, []).append(
                {
                    "messageId": msg.get("message_id"),
                    "direction": msg.get("direction"),
                    "fromParty": fp,
                    "toSubtaskId": to,
                    "body": msg.get("body"),
                    "status": msg.get("status"),
                    "inReplyTo": msg.get("in_reply_to"),
                    "createdAt": msg.get("created_at"),
                }
            )

    trimmed = {k: v[-limit:] for k, v in threads.items()}
    return {"ok": True, "threads": trimmed}
