#!/usr/bin/env python3
"""Before/after report for the 2026-11-14 context-pipeline changes.

Measures whether the context/cache alignment (ZCode-style 3 cache breakpoints,
read whole-file gate, memory live bits moved off system) actually improved
runtime behavior, using the observability SQLite store that vendor_roundtrip
already fills on every model call.

Signals per window (before / after the --split boundary):
  - model invocations: count, cache hit rate (cache_read / (read + miss)),
    billed-context tokens per request (read + creation + miss; Anthropic's
    input_tokens counts uncached tokens only, so use the triplet),
    avg/p95 first-token latency, avg message_count (round-trip proxy)
  - read tool: whole-file gate trigger count (banner marker in output_text)
    — how often big reads were capped, i.e. context shaved off

Usage (from backend/):
  python scripts/context_cache_effect_report.py --split "2026-11-14T18:00"
  python scripts/context_cache_effect_report.py --split "2026-11-14T18:00" \
      --window-hours 48 --model claude --db path/to/evoflow_observability.db

Interpretation: after the change cache_hit_rate_pct should jump (prefix now
byte-stable; OAuth caching enabled), avg billed-context per request should
drop (big reads capped, no live-footer system churn forcing full re-reads),
and first-token latency should drop with it. Fewer messages per request for
the same task = the freshness suffix / pagination banner killed round-trips.
"""

from __future__ import annotations

import argparse
import sqlite3
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

GATE_MARKER = "%Showing lines 1-%"
READ_TOOLS = ("read", "read_file", "read_files")
# evoflow.timeutil persists Beijing-local ISO with +08:00 suffix and microseconds;
# SQLite compares timestamps lexicographically, so boundaries must match that format.
BEIJING_TZ = timezone(timedelta(hours=8))


def _normalize_boundary(value: str) -> str:
    dt = datetime.fromisoformat(value)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=BEIJING_TZ)
    return dt.astimezone(BEIJING_TZ).isoformat(timespec="microseconds")


def _now_iso() -> str:
    return datetime.now(BEIJING_TZ).isoformat(timespec="microseconds")


def _iso_minus_hours(hours: float) -> str:
    return (datetime.now(BEIJING_TZ) - timedelta(hours=hours)).isoformat(timespec="microseconds")


def resolve_db_path(explicit: str | None) -> Path:
    if explicit:
        return Path(explicit)
    try:
        sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "packages" / "harness"))
        sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
        from evoflow.observability.recorder import _store_for_config

        st = _store_for_config()
        if st is not None:
            return Path(st.resolved_path())
        print("(observability store disabled or unavailable; pass --db explicitly)", file=sys.stderr)
    except Exception as exc:  # noqa: BLE001
        print(f"(auto-resolve of observability db failed: {exc}; pass --db)", file=sys.stderr)
    raise SystemExit("No --db given and auto-resolve failed.")


def _pct(values: list[float], p: float) -> float | None:
    if not values:
        return None
    vs = sorted(values)
    idx = min(len(vs) - 1, max(0, round((len(vs) - 1) * p)))
    return vs[idx]


def _table_columns(conn: sqlite3.Connection, table: str) -> set[str]:
    return {row[1] for row in conn.execute(f"PRAGMA table_info({table})")}


def model_window_stats(conn: sqlite3.Connection, start: str, end: str, model_like: str) -> dict:
    cols = _table_columns(conn, "evoflow_obs_model_invocations")
    ttft_col = "first_token_latency_ms" if "first_token_latency_ms" in cols else "NULL"
    msg_col = "message_count" if "message_count" in cols else "NULL"
    where = "status='completed' AND requested_at >= ? AND requested_at < ? AND latency_ms IS NOT NULL"
    params: list = [start, end]
    if model_like:
        where += " AND model LIKE ?"
        params.append(f"%{model_like}%")
    rows = conn.execute(
        f"""
        SELECT latency_ms, {ttft_col}, {msg_col},
               cache_read_tokens, cache_creation_tokens, cache_miss_tokens
        FROM evoflow_obs_model_invocations WHERE {where}
        """,
        params,
    ).fetchall()
    n = len(rows)
    if n == 0:
        return {"count": 0}
    read = sum(int(r[3] or 0) for r in rows)
    create = sum(int(r[4] or 0) for r in rows)
    miss = sum(int(r[5] or 0) for r in rows)
    ctx_per_req = [int(r[3] or 0) + int(r[4] or 0) + int(r[5] or 0) for r in rows]
    ttft = [float(r[1]) for r in rows if r[1] is not None]
    msgs = [int(r[2]) for r in rows if r[2] is not None]
    denom = read + miss
    hit = (read / denom) if denom > 0 else None
    return {
        "count": n,
        "cache_hit_rate": hit,
        "cache_read_tokens": read,
        "cache_creation_tokens": create,
        "cache_miss_tokens": miss,
        "ctx_per_req_avg": sum(ctx_per_req) / n,
        "ctx_per_req_p95": _pct([float(v) for v in ctx_per_req], 0.95),
        "ttft_avg_ms": (sum(ttft) / len(ttft)) if ttft else None,
        "ttft_p95_ms": _pct(ttft, 0.95),
        "msg_count_avg": (sum(msgs) / len(msgs)) if msgs else None,
    }


