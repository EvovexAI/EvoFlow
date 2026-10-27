"""SQLite sidecar for voice utterance ledger (async persist)."""

from __future__ import annotations

import logging
import sqlite3
import threading
from pathlib import Path
from typing import Any

logger = logging.getLogger("evoflow.speech.playback_store")

_SCHEMA = """
CREATE TABLE IF NOT EXISTS voice_utterances (
  id TEXT PRIMARY KEY,
  trace_id TEXT NOT NULL DEFAULT '',
  sid TEXT NOT NULL DEFAULT '',
  seq INTEGER NOT NULL DEFAULT 0,
  text TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'queued',
  source TEXT NOT NULL DEFAULT 'frame',
  speaker TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL DEFAULT '',
  created_at REAL NOT NULL,
  synth_started_at REAL,
  synth_ended_at REAL,
  play_started_at REAL,
  play_ended_at REAL,
  bytes INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  audio_path TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_voice_utt_trace ON voice_utterances(trace_id);
CREATE INDEX IF NOT EXISTS idx_voice_utt_created ON voice_utterances(created_at DESC);
"""

_lock = threading.RLock()
_conn: sqlite3.Connection | None = None
_db_path: Path | None = None


def voice_playback_db_path() -> Path:
    try:
        from evoflow.config.data_paths import data_root, resolve_data_base_dir

        base = data_root(resolve_data_base_dir()) / "speech"
    except Exception:
        base = Path.home() / ".evoflow" / "data" / "speech"
    base.mkdir(parents=True, exist_ok=True)
    return base / "voice_playback.db"


def _ensure_conn() -> sqlite3.Connection:
    global _conn, _db_path
    with _lock:
        path = voice_playback_db_path()
        if _conn is not None and _db_path == path:
            return _conn
        if _conn is not None:
            try:
                _conn.close()
            except Exception:
                pass
        path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(str(path), check_same_thread=False, timeout=30.0)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.executescript(_SCHEMA)
        conn.commit()
        _conn = conn
        _db_path = path
        return conn


def upsert_utterance(row: dict[str, Any]) -> None:
    """Insert or update one utterance row (best-effort)."""
    try:
        conn = _ensure_conn()
        cols = (
            "id",
            "trace_id",
            "sid",
            "seq",
            "text",
            "status",
            "source",
            "speaker",
            "provider",
            "created_at",
            "synth_started_at",
            "synth_ended_at",
            "play_started_at",
            "play_ended_at",
            "bytes",
            "duration_ms",
            "audio_path",
            "error",
        )
        values = [row.get(c) for c in cols]
        placeholders = ",".join("?" for _ in cols)
        assignments = ",".join(f"{c}=excluded.{c}" for c in cols if c != "id")
        sql = (
            f"INSERT INTO voice_utterances ({','.join(cols)}) VALUES ({placeholders}) "
            f"ON CONFLICT(id) DO UPDATE SET {assignments}"
        )
        with _lock:
            conn.execute(sql, values)
            conn.commit()
    except Exception:
        logger.debug("voice utterance upsert failed", exc_info=True)


def list_by_trace(trace_id: str, *, limit: int = 100) -> list[dict[str, Any]]:
    tid = str(trace_id or "").strip()
    if not tid:
        return []
    try:
        conn = _ensure_conn()
        with _lock:
            cur = conn.execute(
                "SELECT * FROM voice_utterances WHERE trace_id=? "
                "ORDER BY created_at ASC, seq ASC LIMIT ?",
                (tid, max(1, min(int(limit), 500))),
            )
            return [dict(r) for r in cur.fetchall()]
    except Exception:
        logger.debug("voice utterance list_by_trace failed", exc_info=True)
        return []


def list_recent(*, limit: int = 50) -> list[dict[str, Any]]:
    try:
        conn = _ensure_conn()
        with _lock:
            cur = conn.execute(
                "SELECT * FROM voice_utterances ORDER BY created_at DESC LIMIT ?",
                (max(1, min(int(limit), 500)),),
            )
            rows = [dict(r) for r in cur.fetchall()]
        rows.reverse()
        return rows
    except Exception:
        logger.debug("voice utterance list_recent failed", exc_info=True)
        return []
