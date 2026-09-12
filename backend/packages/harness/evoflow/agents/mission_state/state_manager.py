from __future__ import annotations

import threading
from dataclasses import dataclass
from typing import Literal

from evoflow.agents.mission_state.config import MISSION_STATE_DRIFT_CONSECUTIVE_THRESHOLD
from evoflow.persistence import task_repositories as task_repo

Mode = Literal["bootstrap", "incremental", "rebootstrap"]


@dataclass
class ThreadMissionRuntimeState:
    mode: Mode = "bootstrap"
    drift_count: int = 0
    chat_downgrade_streak: int = 0


_STATE: dict[str, ThreadMissionRuntimeState] = {}
_LOCK = threading.Lock()


def _load_persisted(thread_id: str) -> ThreadMissionRuntimeState | None:
    row = task_repo.load_mission_runtime(thread_id)
    if not row:
        return None
    try:
        return ThreadMissionRuntimeState(
            mode=str(row.get("mode") or "bootstrap"),  # type: ignore[arg-type]
            drift_count=max(0, int(row.get("drift_count") or 0)),
            chat_downgrade_streak=max(0, int(row.get("chat_downgrade_streak") or 0)),
        )
    except Exception:
        return None


def _save_persisted(thread_id: str, s: ThreadMissionRuntimeState) -> None:
    try:
        task_repo.save_mission_runtime(
            thread_id,
            mode=str(s.mode),
            drift_count=s.drift_count,
            chat_downgrade_streak=s.chat_downgrade_streak,
        )
    except Exception:
        pass


def reset_thread_state(thread_id: str) -> None:
    with _LOCK:
        s = ThreadMissionRuntimeState(mode="bootstrap", drift_count=0, chat_downgrade_streak=0)
        _STATE[thread_id] = s
        _save_persisted(thread_id, s)


def get_thread_state(thread_id: str) -> ThreadMissionRuntimeState:
    with _LOCK:
        if thread_id in _STATE:
            return _STATE[thread_id]
        persisted = _load_persisted(thread_id)
        _STATE[thread_id] = persisted or ThreadMissionRuntimeState()
        return _STATE[thread_id]


def decide_next_mode(thread_id: str, *, has_existing: bool, low_conf: bool, keyword_hit: bool) -> tuple[Mode, int]:
    with _LOCK:
        if thread_id not in _STATE:
            _STATE[thread_id] = _load_persisted(thread_id) or ThreadMissionRuntimeState()
        state = _STATE[thread_id]
        if not has_existing:
            state.mode = "bootstrap"
            state.drift_count = 0
            _save_persisted(thread_id, state)
            return "bootstrap", state.drift_count

        signal = low_conf or keyword_hit
        if signal:
            state.drift_count += 1
        else:
            state.drift_count = 0

        if state.drift_count >= MISSION_STATE_DRIFT_CONSECUTIVE_THRESHOLD:
            state.mode = "rebootstrap"
            state.drift_count = 0
            _save_persisted(thread_id, state)
            return "rebootstrap", MISSION_STATE_DRIFT_CONSECUTIVE_THRESHOLD

        state.mode = "incremental"
        _save_persisted(thread_id, state)
        return "incremental", state.drift_count


def stabilize_intent_transition(
    thread_id: str,
    *,
    previous_intent: str | None,
    candidate_intent: str | None,
    change_type: str,
    min_chat_rounds: int = 5,
) -> str:
    """Debounce non-chat -> chat downgrade to avoid aggressive tool shrink.

    Rule:
    - If previous intent is non-chat and candidate intent is chat, require
      `min_chat_rounds` consecutive chat candidates before accepting downgrade.
    - Any non-chat candidate resets the streak.
    - reset change_type bypasses debounce.
    - Supports comma-separated multi-scenario (e.g. "plan,web").
      A candidate is considered "chat" only when ALL parts are "chat".
    """
    prev = (previous_intent or "").strip().lower()
    cand = (candidate_intent or "").strip().lower() or "chat"

    cand_all_chat = all(p.strip() == "chat" for p in cand.split(",") if p.strip())
    prev_has_active = any(p.strip() != "chat" for p in prev.split(",") if p.strip())

    if change_type == "reset":
        with _LOCK:
            if thread_id not in _STATE:
                _STATE[thread_id] = _load_persisted(thread_id) or ThreadMissionRuntimeState()
            state = _STATE[thread_id]
            state.chat_downgrade_streak = 0
            _save_persisted(thread_id, state)
        return cand

    with _LOCK:
        if thread_id not in _STATE:
            _STATE[thread_id] = _load_persisted(thread_id) or ThreadMissionRuntimeState()
        state = _STATE[thread_id]
        if prev_has_active and cand_all_chat:
            state.chat_downgrade_streak += 1
            if state.chat_downgrade_streak < max(1, int(min_chat_rounds)):
                _save_persisted(thread_id, state)
                return prev
            state.chat_downgrade_streak = 0
            _save_persisted(thread_id, state)
            return "chat"
        state.chat_downgrade_streak = 0
        _save_persisted(thread_id, state)
        return cand or prev or "chat"
