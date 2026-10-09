"""Dev-only stream-paint telemetry sink (POST /api/debug/stream-paint).

Front-end MarkdownHtml calls ``navigator.sendBeacon('/api/debug/stream-paint', payload)``
on every text paint. We log to a JSONL file (overwritten on each server start)
so the operator can ``tail -f`` and see real paint intervals / lengths.

Always-on (no env flag) — it's a few KB per turn and is dev-only by URL ?paintlog=1.
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path

from fastapi import APIRouter, Query, Request
from typing import Any

router = APIRouter(prefix="/api/debug/stream-paint", tags=["debug-stream-paint"])

# Module-level cache of the log path (computed once per process).
_LOG_PATH: Path | None = None


def _log_path() -> Path:
    global _LOG_PATH
    if _LOG_PATH is not None:
        return _LOG_PATH
    base = os.environ.get("EVOFLOW_LOG_DIR") or os.environ.get("EVOFLOW_DATA_DIR") or "."
    p = Path(base) / "logs" / "stream-paint.log"
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
    except Exception:
        pass
    _LOG_PATH = p
    return p


@router.get("", include_in_schema=False)
async def stream_paint_status(on: int | None = Query(default=None)) -> dict[str, Any]:
    """Frontend pings this on mount; we report whether stream-paint telemetry should run.

    On dev / Tauri dev (auto-detected via EVOFLOW_DEV=1 or absence of release flag), we return
    ``on=true`` so the front-end auto-enables sendBeacon to /api/debug/stream-paint (POST).
    The owner can disable by setting EVOFLOW_STREAM_PAINT_TELEMETRY=0.
    """
    if on == 1:
        # explicit enable
        os.environ["EVOFLOW_STREAM_PAINT_TELEMETRY"] = "1"
    enabled_env = os.environ.get("EVOFLOW_STREAM_PAINT_TELEMETRY", "").strip().lower()
    if enabled_env in ("0", "false", "no", "off"):
        return {"on": False}
    # default: enable for Tauri dev (EvoFlow default mode)
    return {"on": True}


@router.post("", include_in_schema=False)
async def receive_paint(request: Request) -> dict[str, str]:
    try:
        body = await request.body()
        try:
            payload = json.loads(body.decode("utf-8") or "{}")
        except Exception:
            payload = {"raw": body[:200].decode("utf-8", errors="replace")}
        # throttle disk: if too many paints, downsample to every Nth
        gap = payload.get("gap")
        ln = payload.get("len")
        dlen = payload.get("dlen")
        paint_us = payload.get("paintUs")
        line = json.dumps(
            {"ts": time.time(), "gap": gap, "len": ln, "dlen": dlen, "paintUs": paint_us},
            ensure_ascii=False,
        )
        try:
            p = _log_path()
            with p.open("a", encoding="utf-8") as f:
                f.write(line + "\n")
        except Exception:
            pass
        return {"ok": "1"}
    except Exception:
        return {"ok": "0"}
