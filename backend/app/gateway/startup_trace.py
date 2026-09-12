"""Gateway cold-start timeline — stderr, gateway-startup.log, and /health/startup.

Search logs for ``[STARTUP-TRACE]`` or open ``~/.evoflow/logs/gateway-startup.log``.
Disable with ``EVOFLOW_STARTUP_TRACE=0``.
"""

from __future__ import annotations

import json
import os
import sys
import time
from dataclasses import asdict, dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

_T0 = time.perf_counter()
_LAST = _T0
_ENABLED = os.environ.get("EVOFLOW_STARTUP_TRACE", "1").strip().lower() not in {
    "0",
    "false",
    "no",
    "off",
}
_STATUS = "booting"
_ERROR: str | None = None
_META: dict[str, Any] = {}


@dataclass
class StartupMark:
    tag: str
    phase: str
    delta_ms: float
    total_ms: float
    ts: str
    extra: dict[str, Any] = field(default_factory=dict)


_MARKS: list[StartupMark] = []


def _wall_ts() -> str:
    return datetime.now().astimezone().isoformat(timespec="milliseconds")


def _startup_log_file() -> Path:
    raw = (os.getenv("EVOFLOW_HOME") or "").strip()
    base = Path(raw).expanduser() if raw else Path.home() / ".evoflow"
    return base / "logs" / "gateway-startup.log"


def _append_log_line(line: str) -> None:
    try:
        path = _startup_log_file()
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass


def startup_reset() -> None:
    """Reset process-origin clock (e.g. frozen entry handoff)."""
    global _T0, _LAST
    _T0 = time.perf_counter()
    _LAST = _T0


def startup_set_meta(**kwargs: Any) -> None:
    """Attach install/debug context (port, frozen, defer_routers, …)."""
    _META.update({k: v for k, v in kwargs.items() if v is not None})


def _boot_cycle_log_file() -> Path | None:
    """Desktop end-to-end cycle log (same file Tauri writes)."""
    raw = (os.getenv("EVOFLOW_HOME") or "").strip()
    base = Path(raw).expanduser() if raw else Path.home() / ".evoflow"
    return base / "logs" / "boot-cycle.log"


