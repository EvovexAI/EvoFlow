"""In-process peer wake context for collab task_tool rounds."""

from __future__ import annotations

from typing import Any, Literal

PeerWakeMode = Literal["collaboration", "consultation"]

_PEER_WAKE: dict[tuple[str, str], dict[str, Any]] = {}


def set_peer_wake_context(
    main_task_id: str,
    subtask_id: str,
    *,
    thread_key: str,
    trigger_message_id: str,
    mode: PeerWakeMode,
) -> None:
    key = (str(main_task_id).strip(), str(subtask_id).strip())
    _PEER_WAKE[key] = {
        "thread_key": str(thread_key).strip(),
        "trigger_message_id": str(trigger_message_id).strip(),
        "mode": mode,
    }


def pop_peer_wake_context(main_task_id: str, subtask_id: str) -> dict[str, Any] | None:
    key = (str(main_task_id).strip(), str(subtask_id).strip())
    return _PEER_WAKE.pop(key, None)


def peek_peer_wake_context(main_task_id: str, subtask_id: str) -> dict[str, Any] | None:
    key = (str(main_task_id).strip(), str(subtask_id).strip())
    return _PEER_WAKE.get(key)
