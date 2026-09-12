"""Schedule peer wake on detached poll loop."""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)


def schedule_peer_wake(
    *,
    main_task_id: str,
    to_subtask_id: str,
    thread_key: str,
    trigger_message_id: str,
    reason: str,
) -> None:
    from evoflow.collab.peer.wake import wake_collab_subtask_for_peer

    async def _run() -> None:
        await wake_collab_subtask_for_peer(
            main_task_id=main_task_id,
            to_subtask_id=to_subtask_id,
            thread_key=thread_key,
            trigger_message_id=trigger_message_id,
            reason=reason,
        )

    from evoflow.subagents.detached_poll_scheduler import schedule_detached_poll

    schedule_detached_poll(_run(), name=f"collab-peer-wake-{to_subtask_id[:12]}")


def enqueue_peer_wake_if_busy(
    storage: Any,
    *,
    main_task_id: str,
    subtask_id: str,
    item: dict[str, Any],
) -> bool:
    """Append wake to subtask extra_json queue when executor is active. Returns True if queued."""
    from evoflow.collab.storage import find_subtask_by_ids, patch_collab_subtask_in_project_storage
    from evoflow.subagents.runtime_guard import is_subtask_background_executor_active

    st = find_subtask_by_ids(storage, main_task_id, subtask_id)
    if not st or not is_subtask_background_executor_active(st):
        return False
    extra = st.get("extra_json")
    if isinstance(extra, str):
        import json

        try:
            extra = json.loads(extra)
        except json.JSONDecodeError:
            extra = {}
    if not isinstance(extra, dict):
        extra = {}
    peer_q = extra.get("peer_wake_queue")
    if not isinstance(peer_q, list):
        peer_q = []
    peer_q.append(item)
    extra["peer_wake_queue"] = peer_q[-10:]
    patch_collab_subtask_in_project_storage(
        storage,
        main_task_id,
        subtask_id,
        {"extra_json": extra},
    )
    return True


def drain_peer_wake_queue(storage: Any, main_task_id: str, subtask_id: str) -> None:
    from evoflow.collab.storage import find_subtask_by_ids, patch_collab_subtask_in_project_storage

    st = find_subtask_by_ids(storage, main_task_id, subtask_id)
    if not st:
        return
    extra = st.get("extra_json")
    if isinstance(extra, str):
        import json

        try:
            extra = json.loads(extra)
        except json.JSONDecodeError:
            extra = {}
    if not isinstance(extra, dict):
        return
    peer_q = extra.pop("peer_wake_queue", None)
    if not isinstance(peer_q, list) or not peer_q:
        if extra != st.get("extra_json"):
            patch_collab_subtask_in_project_storage(storage, main_task_id, subtask_id, {"extra_json": extra})
        return
    patch_collab_subtask_in_project_storage(storage, main_task_id, subtask_id, {"extra_json": extra})
    for item in peer_q:
        if not isinstance(item, dict):
            continue
        schedule_peer_wake(
            main_task_id=main_task_id,
            to_subtask_id=subtask_id,
            thread_key=str(item.get("thread_key") or ""),
            trigger_message_id=str(item.get("trigger_message_id") or ""),
            reason=str(item.get("reason") or "queued"),
        )