def _boot_cycle_append(phase: str, tag: str, *, delta_ms: float, total_ms: float, extra: dict[str, Any] | None = None) -> None:
    """Mirror Gateway marks into boot-cycle.log using desktop wall-clock origin when present."""
    cid = (os.environ.get("EVOFLOW_BOOT_CYCLE_ID") or "").strip()
    if not cid:
        return
    try:
        t0_raw = (os.environ.get("EVOFLOW_BOOT_CYCLE_T0_MS") or "").strip()
        wall_ms: float | None = None
        if t0_raw:
            try:
                t0 = int(t0_raw)
                wall_ms = max(0.0, (time.time() * 1000.0) - float(t0))
            except ValueError:
                wall_ms = None
        path = _boot_cycle_log_file()
        if path is None:
            return
        path.parent.mkdir(parents=True, exist_ok=True)
        ts = datetime.now().astimezone().strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]
        plus = f"+{wall_ms:.0f}ms" if wall_ms is not None else f"+gw{total_ms:.0f}ms"
        extra_bits = ""
        if extra:
            try:
                extra_bits = " " + " ".join(f"{k}={v!r}" for k, v in list(extra.items())[:6])
            except Exception:
                pass
        line = (
            f"[{ts}] [BOOT-CYCLE] id={cid} {plus} phase=gateway/{phase} tag={tag} "
            f"gw_delta_ms={delta_ms:.0f} gw_total_ms={total_ms:.0f} pid={os.getpid()}{extra_bits}"
        )
        with path.open("a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass


def startup_mark(tag: str, *, phase: str = "process", extra: dict[str, Any] | None = None) -> None:
    """Record a milestone on the process timeline."""
    if not _ENABLED:
        return
    global _LAST
    now = time.perf_counter()
    delta_ms = (now - _LAST) * 1000.0
    total_ms = (now - _T0) * 1000.0
    _LAST = now
    mark = StartupMark(
        tag=tag,
        phase=phase,
        delta_ms=round(delta_ms, 1),
        total_ms=round(total_ms, 1),
        ts=_wall_ts(),
        extra=dict(extra or {}),
    )
    _MARKS.append(mark)
    pid = os.getpid()
    frozen = int(getattr(sys, "frozen", False))
    extra_bits = ""
    if extra:
        try:
            extra_bits = " " + " ".join(f"{k}={v!r}" for k, v in extra.items())
        except Exception:
            pass
    human = (
        f"[STARTUP-TRACE] phase={phase} tag={tag} "
        f"delta_ms={mark.delta_ms:.0f} total_ms={mark.total_ms:.0f} "
        f"pid={pid} frozen={frozen}{extra_bits}"
    )
    print(human, file=sys.stderr, flush=True)
    _append_log_line(human)
    _boot_cycle_append(phase, tag, delta_ms=mark.delta_ms, total_ms=mark.total_ms, extra=extra)


def get_startup_report() -> dict[str, Any]:
    """JSON-serializable startup timeline for ``GET /health/startup``."""
    marks = [asdict(m) for m in _MARKS]
    gaps: list[dict[str, Any]] = []
    for i, m in enumerate(_MARKS):
        if i == 0:
            continue
        prev = _MARKS[i - 1]
        gaps.append(
            {
                "from": prev.tag,
                "to": m.tag,
                "delta_ms": m.delta_ms,
            }
        )
    gaps.sort(key=lambda g: g["delta_ms"], reverse=True)
    total_ms = _MARKS[-1].total_ms if _MARKS else 0.0
    return {
        "status": _STATUS,
        "error": _ERROR,
        "pid": os.getpid(),
        "frozen": bool(getattr(sys, "frozen", False)),
        "total_ms": round(total_ms, 1),
        "mark_count": len(_MARKS),
        "meta": dict(_META),
        "marks": marks,
        "slowest_gaps": gaps[:8],
        "log_files": {
            "gateway_startup": str(_startup_log_file()),
            "gateway_daily": "logs/gateway-YYYY-MM-DD.log (under EVOFLOW_HOME or repo logs/)",
            "evopanel_startup": "~/.evoflow/logs/evopanel-startup.log (desktop)",
            "boot_cycle": "~/.evoflow/logs/boot-cycle.log (open→engineReady end-to-end)",
            "frontend_boot": "search frontend log for [BOOT]",
        },
        "grep_hints": [
            "[BOOT-CYCLE]",
            "[STARTUP-TRACE]",
            "[STARTUP]",
            "[BOOT]",
            "boot-cycle.log",
            "gateway-startup.log",
            "evopanel-startup.log",
        ],
    }


def startup_write_summary(*, status: str, error: str | None = None) -> None:
    """Emit a human-readable summary block (stderr + gateway-startup.log)."""
    global _STATUS, _ERROR
    _STATUS = status
    _ERROR = error
    if not _ENABLED:
        return
    report = get_startup_report()
    total = report.get("total_ms", 0)
    lines = [
        "",
        f"========== GATEWAY STARTUP SUMMARY ({status.upper()}) total={total:.0f}ms pid={os.getpid()} ==========",
    ]
    if _META:
        lines.append(f"meta: {json.dumps(_META, ensure_ascii=False, default=str)}")
    if error:
        lines.append(f"error: {error}")
    for i, m in enumerate(_MARKS):
        prev_total = _MARKS[i - 1].total_ms if i > 0 else 0.0
        delta = m.total_ms - prev_total
        lines.append(f"  +{delta:.0f}ms → [{m.phase}] {m.tag} (total {m.total_ms:.0f}ms)")
    slow = report.get("slowest_gaps") or []
    if slow:
        lines.append("SLOWEST GAPS:")
        for g in slow[:5]:
            lines.append(f"  +{g['delta_ms']:.0f}ms  {g['from']} → {g['to']}")
    lines.extend(
        [
            "DIAGNOSTIC FILES:",
            f"  gateway-startup.log → {_startup_log_file()}",
            "  evopanel-startup.log → ~/.evoflow/logs/evopanel-startup.log",
            "  API timeline → GET /health/startup",
            "  Frontend → search [BOOT] in frontend / evopanel logs",
            "=" * 72,
            "",
        ]
    )
    block = "\n".join(lines)
    print(block, file=sys.stderr, flush=True)
    _append_log_line(block)


def note_gateway_exit(reason: str, *, detail: str | None = None) -> None:
    """Append a durable exit/shutdown line (stderr + gateway-startup.log).

    Call from lifespan teardown, atexit, or excepthook so mysterious process
    deaths leave a breadcrumb when Python still gets a chance to run.
    """
    import traceback

    pid = os.getpid()
    ts = datetime.now().astimezone().isoformat(timespec="seconds")
    bits = [f"[GATEWAY-EXIT] ts={ts} pid={pid} reason={reason}"]
    if detail:
        bits.append(f"detail={detail}")
    line = " ".join(bits)
    print(line, file=sys.stderr, flush=True)
    _append_log_line(line)
    if reason in {"uncaught_exception", "excepthook"}:
        try:
            tb = traceback.format_exc()
            if tb and tb.strip() != "NoneType: None":
                _append_log_line(tb)
        except Exception:
            pass
