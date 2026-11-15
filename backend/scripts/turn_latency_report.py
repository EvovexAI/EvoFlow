#!/usr/bin/env python3
"""Per-turn end-to-end latency report — "how slow does one AI interaction feel".

User-perceived latency is NOT single-call TTFT: one turn = one graph run that
chains N model calls and M tool executions plus the gaps between them
(middleware, compaction, persistence). This report reconstructs every run from
the observability store (run_id groups model_invocations + tool_invocations,
~96% coverage) and splits each turn's wall time into:

  model   — Σ model-call latency (incl. TTFT wait + stream)
  tools   — Σ tool duration (+ queue wait where recorded)
  gaps    — wall time minus the above: middleware/compaction/persistence idle

Per-day distribution (p50/p95) plus the slowest turns with their breakdown,
so "太慢了" becomes a number and a culprit segment instead of a feeling.

Usage (from backend/):
  python scripts/turn_latency_report.py                       # last 7 days
  python scripts/turn_latency_report.py --days 14 --min-seconds 10
  python scripts/turn_latency_report.py --db path --json
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from datetime import datetime, timedelta
from pathlib import Path


def _pct(values: list[float], p: float) -> float | None:
    if not values:
        return None
    vs = sorted(values)
    return vs[min(len(vs) - 1, round((len(vs) - 1) * p))]


def resolve_db_path(explicit: str | None) -> Path:
    if explicit:
        return Path(explicit)
    try:
        root = Path(__file__).resolve().parents[1]
        sys.path.insert(0, str(root / "packages" / "harness"))
        sys.path.insert(0, str(root))
        from evoflow.observability.recorder import _store_for_config

        st = _store_for_config()
        if st is not None:
            return Path(st.resolved_path())
        print("(observability store disabled; pass --db)", file=sys.stderr)
    except Exception as exc:  # noqa: BLE001
        print(f"(auto-resolve failed: {exc}; pass --db)", file=sys.stderr)
    raise SystemExit("No --db given and auto-resolve failed.")


def _iso(s: str) -> float | None:
    try:
        return datetime.fromisoformat(str(s)).timestamp()
    except (ValueError, TypeError):
        return None


def load_turns(conn: sqlite3.Connection, since_iso: str, model_like: str) -> list[dict]:
    mw = "AND model LIKE ?" if model_like else ""
    mp = (f"%{model_like}%",) if model_like else ()
    models = conn.execute(
        f"""SELECT run_id, requested_at, latency_ms, first_token_latency_ms, thread_id
            FROM evoflow_obs_model_invocations
            WHERE requested_at >= ? AND run_id IS NOT NULL AND run_id != ''
              AND status='completed' AND latency_ms IS NOT NULL {mw}""",
        (since_iso, *mp),
    ).fetchall()
    tools = conn.execute(
        """SELECT run_id, started_at, ended_at, duration_ms, COALESCE(queue_wait_ms,0), tool_name, status
           FROM evoflow_obs_tool_invocations
           WHERE started_at >= ? AND run_id IS NOT NULL AND run_id != ''""",
        (since_iso,),
    ).fetchall()

    turns: dict[str, dict] = {}
    for rid, req, lat, ttft, tid in models:
        t = turns.setdefault(str(rid), {"thread": str(tid or "")[:12], "model_n": 0, "model_ms": 0.0,
                                        "ttft_ms": 0.0, "tool_n": 0, "tool_ms": 0.0,
                                        "tool_err": 0, "start": None, "end": None})
        t["model_n"] += 1
        t["model_ms"] += float(lat or 0)
        t["ttft_ms"] += float(ttft or 0)
        s = _iso(req)
        e = s + float(lat or 0) / 1000.0 if s is not None else None
        if s is not None:
            t["start"] = s if t["start"] is None else min(t["start"], s)
        if e is not None:
            t["end"] = e if t["end"] is None else max(t["end"], e)
    for rid, st_, en_, dur, wait, name, status in tools:
        t = turns.get(str(rid))
        if t is None:
            continue
        t["tool_n"] += 1
        t["tool_ms"] += float(dur or 0) + float(wait or 0)
        if str(status) != "success":
            t["tool_err"] += 1
        s, e = _iso(st_), _iso(en_)
        if s is not None:
            t["start"] = s if t["start"] is None else min(t["start"], s)
        if e is not None:
            t["end"] = e if t["end"] is None else max(t["end"], e)

    out = []
    for rid, t in turns.items():
        if t["start"] is None or t["end"] is None:
            continue
        wall = (t["end"] - t["start"]) * 1000.0
        if wall <= 0:
            continue
        gaps = wall - t["model_ms"] - t["tool_ms"]
        out.append({"run": rid[:10], "thread": t["thread"], "wall": wall,
                    "model_ms": t["model_ms"], "ttft_ms": t["ttft_ms"],
                    "tool_ms": t["tool_ms"], "gap_ms": max(0.0, gaps),
                    "model_n": t["model_n"], "tool_n": t["tool_n"], "tool_err": t["tool_err"]})
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--days", type=int, default=7)
    ap.add_argument("--min-seconds", type=float, default=5.0, help="Only count turns slower than this")
    ap.add_argument("--model", default=None, help="Filter model-calls by model name substring")
    ap.add_argument("--top", type=int, default=5, help="Slowest turns to show")
    ap.add_argument("--db", default=None)
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    db = resolve_db_path(args.db)
    if not db.exists():
        raise SystemExit(f"observability db not found: {db}")
    since = (datetime.now() - timedelta(days=args.days)).isoformat(timespec="seconds")
    conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    turns = load_turns(conn, since, args.model or "")
    conn.close()

    slow = [t for t in turns if t["wall"] >= args.min_seconds * 1000]
    walls = [t["wall"] for t in slow]
    report = {
        "window_days": args.days,
        "turns_total": len(turns),
        "turns_slow": len(slow),
        "wall_p50_ms": _pct(walls, 0.50),
        "wall_p95_ms": _pct(walls, 0.95),
        "model_n_p95": _pct([float(t["model_n"]) for t in slow], 0.95),
        "tool_n_p95": _pct([float(t["tool_n"]) for t in slow], 0.95),
        "share_model": (sum(t["model_ms"] for t in slow) / sum(t["wall"] for t in slow)) if slow else None,
        "share_tools": (sum(t["tool_ms"] for t in slow) / sum(t["wall"] for t in slow)) if slow else None,
        "share_gaps": (sum(t["gap_ms"] for t in slow) / sum(t["wall"] for t in slow)) if slow else None,
        "slowest": sorted(slow, key=lambda t: -t["wall"])[: args.top],
    }

    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2, default=str))
        return

    print(f"per-turn end-to-end latency  db={db}  window={args.days}d  (turns slower than {args.min_seconds}s)")
    if not slow:
        print("no slow turns recorded in this window.")
        return
    sw = report["share_model"]; st = report["share_tools"]; sg = report["share_gaps"]
    print(f"slow turns: {report['turns_slow']}/{report['turns_total']}   wall p50={report['wall_p50_ms']/1000:.1f}s  p95={report['wall_p95_ms']/1000:.1f}s")
    print(f"slow-turn time split: model {sw * 100:.0f}%  tools {st * 100:.0f}%  gaps( middleware/compaction/persistence ) {sg * 100:.0f}%")
    print(f"calls per slow turn: model p95={report['model_n_p95']:.0f}  tools p95={report['tool_n_p95']:.0f}")
    print()
    print(f"slowest {args.top} turns:")
    print("  wall     model   ttft    tools   gaps    m#  t#  err  thread")
    for t in report["slowest"]:
        print(f"  {t['wall']/1000:7.1f}s {t['model_ms']/1000:6.1f}s {t['ttft_ms']/1000:6.1f}s {t['tool_ms']/1000:6.1f}s {t['gap_ms']/1000:6.1f}s  {t['model_n']:2d}  {t['tool_n']:2d}  {t['tool_err']:3d}  {t['thread']}")
    print()
    print("reading the split: high model share = vendor/ctx-size problem (cache+compaction fixes);")
    print("high gaps share = our pipeline between calls (middleware/compaction) — was 120s sync compaction, now async;")
    print("high tools share = slow tool executions (see tool_invocations.duration_ms per tool).")


if __name__ == "__main__":
    main()
