"""Context compaction trigger policy — single place for threshold / cooldown / run cache.

Model-call path: ``build_ephemeral_model_messages`` → ``compaction_gate_status`` →
``CompactionTriggerCache.evaluate()`` (one decision per hop). ``compress_messages`` must
use ``skip_trigger_check=True`` when invoked from that pipeline.
"""

from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass
from typing import Any

from evoflow.utils.model_context_length import compression_threshold_tokens

logger = logging.getLogger(__name__)

POST_COMPRESS_REFILL_RATIO = 1.22
# Mid-turn (same user turn / tool hops): require a larger refill before another
# compress LLM call. 1.22 is too easy to hit after a couple of tool results on
# small context windows, which caused compress→main→compress thrashing.
SAME_TURN_REFILL_RATIO = 1.5
_STATE_TTL_SECONDS = 7200.0
_STATE_MAX_ENTRIES = 1024


def normalize_thread_id(thread_id: str) -> str:
    return str(thread_id or "").strip() or "default"


def _session_has_compaction_summary(session_key: str | None) -> bool:
    sk = str(session_key or "").strip()
    if not sk:
        return False
    try:
        from evoflow.persistence.chat_message_repositories import find_latest_compaction_seq

        return find_latest_compaction_seq(sk) is not None
    except Exception:
        return False


def run_id_from_context() -> str:
    """LangGraph ``configurable.run_id`` (may change per node — do not use alone for same-turn)."""
    try:
        from langgraph.config import get_config

        rid = str(get_config().get("configurable", {}).get("run_id") or "").strip()
        if rid:
            return rid
    except Exception:
        pass
    return ""


def resolve_turn_run_id(
    *,
    session_key: str | None = None,
    thread_id: str | None = None,
    run_id: str | None = None,
) -> tuple[str, str]:
    """Return ``(turn_run_id, langgraph_run_id)`` for same-user-turn detection.

    ``turn_run_id`` prefers the latest **user** message ``run_id`` (stable for the
    whole agent turn including tool hops). Session ``current_run_id`` is next;
    raw LangGraph ``configurable.run_id`` is only a last resort because it may
    change per model hop.
    """
    lg_rid = run_id_from_context()
    explicit = str(run_id or "").strip()
    if explicit:
        return explicit, lg_rid
    try:
        from evoflow.persistence.chat_message_repositories import latest_user_run_id
        from evoflow.persistence.session_run_state import peek_current_run_id

        sk = str(session_key or "").strip()
        if sk:
            user_turn = latest_user_run_id(sk, thread_id=thread_id)
            if user_turn:
                return str(user_turn).strip(), lg_rid
        turn = peek_current_run_id(session_key=session_key, thread_id=thread_id)
        if turn:
            return turn, lg_rid
    except Exception:
        logger.debug("resolve_turn_run_id failed session=%s thread=%s", session_key, thread_id, exc_info=True)
    if lg_rid:
        return lg_rid, lg_rid
    return "", lg_rid


def _same_turn_as_snapshot(
    snap: CompactionTriggerSnapshot | None,
    *,
    turn_run_id: str,
    in_cooldown: bool,
) -> bool:
    """True when this user turn already had a compress LLM call."""
    if snap is None:
        return False
    stored = str(snap.run_id or "").strip()
    current = str(turn_run_id or "").strip()
    if stored and current:
        return stored == current
    if not stored and not current:
        return in_cooldown
    return False


