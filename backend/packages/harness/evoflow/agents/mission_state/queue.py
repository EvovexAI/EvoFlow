from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Literal

from evoflow.agents.mission_state.config import (
    MISSION_STATE_DEBOUNCE_SEC,
    MISSION_STATE_ENABLED,
    MISSION_STATE_RETRY_BASE_DELAY_SEC,
    MISSION_STATE_RETRY_ENABLED,
    MISSION_STATE_RETRY_IDLE_POLL_SEC,
    MISSION_STATE_RETRY_MAX_ATTEMPTS,
    MISSION_STATE_RETRY_MAX_DELAY_SEC,
)
from evoflow.agents.mission_state.retry_store import RetryItem, append_retry, pop_due_items, prune_retry_files
from evoflow.agents.mission_state.storage import load_mission_state, save_mission_state
from evoflow.agents.mission_state.updater import MissionStateUpdater

logger = logging.getLogger(__name__)

Mode = Literal["bootstrap", "incremental", "rebootstrap"]


@dataclass
class MissionContext:
    thread_id: str
    messages: list[Any]
    mode: Mode
    turn_id: str = ""
    model_name: str | None = None
    timestamp: datetime = datetime.now(UTC)


class MissionStateQueue:
    def __init__(self):
        self._queue: dict[str, MissionContext] = {}
        self._lock = threading.Lock()
        self._timer: threading.Timer | None = None
        self._processing = False
        self._retry_timer: threading.Timer | None = None
        self._ensure_retry_loop()

    def add(self, *, thread_id: str, messages: list[Any], mode: Mode, turn_id: str = "", model_name: str | None = None) -> None:
        if not MISSION_STATE_ENABLED:
            return
        with self._lock:
            self._queue[thread_id] = MissionContext(
                thread_id=thread_id,
                messages=messages,
                mode=mode,
                turn_id=turn_id,
                model_name=model_name,
            )
            # Each user turn schedules once after the first model reply; run immediately.
            if MISSION_STATE_DEBOUNCE_SEC <= 0:
                self._trigger_immediate()
            else:
                self._schedule_debounce()

    def coalesce(
        self,
        *,
        thread_id: str,
        messages: list[Any],
        turn_id: str = "",
        mode: Mode = "incremental",
        model_name: str | None = None,
    ) -> None:
        """Merge fresh transcript into a pending job and reset debounce (same user turn)."""
        if not MISSION_STATE_ENABLED:
            return
        tid = str(thread_id or "").strip()
        if not tid:
            return
        with self._lock:
            existing = self._queue.get(tid)
            if existing is not None:
                self._queue[tid] = MissionContext(
                    thread_id=tid,
                    messages=list(messages or []),
                    mode=existing.mode if existing.mode != "bootstrap" else mode,
                    turn_id=turn_id or existing.turn_id,
                    model_name=existing.model_name,
                )
            else:
                self._queue[tid] = MissionContext(
                    thread_id=tid,
                    messages=list(messages or []),
                    mode=mode,
                    turn_id=turn_id,
                    model_name=model_name,
                )
            if MISSION_STATE_DEBOUNCE_SEC <= 0:
                self._trigger_immediate()
            else:
                self._schedule_debounce()

    def _trigger_immediate(self) -> None:
        if self._processing:
            return
        t = threading.Thread(target=self._process_once, daemon=True)
        t.start()

    def _schedule_debounce(self) -> None:
        if self._timer is not None:
            self._timer.cancel()
        self._timer = threading.Timer(float(MISSION_STATE_DEBOUNCE_SEC), self._process_once)
        self._timer.daemon = True
        self._timer.start()

    def _ensure_retry_loop(self) -> None:
        if not MISSION_STATE_RETRY_ENABLED:
            return
        if self._retry_timer is not None:
            return
        delay = float(MISSION_STATE_RETRY_IDLE_POLL_SEC)
        self._retry_timer = threading.Timer(delay, self._process_retries)
        self._retry_timer.daemon = True
        self._retry_timer.start()

    def _schedule_next_retry_poll(self, *, delay_sec: float) -> None:
        if not MISSION_STATE_RETRY_ENABLED:
            self._retry_timer = None
            return
        delay = max(5.0, min(float(MISSION_STATE_RETRY_IDLE_POLL_SEC), float(delay_sec)))
        self._retry_timer = threading.Timer(delay, self._process_retries)
        self._retry_timer.daemon = True
        self._retry_timer.start()

    def _calc_backoff_sec(self, attempts: int) -> int:
        base = int(MISSION_STATE_RETRY_BASE_DELAY_SEC)
        mx = int(MISSION_STATE_RETRY_MAX_DELAY_SEC)
        # exponential: base * 2^attempts
        delay = base * (2 ** max(0, attempts))
        return max(base, min(mx, delay))

    def _schedule_retry(self, *, thread_id: str, mode: str, turn_id: str, messages: list[Any], attempts: int, error: str, model_name: str | None = None) -> None:
        if not MISSION_STATE_RETRY_ENABLED:
            return
        if MISSION_STATE_RETRY_MAX_ATTEMPTS <= 0:
            return
        if attempts >= int(MISSION_STATE_RETRY_MAX_ATTEMPTS):
            return
        delay_sec = self._calc_backoff_sec(attempts)
        next_ts = int(time.time() * 1000) + delay_sec * 1000
        append_retry(
            RetryItem(
                thread_id=thread_id,
                mode=mode,
                turn_id=turn_id,
                messages=messages,
                attempts=attempts + 1,
                next_run_ts_ms=next_ts,
                last_error=error,
                model_name=model_name,
            )
        )

    def _process_retries(self) -> None:
        from evoflow.observability.poll_loop_log import log_poll_tick

        log_poll_tick("mission_state_retry", key="global", interval_s=60.0)
        # Always reschedule itself
        try:
            if not MISSION_STATE_ENABLED:
                return
            if not MISSION_STATE_RETRY_ENABLED:
                return
            now_ms = int(time.time() * 1000)
            items = pop_due_items(now_ms, limit=10)  # cap per tick, consume due records
            for it in items:
                if it.attempts >= int(MISSION_STATE_RETRY_MAX_ATTEMPTS):
                    continue
                updater = MissionStateUpdater(model_name=it.model_name)
                prev = load_mission_state(it.thread_id)
                state = updater.update(thread_id=it.thread_id, messages=it.messages, previous=prev, mode=it.mode)
                if state is None:
                    self._schedule_retry(
                        thread_id=it.thread_id,
                        mode=it.mode,
                        turn_id=it.turn_id,
                        messages=it.messages,
                        attempts=it.attempts,
                        error="state_none",
                        model_name=it.model_name,
                    )
                    continue
                if it.turn_id:
                    state.turn_id = it.turn_id
                # CAS hint should be the turn_id observed at read time (prev), not current turn_id.
                # Passing current turn_id makes every normal next-turn write look "different" and be rejected.
                prev_turn_id = (prev.turn_id if prev else "") or None
                ok = save_mission_state(it.thread_id, state, previous_turn_id=prev_turn_id)
                if not ok:
                    self._schedule_retry(
                        thread_id=it.thread_id,
                        mode=it.mode,
                        turn_id=it.turn_id,
                        messages=it.messages,
                        attempts=it.attempts,
                        error="stale_write",
                        model_name=it.model_name,
                    )
            prune_retry_files()
        finally:
            delay_sec = float(MISSION_STATE_RETRY_IDLE_POLL_SEC)
            try:
                from evoflow.persistence.repositories import peek_next_mission_retry_delay_ms

                now_ms = int(time.time() * 1000)
                next_delay_ms = peek_next_mission_retry_delay_ms(now_ms)
                if next_delay_ms is None:
                    self._retry_timer = None
                    return
                delay_sec = max(5.0, min(float(MISSION_STATE_RETRY_IDLE_POLL_SEC), next_delay_ms / 1000.0))
            except Exception:
                pass
            self._schedule_next_retry_poll(delay_sec=delay_sec)

    def _process_once(self) -> None:
        from evoflow.observability.poll_loop_log import log_poll_loop_start

        if not MISSION_STATE_ENABLED:
            return
        with self._lock:
            if self._processing or not self._queue:
                return
            self._processing = True
            contexts = list(self._queue.values())
            self._queue.clear()
            self._timer = None
        log_poll_loop_start(
            "mission_state_debounce",
            threads=len(contexts),
        )
        try:
            for ctx in contexts:
                updater = MissionStateUpdater(model_name=ctx.model_name)
                prev = load_mission_state(ctx.thread_id)
                state = updater.update(thread_id=ctx.thread_id, messages=ctx.messages, previous=prev, mode=ctx.mode)
                if state is None:
                    self._schedule_retry(
                        thread_id=ctx.thread_id,
                        mode=ctx.mode,
                        turn_id=ctx.turn_id,
                        messages=ctx.messages,
                        attempts=0,
                        error="state_none",
                        model_name=ctx.model_name,
                    )
                    continue
                if ctx.turn_id:
                    state.turn_id = ctx.turn_id
                # CAS hint should reference the state snapshot we merged from (prev.turn_id).
                prev_turn_id = (prev.turn_id if prev else "") or None
                ok = save_mission_state(ctx.thread_id, state, previous_turn_id=prev_turn_id)
                if not ok:
                    logger.info("MissionState stale write skipped: thread=%s turn=%s", ctx.thread_id, ctx.turn_id)
                    self._schedule_retry(
                        thread_id=ctx.thread_id,
                        mode=ctx.mode,
                        turn_id=ctx.turn_id,
                        messages=ctx.messages,
                        attempts=0,
                        error="stale_write",
                        model_name=ctx.model_name,
                    )
                else:
                    logger.debug(
                        "MissionState write ok: thread=%s turn=%s mode=%s version=%s",
                        ctx.thread_id,
                        ctx.turn_id,
                        ctx.mode,
                        state.version,
                    )
                    from evoflow.agents.mission_state.schedule_registry import clear_turn_scheduled

                    clear_turn_scheduled(ctx.thread_id)
        finally:
            with self._lock:
                self._processing = False
                if self._queue:
                    if MISSION_STATE_DEBOUNCE_SEC <= 0:
                        self._trigger_immediate()
                    else:
                        self._schedule_debounce()


_queue_singleton: MissionStateQueue | None = None
_queue_guard = threading.Lock()


def get_mission_state_queue() -> MissionStateQueue:
    global _queue_singleton
    with _queue_guard:
        if _queue_singleton is None:
            _queue_singleton = MissionStateQueue()
        return _queue_singleton
