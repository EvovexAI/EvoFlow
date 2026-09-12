"""Stop panel-attached runs when EvoPanel client restarts (backend source of truth)."""

from __future__ import annotations

import logging
from typing import Any

from evoflow.persistence.session_run_state import list_all_active_sessions
from evoflow.session_execution.panel_sessions import is_panel_attached_session_key

logger = logging.getLogger(__name__)


async def stop_all_panel_chat_sessions(*, reason: str = "client_disconnect") -> list[str]:
    """Cancel LangGraph + idle DB for active panel chat sessions."""
    from evoflow.session_execution.commands import stop_session_execution

    stopped: list[str] = []
    for row in list_all_active_sessions():
        sk = str(row.get("session_key") or "").strip()
        if not sk or not is_panel_attached_session_key(sk):
            continue
        try:
            await stop_session_execution(sk, user_initiated=False, reason=reason)
            stopped.append(sk)
            logger.info("panel chat stopped on %s session_key=%s", reason, sk)
        except Exception:
            logger.warning(
                "panel chat stop failed on %s session_key=%s",
                reason,
                sk,
                exc_info=True,
            )
    return stopped


async def stop_all_panel_attached_sessions(
    *,
    reason: str = "client_disconnect",
    goal_service: Any | None = None,
) -> dict[str, Any]:
    """Stop active panel chat runs and web-channel goal sessions."""
    chat_stopped = await stop_all_panel_chat_sessions(reason=reason)
    goal_stopped: list[str] = []
    if goal_service is not None:
        try:
            retire = getattr(goal_service, "retire_all_web_goals", None)
            if callable(retire):
                goal_stopped = await retire(reason=reason)
        except Exception:
            logger.warning("panel goal stop failed on %s", reason, exc_info=True)
    return {
        "chat_session_keys": chat_stopped,
        "goal_session_keys": goal_stopped,
        "reason": reason,
    }
