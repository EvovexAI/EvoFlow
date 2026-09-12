"""Coalesce mission analysis when reads accumulate during a scheduled user turn."""

from __future__ import annotations

import logging

from evoflow.agents.message_analysis_utils import resolve_transcript_messages_for_analysis
from evoflow.agents.mission_state.config import MISSION_STATE_ENABLED, MISSION_STATE_INCLUDE_READ_REGISTRY
from evoflow.agents.mission_state.schedule_registry import is_turn_scheduled, scheduled_turn_key

logger = logging.getLogger(__name__)


def maybe_refresh_mission_on_read(thread_id: str) -> None:
    """Refresh debounced mission job with latest transcript + read registry (same user turn)."""
    if not MISSION_STATE_ENABLED or not MISSION_STATE_INCLUDE_READ_REGISTRY:
        return
    tid = str(thread_id or "").strip()
    if not tid or not is_turn_scheduled(tid):
        return

    turn_id = scheduled_turn_key(tid) or ""
    messages = resolve_transcript_messages_for_analysis(thread_id=tid, runtime_messages=[])

    from evoflow.agents.mission_state import get_mission_state_queue

    # Resolve session model_name from DB (refresh path has no runtime context)
    _model = None
    try:
        from evoflow.persistence.session_repositories import get_model_name_for_thread
        _model = get_model_name_for_thread(tid)
    except Exception:
        pass
    get_mission_state_queue().coalesce(
        thread_id=tid,
        messages=messages,
        turn_id=turn_id,
        mode="incremental",
        model_name=_model,
    )
    logger.debug("MissionState coalesce on read thread=%s turn=%s", tid, turn_id[:12] if turn_id else "")
