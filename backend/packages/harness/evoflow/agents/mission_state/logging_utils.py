from __future__ import annotations

import json
import os
from datetime import UTC, datetime
from pathlib import Path
from typing import Any


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[6]


def log_analyzer_io(event: str, **kwargs: Any) -> None:
    """Human-friendly analyzer IO log with separators + timestamp."""
    try:
        # Default: full payload logging. Set EVOFLOW_MISSION_ANALYZER_IO_FULL=0 to switch back to compact mode.
        full_mode = (os.getenv("EVOFLOW_MISSION_ANALYZER_IO_FULL", "1") or "1").strip().lower() not in {"0", "false", "off", "no"}
        ts = datetime.now(UTC)
        ts_human = ts.strftime("%Y-%m-%d %H:%M:%S.%f")[:-3] + "Z"
        payload = {
            "ts": ts.isoformat(),
            "event": event,
            **(kwargs if full_mode else {"_compact": True, **kwargs}),
        }
        line = f"\n{'=' * 88}\n[{ts_human}] mission_state_analyzer {event}\n{'-' * 88}\n{json.dumps(payload, ensure_ascii=False, indent=2)}\n"
        from evoflow.debug.trace_sink import debug_file_path

        path = debug_file_path("mission_state_analyzer_io.log")
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as f:
            f.write(line)
    except Exception:
        pass