def gate_trigger_count(conn: sqlite3.Connection, start: str, end: str) -> int:
    qmarks = ",".join("?" for _ in READ_TOOLS)
    row = conn.execute(
        f"""
        SELECT COUNT(*) FROM evoflow_obs_tool_invocations
        WHERE tool_name IN ({qmarks}) AND output_text LIKE ?
          AND ended_at >= ? AND ended_at < ?
        """,
        (*READ_TOOLS, GATE_MARKER, start, end),
    ).fetchone()
    return int(row[0] or 0)


def fmt_window(stats: dict, gate: int) -> str:
    if stats.get("count", 0) == 0:
        return "  (no completed model invocations in this window)"
    hit = stats["cache_hit_rate"]
    lines = [
        f"  model invocations:        {stats['count']}",
        f"  cache hit rate:           {'-' if hit is None else f'{hit * 100:.1f}%'}"
        f"   (read {stats['cache_read_tokens']:,} / miss {stats['cache_miss_tokens']:,} / creation {stats['cache_creation_tokens']:,})",
        f"  context per request avg:  {stats['ctx_per_req_avg']:,.0f} tokens  (p95 {stats['ctx_per_req_p95']:,.0f})",
        f"  first-token latency avg:  {'-' if stats['ttft_avg_ms'] is None else f'{stats['ttft_avg_ms']:,.0f} ms'}"
        f"  (p95 {'-' if stats['ttft_p95_ms'] is None else f'{stats['ttft_p95_ms']:,.0f} ms'})",
        f"  messages per request avg: {'-' if stats['msg_count_avg'] is None else f'{stats['msg_count_avg']:.1f}'}",
        f"  read gate triggers:       {gate}",
    ]
    return "\n".join(lines)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--split", required=True, help="ISO timestamp separating before/after (e.g. 2026-11-14T18:00)")
    ap.add_argument("--window-hours", type=float, default=None, help="Limit each window to the N hours before/after the split (default: full range)")
    ap.add_argument("--model", default=None, help="Substring filter on model name (e.g. claude)")
    ap.add_argument("--db", default=None, help="Path to evoflow_observability.db (default: auto-resolve)")
    args = ap.parse_args()

    split = args.split
    try:
        split = _normalize_boundary(split)
    except ValueError:
        raise SystemExit(f"--split is not an ISO timestamp: {args.split}")

    db = resolve_db_path(args.db)
    if not db.exists():
        raise SystemExit(f"observability db not found: {db}")
    conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True)

    before_start = _iso_minus_hours(args.window_hours) if args.window_hours else "1970-01-01T00:00"
    after_end = _now_iso()
    before = model_window_stats(conn, before_start, split, args.model)
    after = model_window_stats(conn, split, after_end, args.model)
    gate_before = gate_trigger_count(conn, before_start, split)
    gate_after = gate_trigger_count(conn, split, after_end)

    print(f"db: {db}")
    print(f"model filter: {args.model or '(all)'}")
    print()
    print(f"BEFORE  [{before_start} -> {split}]")
    print(fmt_window(before, gate_before))
    print()
    print(f"AFTER   [{split} -> {after_end}]")
    print(fmt_window(after, gate_after))
    print()

    if before.get("count") and after.get("count"):
        b, a = before["cache_hit_rate"], after["cache_hit_rate"]
        if b is not None and a is not None:
            print(f"cache hit rate: {b * 100:.1f}% -> {a * 100:.1f}%  ({'IMPROVED' if a > b + 0.02 else 'no clear gain' if abs(a - b) <= 0.02 else 'WORSE'})")
        bc, ac = before["ctx_per_req_avg"], after["ctx_per_req_avg"]
        print(f"context/request avg: {bc:,.0f} -> {ac:,.0f} tokens  ({'IMPROVED' if ac < bc * 0.95 else 'no clear gain' if abs(ac - bc) <= bc * 0.05 else 'WORSE'})")
        bt, at = before["ttft_avg_ms"], after["ttft_avg_ms"]
        if bt and at:
            print(f"TTFT avg: {bt:,.0f} -> {at:,.0f} ms  ({'IMPROVED' if at < bt * 0.95 else 'no clear gain' if abs(at - bt) <= bt * 0.05 else 'WORSE'})")
    else:
        print("Not enough data on one side of the split — run the app for a while after the change, then re-run.")
    conn.close()


if __name__ == "__main__":
    main()
