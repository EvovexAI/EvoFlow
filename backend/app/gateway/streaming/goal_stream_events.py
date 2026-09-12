"""Hosted session active check (UI polling / runtime-status)."""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)


def is_goal_active_for_session(session_key: str) -> bool:
    sk = str(session_key or "").strip()
    if not sk:
        return False
    try:
        from app.channels.services.goal_service import GoalService

        svc = GoalService._instance  # noqa: SLF001
        if svc is not None and svc.get_session_by_key(sk) is not None:
            return True
    except Exception:
        logger.debug("hosted active check (memory) failed sk=%s", sk, exc_info=True)
    try:
        from evoflow.persistence import goal_repositories as goal_repo

        row = goal_repo.load_goal_session(sk) or {}
        goal_status = str(row.get("goal_status") or "").strip().lower()
        enabled = bool(row.get("enabled"))
        status = str(row.get("status") or "").strip().lower()
        if goal_status in {"active", "paused"}:
            return True
        return enabled and status not in ("idle", "error", "")
    except Exception:
        logger.debug("hosted active check (db) failed sk=%s", sk, exc_info=True)
    return False
