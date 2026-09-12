from __future__ import annotations

from typing import Any

from evoflow.timeutil import beijing_now_iso


def write_cycle_trace(event: str, payload: dict[str, Any]) -> None:
    """Best-effort collaboration lifecycle trace (SQLite observability)."""
    try:
        tid = str(payload.get("thread_id") or "").strip() or None
        row = {
            "ts": beijing_now_iso(),
            "event": str(event or "").strip(),
            **payload,
        }
        try:
            from evoflow.observability.recorder import get_observability_recorder

            rid = None
            if isinstance(payload.get("run_id"), str) and payload["run_id"].strip():
                rid = payload["run_id"].strip()
            get_observability_recorder().record_trace_event(
                thread_id=tid,
                run_id=rid,
                lane="collab_cycle",
                occurred_at=str(row["ts"]),
                event=str(event or "").strip(),
                payload=row,
            )
        except Exception:
            pass
    except Exception:
        return
