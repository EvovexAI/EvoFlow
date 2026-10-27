"""Voice playback utterance ledger: memory ring + async SQLite + clip path.

Queue element = one TTS utterance (aligned with Frame ``seq`` / TRACE).
Statuses: queued → synthesizing → ready → playing → played | cancelled | failed
"""

from __future__ import annotations

import hashlib
import logging
import threading
import time
from collections import OrderedDict
from typing import Any

logger = logging.getLogger("evoflow.speech.playback_ledger")

_STATUSES = frozenset(
    {
        "queued",
        "synthesizing",
        "ready",
        "playing",
        "played",
        "cancelled",
        "failed",
    }
)

_RING_MAX = 500
_lock = threading.RLock()
# id → item (OrderedDict: insertion/LRU order for recent listing + eviction)
_items: OrderedDict[str, dict[str, Any]] = OrderedDict()
# live open seqs per sid for barge cancel
_open_by_sid: dict[str, set[str]] = {}


def make_utterance_id(
    *,
    trace_id: str,
    seq: int,
    source: str = "frame",
    text: str = "",
    play_token: str = "",
) -> str:
    tid = str(trace_id or "").strip() or "vt-unknown"
    src = str(source or "frame").strip() or "frame"
    if src == "fixed_sfx":
        plain = str(text or "").strip().encode("utf-8")
        h = hashlib.sha1(plain or b"sfx").hexdigest()[:12]
        tok = str(play_token or "").strip()
        if tok:
            return f"sfx:{h}:{tok}"
        return f"sfx:{h}:{tid}:{int(seq or 0)}"
    return f"{tid}:{int(seq or 0)}"


def note_client_event(
    *,
    phase: str,
    text: str = "",
    trace_id: str = "",
    seq: int = 0,
    source: str = "fixed_sfx",
    speaker: str = "",
    provider: str = "",
    duration_ms: int = 0,
    bytes_n: int = 0,
    error: str = "",
    utterance_id: str = "",
    play_token: str = "",
) -> str:
    """HTTP / FE fixed-sfx lifecycle → same ledger (bypasses Frame WS)."""
    src = str(source or "fixed_sfx").strip() or "fixed_sfx"
    uid = str(utterance_id or "").strip() or make_utterance_id(
        trace_id=trace_id,
        seq=seq,
        source=src,
        text=text,
        play_token=play_token,
    )
    p = str(phase or "").strip().lower()
    if p in ("queued", "synthesizing", "synth"):
        return note_queued(
            trace_id=trace_id or uid,
            seq=seq,
            text=text,
            source=src,
            speaker=speaker,
            provider=provider,
            utterance_id=uid,
        )
    if p in ("ready", "cached"):
        return note_ready(
            trace_id=trace_id or uid,
            seq=seq,
            text=text,
            source=src,
            speaker=speaker,
            provider=provider,
            utterance_id=uid,
        )
    if p == "playing":
        # Ensure row exists for fixed_sfx (no prior queued from bridge)
        if get_utterance(uid) is None:
            note_ready(
                trace_id=trace_id or uid,
                seq=seq,
                text=text,
                source=src,
                speaker=speaker,
                provider=provider,
                utterance_id=uid,
            )
        return note_playing(trace_id=trace_id or uid, seq=seq, source=src, utterance_id=uid)
    if p in ("played", "ended", "done"):
        return note_played(
            trace_id=trace_id or uid,
            seq=seq,
            duration_ms=duration_ms,
            source=src,
            utterance_id=uid,
        )
    if p in ("cancelled", "canceled"):
        note_cancelled(
            trace_id=trace_id or uid,
            seq=seq,
            source=src,
            reason=error or "client",
            utterance_id=uid,
        )
        return uid
    if p == "failed":
        return note_failed(
            trace_id=trace_id or uid,
            seq=seq,
            error=error or "failed",
            source=src,
            utterance_id=uid,
        )
    if bytes_n and get_utterance(uid):
        note_audio_path(uid, "", bytes_n=bytes_n)
    return uid


def _now() -> float:
    return time.time()


def _persist_async(row: dict[str, Any]) -> None:
    def _run() -> None:
        try:
            from app.gateway.speech.playback_store import upsert_utterance

            upsert_utterance(dict(row))
        except Exception:
            logger.debug("playback persist failed", exc_info=True)

    threading.Thread(target=_run, name="voice-utt-persist", daemon=True).start()


def _touch_ring(uid: str) -> None:
    """Keep uid at MRU end; evict oldest when over capacity. Call after _items[uid]=…"""
    if uid in _items:
        _items.move_to_end(uid)
    while len(_items) > _RING_MAX:
        _items.popitem(last=False)


