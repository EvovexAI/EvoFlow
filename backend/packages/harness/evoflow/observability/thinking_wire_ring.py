"""In-memory + file ring of last model thinking wire snapshots (voice / 小V debug HUD).

LangGraph and Gateway are separate processes — memory alone is invisible to
``GET /api/speech/thinking-debug``. Persist under ``~/.evoflow/logs/`` so the
Control Plane can read what Agent Runtime just sent.
"""

from __future__ import annotations

import json
import os
import sys
import threading
import time
from collections import deque
from pathlib import Path
from typing import Any

_LOCK = threading.Lock()
_RING: deque[dict[str, Any]] = deque(maxlen=24)
_FILE_NAME = "thinking-wire-ring.jsonl"
_MAX_FILE_LINES = 48


def _ring_path() -> Path:
    raw = (os.environ.get("EVOFLOW_HOME") or "").strip()
    root = Path(raw) if raw else Path.home() / ".evoflow"
    d = root / "logs"
    d.mkdir(parents=True, exist_ok=True)
    return d / _FILE_NAME


def record_thinking_wire(snapshot: dict[str, Any]) -> None:
    """Append one wire snapshot (best-effort; never raise into request path)."""
    try:
        row = dict(snapshot or {})
        row.setdefault("ts", time.time())
        with _LOCK:
            _RING.append(row)
            path = _ring_path()
            with path.open("a", encoding="utf-8") as f:
                f.write(json.dumps(row, ensure_ascii=False, default=str) + "\n")
            # trim
            try:
                lines = path.read_text(encoding="utf-8").splitlines()
                if len(lines) > _MAX_FILE_LINES:
                    path.write_text("\n".join(lines[-_MAX_FILE_LINES:]) + "\n", encoding="utf-8")
            except Exception:
                pass
    except Exception:
        pass


def recent_thinking_wire(limit: int = 12) -> list[dict[str, Any]]:
    n = max(1, min(int(limit or 12), 24))
    with _LOCK:
        mem = list(_RING)[-n:]
    if len(mem) >= n:
        return list(reversed(mem))
    # Fallback: read shared file (cross-process)
    try:
        path = _ring_path()
        if path.is_file():
            rows: list[dict[str, Any]] = []
            for line in path.read_text(encoding="utf-8").splitlines()[-n:]:
                line = line.strip()
                if not line:
                    continue
                try:
                    rows.append(json.loads(line))
                except Exception:
                    continue
            if rows:
                return list(reversed(rows))
    except Exception:
        pass
    return list(reversed(mem))


def thinking_fix_probe() -> dict[str, Any]:
    """Whether this process has the voice thinking-off factory guard."""
    frozen = bool(getattr(sys, "frozen", False))
    has_signal = False
    factory_file = ""
    try:
        from evoflow.models import factory as fac

        has_signal = callable(getattr(fac, "_thinking_off_signal_in_settings", None))
        factory_file = str(getattr(fac, "__file__", "") or "")
    except Exception as e:  # noqa: BLE001
        return {
            "ok": False,
            "frozen": frozen,
            "has_thinking_off_guard": False,
            "factory_file": "",
            "error": str(e),
        }
    return {
        "ok": True,
        "frozen": frozen,
        "has_thinking_off_guard": has_signal,
        "factory_file": factory_file,
        "gateway_mode": "packaged" if frozen else "source",
    }
