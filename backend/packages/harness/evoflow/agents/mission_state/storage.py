from __future__ import annotations

import logging
import threading
from datetime import UTC, datetime

from evoflow.agents.mission_state.models import MissionState
from evoflow.persistence import repositories as repo

logger = logging.getLogger(__name__)

_LOCKS: dict[str, threading.Lock] = {}
_LOCKS_GUARD = threading.Lock()


def _thread_lock(thread_id: str) -> threading.Lock:
    with _LOCKS_GUARD:
        if thread_id not in _LOCKS:
            _LOCKS[thread_id] = threading.Lock()
        return _LOCKS[thread_id]


def mission_state_file(thread_id: str):
    """Legacy helper — mission state is stored in SQLite, not a file path."""
    from pathlib import Path

    from evoflow.config.paths import get_paths

    return Path(get_paths().base_dir) / "mission_state" / f"{thread_id}.json"


def load_mission_state(thread_id: str) -> MissionState | None:
    try:
        from evoflow.persistence.mission_node_repositories import load_mission_state_from_nodes_if_current

        fast = load_mission_state_from_nodes_if_current(thread_id)
        if fast is not None:
            return fast
    except Exception:
        logger.debug("Fast mission_state load failed for %s", thread_id, exc_info=True)

    data = repo.load_mission_state_doc(thread_id)
    if not isinstance(data, dict):
        return None
    try:
        state = data.get("state", data)
        return MissionState.model_validate(state)
    except Exception as e:
        logger.warning("Failed to load mission_state for %s: %s", thread_id, e)
        return None


def save_mission_state(thread_id: str, state: MissionState, *, previous_turn_id: str | None = None) -> bool:
    lock = _thread_lock(thread_id)
    with lock:
        try:
            existing = load_mission_state(thread_id)
            if existing:
                if int(existing.ts_ms or 0) > int(state.ts_ms or 0):
                    return False
                if previous_turn_id and existing.turn_id and existing.turn_id != previous_turn_id:
                    return False

            wrapped = {
                "thread_id": thread_id,
                "updated_at": datetime.now(UTC).isoformat(),
                "version": max(1, int(getattr(state, "version", 1) or 1)),
                "state": state.model_dump(mode="json"),
            }
            repo.save_mission_state_doc(thread_id, wrapped)
            try:
                from evoflow.persistence.mission_node_repositories import sync_mission_nodes_from_state

                sync_mission_nodes_from_state(thread_id, state)
            except Exception:
                logger.warning("Failed to sync mission_nodes for %s", thread_id, exc_info=True)
            return True
        except Exception as e:
            logger.warning("Failed to save mission_state for %s: %s", thread_id, e)
            return False