def log_compaction_trigger_decision(
    decision: CompactionTriggerDecision,
    *,
    thread_id: str,
    session_key: str = "",
    phase: str = "",
    turn_run_id: str = "",
    langgraph_run_id: str = "",
    snap_run_id: str = "",
    message_count: int = 0,
    force: bool = False,
    aggressive: bool = False,
    cooldown_seconds: float | None = None,
    context_length: int = 0,
) -> None:
    """Structured trigger decision → console + ``context-compaction.log``."""
    window = max(0, int(context_length or 0))
    tokens = max(0, int(decision.tokens))
    pct = round(tokens / window * 100.0, 1) if window > 0 else 0.0
    need = bool(decision.allow)
    # Always print the three fields the ops console needs for triage.
    logger.info(
        "[context-compaction] 压缩判定 tokens=%d/%d (%.1f%%) need_compress=%s "
        "threshold=%d reason=%s phase=%s thread=%s msgs=%d",
        tokens,
        window,
        pct,
        "yes" if need else "no",
        int(decision.threshold),
        decision.reason,
        phase or "evaluate",
        (thread_id or "")[:16],
        message_count,
    )
    try:
        from evoflow.observability.compaction_file_log import log_compaction_trace

        refill_floor = (
            int(decision.after_gate_tokens * POST_COMPRESS_REFILL_RATIO)
            if decision.after_gate_tokens > 0
            else None
        )
        same_turn_refill = (
            int(decision.after_gate_tokens * SAME_TURN_REFILL_RATIO)
            if decision.after_gate_tokens > 0
            else None
        )
        log_compaction_trace(
            "触发判断",
            thread_id=thread_id,
            session_key=session_key,
            phase=phase or "evaluate",
            force=force,
            allow_compress=decision.allow,
            need_compress=need,
            trigger_reason=decision.reason,
            turn_run_id=turn_run_id or None,
            langgraph_run_id=langgraph_run_id or None,
            snap_run_id=snap_run_id or None,
            same_turn=decision.same_run,
            in_cooldown=decision.in_cooldown,
            cooldown_seconds=cooldown_seconds if cooldown_seconds is not None else None,
            cooldown_remaining_s=round(decision.cooldown_remaining_s, 1) if decision.cooldown_remaining_s else None,
            gate_tokens=decision.tokens,
            context_length=window or None,
            occupancy_pct=pct,
            threshold=decision.threshold,
            aggressive_threshold=decision.aggressive_threshold,
            after_gate_tokens=decision.after_gate_tokens or None,
            refill_floor=refill_floor,
            same_turn_refill_floor=same_turn_refill,
            round_trigger=decision.round_trigger,
            message_count=message_count,
            aggressive_pass=aggressive,
        )
    except Exception:
        logger.debug("compaction trigger trace log failed", exc_info=True)


def message_count_triggers_compaction(
    message_count: int,
    *,
    compaction_trigger_message_count: int = 0,
) -> bool:
    """Always False — compaction is token-window only (runtime-aligned).

    ``compaction_trigger_message_count`` remains in config for compatibility but
    is ignored. Message count must not allow or force a compress LLM call.
    """
    _ = (message_count, compaction_trigger_message_count)
    return False


def round_trigger_rearm_delta(*, compaction_trigger_message_count: int = 0) -> int:
    _ = compaction_trigger_message_count
    return 0


def round_trigger_rearmed(
    message_count: int,
    *,
    compaction_trigger_message_count: int,
    last_compress_message_count: int,
) -> bool:
    """Disabled — see ``message_count_triggers_compaction``."""
    _ = (message_count, compaction_trigger_message_count, last_compress_message_count)
    return False


@dataclass(frozen=True)
class CompactionTriggerSnapshot:
    run_id: str
    before_gate_tokens: int
    after_gate_tokens: int
    message_count: int
    monotonic_at: float


@dataclass(frozen=True)
class CompactionTriggerDecision:
    allow: bool
    reason: str
    tokens: int
    threshold: int
    aggressive_threshold: int
    in_cooldown: bool
    same_run: bool
    round_trigger: bool
    after_gate_tokens: int = 0
    cooldown_remaining_s: float = 0.0

    def to_log_fields(self) -> dict[str, Any]:
        return {
            "allow": self.allow,
            "reason": self.reason,
            "tokens": self.tokens,
            "threshold": self.threshold,
            "in_cooldown": self.in_cooldown,
            "same_run": self.same_run,
            "round_trigger": self.round_trigger,
            "after_gate_tokens": self.after_gate_tokens or None,
            "cooldown_remaining_s": round(self.cooldown_remaining_s, 1) if self.cooldown_remaining_s else None,
        }


