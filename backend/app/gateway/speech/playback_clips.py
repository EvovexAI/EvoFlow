"""Async MP3 clip writer for voice utterance ledger."""

from __future__ import annotations

import logging
import os
import threading
from datetime import datetime
from pathlib import Path

logger = logging.getLogger("evoflow.speech.playback_clips")

# Default on; set EVOFLOW_VOICE_CLIPS=0 to disable disk writes.
_ENABLED = os.getenv("EVOFLOW_VOICE_CLIPS", "1").strip().lower() not in {
    "0",
    "false",
    "off",
    "no",
}


def voice_clips_enabled() -> bool:
    return _ENABLED


def voice_clips_dir(*, day: str | None = None) -> Path:
    try:
        from evoflow.config.data_paths import data_root, resolve_data_base_dir

        base = data_root(resolve_data_base_dir()) / "voice-clips"
    except Exception:
        base = Path.home() / ".evoflow" / "data" / "voice-clips"
    d = day or datetime.now().strftime("%Y-%m-%d")
    path = base / d
    path.mkdir(parents=True, exist_ok=True)
    return path


def _safe_id(utterance_id: str) -> str:
    return (
        str(utterance_id or "utt")
        .replace("/", "_")
        .replace("\\", "_")
        .replace(":", "_")
        .replace("..", "_")[:180]
    )


def purge_old_clips(*, keep_days: int = 7) -> int:
    """Delete voice-clip day folders older than keep_days. Returns removed file count."""
    days = max(1, int(keep_days or 7))
    removed = 0
    try:
        from evoflow.config.data_paths import data_root, resolve_data_base_dir

        root = data_root(resolve_data_base_dir()) / "voice-clips"
    except Exception:
        root = Path.home() / ".evoflow" / "data" / "voice-clips"
    if not root.is_dir():
        return 0
    cutoff = datetime.now().date().toordinal() - days
    for child in root.iterdir():
        if not child.is_dir():
            continue
        name = child.name
        try:
            y, m, d = (int(x) for x in name.split("-", 2))
            ord_day = datetime(y, m, d).date().toordinal()
        except Exception:
            continue
        if ord_day >= cutoff:
            continue
        for f in child.rglob("*"):
            if f.is_file():
                try:
                    f.unlink()
                    removed += 1
                except Exception:
                    pass
        try:
            # remove empty dirs bottom-up
            for sub in sorted(child.rglob("*"), reverse=True):
                if sub.is_dir():
                    try:
                        sub.rmdir()
                    except Exception:
                        pass
            child.rmdir()
        except Exception:
            pass
    if removed:
        logger.info("purged %s old voice-clip files (keep_days=%s)", removed, days)
    return removed


_purge_lock = threading.Lock()
_last_purge_at = 0.0


def _maybe_purge_async() -> None:
    """At most once per process hour, purge clips older than 7 days."""
    global _last_purge_at
    import time

    now = time.time()
    if now - _last_purge_at < 3600:
        return
    if not _purge_lock.acquire(blocking=False):
        return
    try:
        if now - _last_purge_at < 3600:
            return
        _last_purge_at = now

        def _run() -> None:
            try:
                keep = int(os.getenv("EVOFLOW_VOICE_CLIPS_KEEP_DAYS", "7") or 7)
                purge_old_clips(keep_days=keep)
            except Exception:
                logger.debug("voice clip purge failed", exc_info=True)

        threading.Thread(target=_run, name="voice-clip-purge", daemon=True).start()
    finally:
        _purge_lock.release()


def save_clip_async(utterance_id: str, audio: bytes, *, mime: str = "audio/mpeg") -> None:
    """Fire-and-forget write; updates ledger audio_path on success."""
    if not _ENABLED:
        return
    blob = bytes(audio or b"")
    if len(blob) < 64:
        return
    uid = _safe_id(utterance_id)
    if not uid:
        return
    _maybe_purge_async()

    def _run() -> None:
        try:
            day = datetime.now().strftime("%Y-%m-%d")
            folder = voice_clips_dir(day=day)
            ext = "mp3" if "mpeg" in (mime or "") or "mp3" in (mime or "") else "bin"
            path = folder / f"{uid}.{ext}"
            path.write_bytes(blob)
            rel = f"voice-clips/{day}/{path.name}"
            try:
                from app.gateway.speech.playback_ledger import note_audio_path

                note_audio_path(utterance_id, rel, bytes_n=len(blob))
            except Exception:
                pass
        except Exception:
            logger.debug("voice clip save failed id=%s", utterance_id, exc_info=True)

    threading.Thread(target=_run, name="voice-clip-save", daemon=True).start()