def _blank(
    *,
    uid: str,
    trace_id: str,
    sid: str,
    seq: int,
    text: str,
    source: str,
    speaker: str,
    provider: str,
) -> dict[str, Any]:
    return {
        "id": uid,
        "trace_id": str(trace_id or "").strip(),
        "sid": str(sid or "").strip(),
        "seq": int(seq or 0),
        "text": str(text or ""),
        "status": "queued",
        "source": str(source or "frame"),
        "speaker": str(speaker or ""),
        "provider": str(provider or ""),
        "created_at": _now(),
        "synth_started_at": None,
        "synth_ended_at": None,
        "play_started_at": None,
        "play_ended_at": None,
        "bytes": 0,
        "duration_ms": 0,
        "audio_path": "",
        "error": "",
    }


def note_queued(
    *,
    trace_id: str,
    seq: int,
    text: str,
    sid: str = "",
    source: str = "frame",
    speaker: str = "",
    provider: str = "",
    utterance_id: str = "",
) -> str:
    """Mark utterance as queued / synthesizing (text decided)."""
    uid = str(utterance_id or "").strip() or make_utterance_id(
        trace_id=trace_id, seq=seq, source=source, text=text
    )
    with _lock:
        item = _items.get(uid)
        if item is None:
            item = _blank(
                uid=uid,
                trace_id=trace_id,
                sid=sid,
                seq=seq,
                text=text,
                source=source,
                speaker=speaker,
                provider=provider,
            )
            item["status"] = "synthesizing"
            item["synth_started_at"] = _now()
            _items[uid] = item
        else:
            if text and not item.get("text"):
                item["text"] = text
            if item.get("status") in ("queued", "synthesizing"):
                item["status"] = "synthesizing"
                item["synth_started_at"] = item.get("synth_started_at") or _now()
            if sid:
                item["sid"] = sid
        _touch_ring(uid)
        if sid:
            _open_by_sid.setdefault(sid, set()).add(uid)
        snap = dict(item)
    _persist_async(snap)
    return uid


def note_ready(
    *,
    trace_id: str,
    seq: int,
    text: str = "",
    sid: str = "",
    source: str = "frame",
    speaker: str = "",
    provider: str = "",
    utterance_id: str = "",
) -> str:
    """First audio / tts_start — utterance ready to play."""
    uid = str(utterance_id or "").strip() or make_utterance_id(
        trace_id=trace_id, seq=seq, source=source, text=text
    )
    with _lock:
        item = _items.get(uid)
        if item is None:
            item = _blank(
                uid=uid,
                trace_id=trace_id,
                sid=sid,
                seq=seq,
                text=text,
                source=source,
                speaker=speaker,
                provider=provider,
            )
            _items[uid] = item
        if text:
            item["text"] = text
        if sid:
            item["sid"] = sid
        if speaker:
            item["speaker"] = speaker
        if provider:
            item["provider"] = provider
        if item.get("status") not in ("playing", "played", "cancelled"):
            item["status"] = "ready"
        item["synth_started_at"] = item.get("synth_started_at") or _now()
        item["synth_ended_at"] = item.get("synth_ended_at") or _now()
        _touch_ring(uid)
        if sid:
            _open_by_sid.setdefault(sid, set()).add(uid)
        snap = dict(item)
    _persist_async(snap)
    return uid


def note_wire_end(
    *,
    trace_id: str,
    seq: int,
    text: str = "",
    bytes_n: int = 0,
    cancelled: bool = False,
    source: str = "frame",
) -> str:
    """tts_end on wire (synthesis download finished)."""
    uid = make_utterance_id(trace_id=trace_id, seq=seq, source=source)
    with _lock:
        item = _items.get(uid)
        if item is None:
            item = _blank(
                uid=uid,
                trace_id=trace_id,
                sid="",
                seq=seq,
                text=text,
                source=source,
                speaker="",
                provider="",
            )
            _items[uid] = item
        if text:
            item["text"] = text
        if bytes_n:
            item["bytes"] = int(bytes_n)
        item["synth_ended_at"] = _now()
        if cancelled:
            item["status"] = "cancelled"
        elif item.get("status") in ("queued", "synthesizing", "ready"):
            item["status"] = "ready"
        _touch_ring(uid)
        snap = dict(item)
    _persist_async(snap)
    return uid


def note_playing(
    *,
    trace_id: str,
    seq: int,
    source: str = "frame",
    utterance_id: str = "",
) -> str:
    uid = str(utterance_id or "").strip() or make_utterance_id(
        trace_id=trace_id, seq=seq, source=source
    )
    with _lock:
        item = _items.get(uid)
        if item is None:
            return uid
        if item.get("status") not in ("played", "cancelled", "failed"):
            item["status"] = "playing"
            item["play_started_at"] = item.get("play_started_at") or _now()
        _touch_ring(uid)
        snap = dict(item)
    _persist_async(snap)
    return uid