class CompactionTriggerCache:
    """Per-thread compress snapshots (cooldown + post-compress gate baseline)."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._snapshots: dict[str, CompactionTriggerSnapshot] = {}
        self._in_flight: set[str] = set()

    def _evict_stale_locked(self) -> None:
        if not self._snapshots:
            return
        now = time.monotonic()
        stale = [tid for tid, snap in self._snapshots.items() if (now - snap.monotonic_at) > _STATE_TTL_SECONDS]
        for tid in stale:
            self._snapshots.pop(tid, None)
        overflow = len(self._snapshots) - _STATE_MAX_ENTRIES
        if overflow > 0:
            ordered = sorted(self._snapshots.items(), key=lambda kv: kv[1].monotonic_at)
            for tid, _ in ordered[:overflow]:
                self._snapshots.pop(tid, None)

    def snapshot(self, thread_id: str) -> CompactionTriggerSnapshot | None:
        tid = normalize_thread_id(thread_id)
        with self._lock:
            return self._snapshots.get(tid)

    def record_compress(
        self,
        thread_id: str,
        *,
        run_id: str | None = None,
        session_key: str | None = None,
        before_gate_tokens: int,
        after_gate_tokens: int,
        message_count: int,
    ) -> None:
        tid = normalize_thread_id(thread_id)
        turn_rid, lg_rid = resolve_turn_run_id(
            session_key=session_key,
            thread_id=tid,
            run_id=run_id,
        )
        snap = CompactionTriggerSnapshot(
            run_id=turn_rid,
            before_gate_tokens=max(0, int(before_gate_tokens)),
            after_gate_tokens=max(0, int(after_gate_tokens)),
            message_count=max(0, int(message_count)),
            monotonic_at=time.monotonic(),
        )
        with self._lock:
            self._snapshots[tid] = snap
            self._evict_stale_locked()
        log_compaction_trigger_decision(
            CompactionTriggerDecision(
                allow=True,
                reason="compress_completed",
                tokens=after_gate_tokens,
                threshold=0,
                aggressive_threshold=0,
                in_cooldown=False,
                same_run=False,
                round_trigger=False,
                after_gate_tokens=after_gate_tokens,
            ),
            thread_id=tid,
            session_key=str(session_key or ""),
            phase="record_compress",
            turn_run_id=turn_rid,
            langgraph_run_id=lg_rid,
            snap_run_id=turn_rid,
            message_count=message_count,
        )

    def cooldown_remaining(self, thread_id: str, *, cooldown_seconds: float) -> float:
        if cooldown_seconds <= 0:
            return 0.0
        snap = self.snapshot(thread_id)
        if snap is None:
            return 0.0
        return max(0.0, cooldown_seconds - (time.monotonic() - snap.monotonic_at))

    def cooldown_active(self, thread_id: str, *, cooldown_seconds: float) -> bool:
        return self.cooldown_remaining(thread_id, cooldown_seconds=cooldown_seconds) > 0

    def compress_in_flight(self, thread_id: str) -> bool:
        tid = normalize_thread_id(thread_id)
        with self._lock:
            return tid in self._in_flight

    def try_acquire_compress(self, thread_id: str) -> bool:
        tid = normalize_thread_id(thread_id)
        with self._lock:
            if tid in self._in_flight:
                return False
            self._in_flight.add(tid)
            return True

    def release_compress(self, thread_id: str) -> None:
        tid = normalize_thread_id(thread_id)
        with self._lock:
            self._in_flight.discard(tid)

    def evaluate(
        self,
        *,
        thread_id: str,
        tokens: int,
        message_count: int,
        min_messages: int,
        context_length: int,
        threshold_ratio: float,
        aggressive_ratio: float,
        force: bool = False,
        aggressive: bool = False,
        compaction_cooldown_seconds: float = 0.0,
        compaction_hysteresis_enabled: bool = False,
        compaction_trigger_message_count: int = 0,
        run_id: str | None = None,
        session_key: str | None = None,
        log_phase: str = "",
    ) -> CompactionTriggerDecision:
        tid = normalize_thread_id(thread_id)
        turn_rid, lg_rid = resolve_turn_run_id(
            session_key=session_key,
            thread_id=tid,
            run_id=run_id,
        )
        threshold = compression_threshold_tokens(
            context_length,
            aggressive=False,
            threshold_ratio=threshold_ratio,
            aggressive_ratio=aggressive_ratio,
        )
        aggressive_threshold = compression_threshold_tokens(
            context_length,
            aggressive=True,
            threshold_ratio=threshold_ratio,
            aggressive_ratio=aggressive_ratio,
        )
        snap = self.snapshot(tid)
        last_msg_count = snap.message_count if snap is not None else 0
        round_trigger = round_trigger_rearmed(
            message_count,
            compaction_trigger_message_count=compaction_trigger_message_count,
            last_compress_message_count=last_msg_count,
        )
        after_gate = snap.after_gate_tokens if snap is not None else 0
        in_cooldown = compaction_cooldown_seconds > 0 and self.cooldown_active(
            tid,
            cooldown_seconds=compaction_cooldown_seconds,
        )
        cooldown_remaining = self.cooldown_remaining(tid, cooldown_seconds=compaction_cooldown_seconds)
        same_run = _same_turn_as_snapshot(snap, turn_run_id=turn_rid, in_cooldown=in_cooldown)
        snap_run_id = str(snap.run_id or "").strip() if snap is not None else ""

        def _done(decision: CompactionTriggerDecision) -> CompactionTriggerDecision:
            log_compaction_trigger_decision(
                decision,
                thread_id=tid,
                session_key=str(session_key or ""),
                phase=log_phase,
                turn_run_id=turn_rid,
                langgraph_run_id=lg_rid,
                snap_run_id=snap_run_id,
                message_count=message_count,
                force=force,
                aggressive=aggressive,
                cooldown_seconds=compaction_cooldown_seconds,
                context_length=context_length,
            )
            return decision

        refill_eligible = (
            in_cooldown
            and not same_run
            and after_gate > 0
            and tokens >= int(after_gate * POST_COMPRESS_REFILL_RATIO)
        )
        refill_floor = int(after_gate * POST_COMPRESS_REFILL_RATIO) if after_gate > 0 else 0
        db_summary = _session_has_compaction_summary(session_key)

        if message_count < min_messages:
            return _done(
                CompactionTriggerDecision(
                    allow=False,
                    reason=f"message_count {message_count} < min {min_messages}",
                    tokens=tokens,
                    threshold=threshold,
                    aggressive_threshold=aggressive_threshold,
                    in_cooldown=in_cooldown,
                    same_run=same_run,
                    round_trigger=round_trigger,
                    after_gate_tokens=after_gate,
                    cooldown_remaining_s=cooldown_remaining,
                )
            )

        if not round_trigger and tokens < threshold and not refill_eligible:
            return _done(
                CompactionTriggerDecision(
                    allow=False,
                    reason=f"tokens {tokens} < threshold {threshold}",
                    tokens=tokens,
                    threshold=threshold,
                    aggressive_threshold=aggressive_threshold,
                    in_cooldown=in_cooldown,
                    same_run=same_run,
                    round_trigger=round_trigger,
                    after_gate_tokens=after_gate,
                    cooldown_remaining_s=cooldown_remaining,
                )
            )

        if (
            db_summary
            and after_gate > 0
            and tokens < refill_floor
            and not force
            and not aggressive
        ):
            return _done(
                CompactionTriggerDecision(
                    allow=False,
                    reason="summary_present_awaiting_refill",
                    tokens=tokens,
                    threshold=threshold,
                    aggressive_threshold=aggressive_threshold,
                    in_cooldown=in_cooldown,
                    same_run=same_run,
                    round_trigger=round_trigger,
                    after_gate_tokens=after_gate,
                    cooldown_remaining_s=cooldown_remaining,
                )
            )

        if force or aggressive:
            return _done(
                CompactionTriggerDecision(
                    allow=True,
                    reason="force" if force else "aggressive_pass",
                    tokens=tokens,
                    threshold=threshold,
                    aggressive_threshold=aggressive_threshold,
                    in_cooldown=in_cooldown,
                    same_run=same_run,
                    round_trigger=round_trigger,
                    after_gate_tokens=after_gate,
                    cooldown_remaining_s=cooldown_remaining,
                )
            )

        if same_run:
            same_turn_refill = (
                int(after_gate * SAME_TURN_REFILL_RATIO) if after_gate > 0 else aggressive_threshold + 1
            )
            if tokens >= aggressive_threshold and after_gate > 0 and tokens >= same_turn_refill:
                return _done(
                    CompactionTriggerDecision(
                        allow=True,
                        reason="same_turn_over_aggressive_threshold",
                        tokens=tokens,
                        threshold=threshold,
                        aggressive_threshold=aggressive_threshold,
                        in_cooldown=in_cooldown,
                        same_run=True,
                        round_trigger=round_trigger,
                        after_gate_tokens=after_gate,
                        cooldown_remaining_s=cooldown_remaining,
                    )
                )
            if tokens >= aggressive_threshold and after_gate > 0:
                return _done(
                    CompactionTriggerDecision(
                        allow=False,
                        reason="same_turn_still_hot_no_refill",
                        tokens=tokens,
                        threshold=threshold,
                        aggressive_threshold=aggressive_threshold,
                        in_cooldown=in_cooldown,
                        same_run=True,
                        round_trigger=round_trigger,
                        after_gate_tokens=after_gate,
                        cooldown_remaining_s=cooldown_remaining,
                    )
                )
            return _done(
                CompactionTriggerDecision(
                    allow=False,
                    reason="same_turn_already_compressed",
                    tokens=tokens,
                    threshold=threshold,
                    aggressive_threshold=aggressive_threshold,
                    in_cooldown=in_cooldown,
                    same_run=True,
                    round_trigger=round_trigger,
                    after_gate_tokens=after_gate,
                    cooldown_remaining_s=cooldown_remaining,
                )
            )

        if in_cooldown:
            if round_trigger:
                return _done(
                    CompactionTriggerDecision(
                        allow=True,
                        reason="round_trigger_rearm",
                        tokens=tokens,
                        threshold=threshold,
                        aggressive_threshold=aggressive_threshold,
                        in_cooldown=True,
                        same_run=same_run,
                        round_trigger=True,
                        after_gate_tokens=after_gate,
                        cooldown_remaining_s=cooldown_remaining,
                    )
                )
            if refill_eligible:
                return _done(
                    CompactionTriggerDecision(
                        allow=True,
                        reason="post_compress_refill",
                        tokens=tokens,
                        threshold=threshold,
                        aggressive_threshold=aggressive_threshold,
                        in_cooldown=True,
                        same_run=same_run,
                        round_trigger=round_trigger,
                        after_gate_tokens=after_gate,
                        cooldown_remaining_s=cooldown_remaining,
                    )
                )
            if not same_run:
                if compaction_hysteresis_enabled and tokens >= aggressive_threshold:
                    return _done(
                        CompactionTriggerDecision(
                            allow=True,
                            reason="aggressive_threshold",
                            tokens=tokens,
                            threshold=threshold,
                            aggressive_threshold=aggressive_threshold,
                            in_cooldown=True,
                            same_run=False,
                            round_trigger=round_trigger,
                            after_gate_tokens=after_gate,
                            cooldown_remaining_s=cooldown_remaining,
                        )
                    )
                if tokens >= threshold:
                    return _done(
                        CompactionTriggerDecision(
                            allow=True,
                            reason="over_threshold_new_turn",
                            tokens=tokens,
                            threshold=threshold,
                            aggressive_threshold=aggressive_threshold,
                            in_cooldown=True,
                            same_run=False,
                            round_trigger=round_trigger,
                            after_gate_tokens=after_gate,
                            cooldown_remaining_s=cooldown_remaining,
                        )
                    )
            return _done(
                CompactionTriggerDecision(
                    allow=False,
                    reason="cooldown_active",
                    tokens=tokens,
                    threshold=threshold,
                    aggressive_threshold=aggressive_threshold,
                    in_cooldown=True,
                    same_run=same_run,
                    round_trigger=round_trigger,
                    after_gate_tokens=after_gate,
                    cooldown_remaining_s=cooldown_remaining,
                )
            )

        if tokens >= threshold or round_trigger:
            return _done(
                CompactionTriggerDecision(
                    allow=True,
                    reason="over_threshold" if tokens >= threshold else "round_trigger",
                    tokens=tokens,
                    threshold=threshold,
                    aggressive_threshold=aggressive_threshold,
                    in_cooldown=False,
                    same_run=False,
                    round_trigger=round_trigger,
                    after_gate_tokens=after_gate,
                    cooldown_remaining_s=0.0,
                )
            )

        return _done(
            CompactionTriggerDecision(
                allow=False,
                reason="below_threshold",
                tokens=tokens,
                threshold=threshold,
                aggressive_threshold=aggressive_threshold,
                in_cooldown=False,
                same_run=False,
                round_trigger=round_trigger,
                after_gate_tokens=after_gate,
            )
        )


_trigger_cache: CompactionTriggerCache | None = None
_cache_factory_lock = threading.Lock()


def get_compaction_trigger_cache() -> CompactionTriggerCache:
    global _trigger_cache
    if _trigger_cache is None:
        with _cache_factory_lock:
            if _trigger_cache is None:
                _trigger_cache = CompactionTriggerCache()
    return _trigger_cache


def reset_compaction_trigger_cache_for_tests() -> None:
    """Replace the process-wide trigger cache (unit tests only)."""
    global _trigger_cache
    with _cache_factory_lock:
        _trigger_cache = CompactionTriggerCache()
