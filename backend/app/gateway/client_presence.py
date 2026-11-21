"""Track EvoPanel client instance; stop orphaned panel runs on gateway cold attach."""

from __future__ import annotations

import asyncio
import logging
import os

from evoflow.session_execution.client_cleanup import stop_all_panel_attached_sessions

logger = logging.getLogger(__name__)

_lock = asyncio.Lock()
_current_client_instance_id: str | None = None


def _env_flag(name: str, default: str = "false") -> bool:
    raw = (os.getenv(name, default) or default).strip().lower()
    return raw in {"1", "true", "yes", "on"}


def _client_restart_should_stop_runs() -> bool:
    """Opt-in legacy behavior: cancel panel runs when EvoPanel re-attaches with a new id."""
    return _env_flag("EVOFLOW_CLIENT_RESTART_STOP_RUNS", "false")


def _client_attach_should_stop_runs() -> bool:
    """Opt-in: cancel panel runs on gateway cold attach (no prior client id).

    Default **false**. Cold attach used to always stop panel runs; that races with
    「网关刚起来 → 用户立刻发消息」——2026-11-21 18:24 现场：client_attach 在发后 4s
    把正在流的一轮掐成 completedInterrupted，UI 还标成「用户停止」。孤儿清理改走
    zombie sweeper / 显式 opt-in。
    """
    return _env_flag("EVOFLOW_CLIENT_ATTACH_STOP_RUNS", "false")


async def attach_client_instance(client_instance_id: str) -> dict:
    """Register client process.

    * **client_attach** (gateway had no prior id): default **does not** cancel panel runs
      (see ``EVOFLOW_CLIENT_ATTACH_STOP_RUNS``).
    * **client_restart** (new EvoPanel instance id): default **does not** cancel LangGraph —
      the run keeps going and the UI reattaches via stream-resume. Set
      ``EVOFLOW_CLIENT_RESTART_STOP_RUNS=true`` to restore cancel-on-reload.
    """
    global _current_client_instance_id
    cid = str(client_instance_id or "").strip()
    if len(cid) < 8:
        raise ValueError("client_instance_id required")

    async with _lock:
        prev = _current_client_instance_id
        if prev == cid:
            return {
                "ok": True,
                "client_instance_id": cid,
                "reattached": True,
                "stopped": None,
                "cancel_skipped": False,
            }
        _current_client_instance_id = cid

    reason = "client_restart" if prev else "client_attach"
    logger.info(
        "EvoPanel client attach prev=%s next=%s reason=%s",
        prev or "(none)",
        cid,
        reason,
    )

    stopped = None
    cancel_skipped = False
    should_stop = (
        (reason == "client_attach" and _client_attach_should_stop_runs())
        or (reason == "client_restart" and _client_restart_should_stop_runs())
    )
    if should_stop:
        goal_service = None
        try:
            from langgraph_sdk import get_client

            from app.channels.manager import DEFAULT_LANGGRAPH_URL
            from app.channels.services.goal_service import GoalService

            langgraph_url = (os.getenv("EVOFLOW_LANGGRAPH_URL", DEFAULT_LANGGRAPH_URL) or "").rstrip("/") or DEFAULT_LANGGRAPH_URL
            langgraph_api_key = os.getenv("EVOFLOW_LANGGRAPH_API_KEY") or None
            lg_client = get_client(url=langgraph_url, api_key=langgraph_api_key)
            goal_service = GoalService.get_instance(lg_client)
        except Exception:
            logger.debug("goal service unavailable during client attach", exc_info=True)

        stopped = await stop_all_panel_attached_sessions(reason=reason, goal_service=goal_service)
    else:
        cancel_skipped = True
        logger.info(
            "EvoPanel %s: skipped panel run cancel (LangGraph continues; UI may stream-resume)",
            reason,
        )

    return {
        "ok": True,
        "client_instance_id": cid,
        "previous_client_instance_id": prev,
        "reattached": False,
        "reason": reason,
        "stopped": stopped,
        "cancel_skipped": cancel_skipped,
    }
