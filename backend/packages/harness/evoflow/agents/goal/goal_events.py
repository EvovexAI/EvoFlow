"""Goal audit events (not public chat messages)."""

from __future__ import annotations

import uuid
from typing import Any

from evoflow.agents.goal.goal_state import GOAL_CONTROLLER_SOURCE


def new_goal_event(
    *,
    event_type: str,
    goal_id: str,
    goal_revision: int,
    content: str = "",
    created_by: str = GOAL_CONTROLLER_SOURCE,
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    evt: dict[str, Any] = {
        "event_id": f"evt_{uuid.uuid4().hex[:12]}",
        "event_type": event_type,
        "goal_id": goal_id,
        "goal_revision": int(goal_revision or 0),
        "content": str(content or ""),
        "created_by": created_by,
        "consumed": False,
    }
    if extra:
        evt.update(extra)
    return evt