def note_played(
    *,
    trace_id: str,
    seq: int,
    duration_ms: int = 0,
    source: str = "frame",
    utterance_id: str = "",
) -> str:
    uid = str(utterance_id or "").strip() or make_utterance_id(
        trace_id=trace_id, seq=seq, source=source
    )
    with _lock:
        item = _items.get(uid)
        if item is None:
            return uid
        if item.get("status") != "cancelled":
            item["status"] = "played"
        item["play_ended_at"] = _now()
        if duration_ms:
            item["duration_ms"] = int(duration_ms)
        elif item.get("play_started_at"):
            item["duration_ms"] = int(
                max(0, (_now() - float(item["play_started_at"])) * 1000)
            )
        sid = str(item.get("sid") or "")
        if sid and uid in _open_by_sid.get(sid, set()):
            _open_by_sid[sid].discard(uid)
        _touch_ring(uid)
        snap = dict(item)
    _persist_async(snap)
    return uid


def note_cancelled(
    *,
    trace_id: str = "",
    seq: int | None = None,
    sid: str = "",
    source: str = "frame",
    reason: str = "",
    utterance_id: str = "",
) -> list[str]:
    """Cancel one seq or all open utterances for a sid."""
    touched: list[str] = []
    with _lock:
        targets: list[str] = []
        if utterance_id:
            targets.append(str(utterance_id).strip())
        elif seq is not None and trace_id:
            targets.append(make_utterance_id(trace_id=trace_id, seq=seq, source=source))
        elif sid:
            targets.extend(list(_open_by_sid.get(sid, set())))
        for uid in targets:
            item = _items.get(uid)
            if not item:
                continue
            if item.get("status") in ("played", "failed"):
                continue
            item["status"] = "cancelled"
            item["play_ended_at"] = _now()
            if reason:
                item["error"] = str(reason)[:500]
            _touch_ring(uid)
            touched.append(uid)
            _persist_async(dict(item))
        if sid:
            _open_by_sid.pop(sid, None)
    return touched


def note_failed(
    *,
    trace_id: str,
    seq: int,
    error: str,
    source: str = "frame",
    utterance_id: str = "",
) -> str:
    uid = str(utterance_id or "").strip() or make_utterance_id(
        trace_id=trace_id, seq=seq, source=source
    )
    with _lock:
        item = _items.get(uid)
        if item is None:
            item = _blank(
                uid=uid,
                trace_id=trace_id,
                sid="",
                seq=seq,
                text="",
                source=source,
                speaker="",
                provider="",
            )
            _items[uid] = item
        item["status"] = "failed"
        item["error"] = str(error or "")[:500]
        item["synth_ended_at"] = _now()
        _touch_ring(uid)
        snap = dict(item)
    _persist_async(snap)
    return uid


def note_audio_path(utterance_id: str, audio_path: str, *, bytes_n: int = 0) -> None:
    uid = str(utterance_id or "").strip()
    if not uid:
        return
    with _lock:
        item = _items.get(uid)
        if item is None:
            return
        item["audio_path"] = str(audio_path or "")
        if bytes_n:
            item["bytes"] = int(bytes_n)
        snap = dict(item)
    _persist_async(snap)


def get_utterance(utterance_id: str) -> dict[str, Any] | None:
    with _lock:
        item = _items.get(str(utterance_id or "").strip())
        return dict(item) if item else None


def list_memory_recent(*, limit: int = 50) -> list[dict[str, Any]]:
    n = max(1, min(int(limit), 500))
    with _lock:
        ids = list(_items.keys())[-n:]
        return [dict(_items[i]) for i in ids]


def list_memory_by_trace(trace_id: str) -> list[dict[str, Any]]:
    tid = str(trace_id or "").strip()
    if not tid:
        return []
    with _lock:
        rows = [dict(v) for v in _items.values() if str(v.get("trace_id") or "") == tid]
    rows.sort(key=lambda r: (float(r.get("created_at") or 0), int(r.get("seq") or 0)))
    return rows


def query_recent(*, limit: int = 50) -> list[dict[str, Any]]:
    mem = list_memory_recent(limit=limit)
    if len(mem) >= limit:
        return mem
    try:
        from app.gateway.speech.playback_store import list_recent

        db_rows = list_recent(limit=limit)
    except Exception:
        db_rows = []
    seen = {str(r.get("id") or "") for r in mem}
    merged = list(mem)
    for r in db_rows:
        rid = str(r.get("id") or "")
        if rid and rid not in seen:
            merged.append(r)
            seen.add(rid)
    merged.sort(key=lambda r: float(r.get("created_at") or 0))
    return merged[-limit:]


def query_by_trace(trace_id: str, *, limit: int = 100) -> list[dict[str, Any]]:
    mem = list_memory_by_trace(trace_id)
    try:
        from app.gateway.speech.playback_store import list_by_trace

        db_rows = list_by_trace(trace_id, limit=limit)
    except Exception:
        db_rows = []
    seen = {str(r.get("id") or "") for r in mem}
    merged = list(mem)
    for r in db_rows:
        rid = str(r.get("id") or "")
        if rid and rid not in seen:
            merged.append(r)
            seen.add(rid)
    merged.sort(key=lambda r: (float(r.get("created_at") or 0), int(r.get("seq") or 0)))
    return merged[:limit]
