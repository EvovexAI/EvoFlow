#!/usr/bin/env python3
"""Daily health report for AI-interaction quality & latency (observability DB).

Reads the observability SQLite store that vendor_roundtrip fills on every model
call and answers "is each AI turn getting better?" with per-day trends plus
threshold verdicts:

  performance  — TTFT p50/p95, ctx/req p95 (compaction cap should keep it
                 < 150K), cache hit rate, model failure rate
  behavior     — tool error rate + top error types (freshness suffix /
                 next-step error hints / loop guard should push this down),
                 read whole-file gate triggers

Verdict per day: HEALTHY / WATCH / ALERT against the thresholds below.
Exit code 0 always; the text verdict is the deliverable (cron-friendly).

Usage (from backend/):
  python scripts/context_health_report.py                     # last 7 days
  python scripts/context_health_report.py --days 14 --model qwen
  python scripts/context_health_report.py --db path/to/db --json
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from pathlib import Path

# Thresholds: WATCH = trending wrong, ALERT = act now.
THRESHOLDS = {
    "ttft_p95_ms": 5000,       # >5s p95 = prefill/latency pain
    "ctx_p95_tokens": 150_000, # compaction absolute cap; above = cap not working
    "cache_hit_rate": 0.70,    # vendor auto prefix cache baseline is ~0.9
    "tool_error_rate": 0.15,   # ToolReturnedError includes benign misses; watch trend
    "model_fail_rate": 0.02,
}


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


def day_stats(conn: sqlite3.Connection, day: str, model_like: str) -> dict:
    mw = "AND model LIKE ?" if model_like else ""
    mp = (f"%{model_like}%",) if model_like else ()
    inv = conn.execute(
        f"""SELECT COUNT(*),
                   SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END)
            FROM evoflow_obs_model_invocations WHERE substr(requested_at,1,10)=? {mw}""",
        (day, *mp),
    ).fetchone()
    total, done = int(inv[0] or 0), int(inv[1] or 0)
    out: dict = {"invocations": total, "fail_rate": None, "ttft_p50": None, "ttft_p95": None,
                 "ctx_p95": None, "cache_hit": None, "ctx_gt_cap": None}
    if total:
        out["fail_rate"] = 1 - done / total
    rows = conn.execute(
        f"""SELECT first_token_latency_ms,
                   COALESCE(cache_read_tokens,0)+COALESCE(cache_creation_tokens,0)+COALESCE(cache_miss_tokens,0),
                   COALESCE(cache_read_tokens,0), COALESCE(cache_miss_tokens,0), COALESCE(cache_creation_tokens,0)
            FROM evoflow_obs_model_invocations
            WHERE substr(requested_at,1,10)=? AND status='completed' AND first_token_latency_ms IS NOT NULL {mw}""",
        (day, *mp),
    ).fetchall()
    if rows:
        ttfts = [float(r[0]) for r in rows]
        ctxs = [float(r[1]) for r in rows]
        out["ttft_p50"] = _pct(ttfts, 0.50)
        out["ttft_p95"] = _pct(ttfts, 0.95)
        out["ctx_p95"] = _pct(ctxs, 0.95)
        out["ctx_gt_cap"] = sum(1 for c in ctxs if c > THRESHOLDS["ctx_p95_tokens"])
        read = sum(int(r[2]) for r in rows)
        miss = sum(int(r[3]) for r in rows)
        denom = read + miss
        if denom > 0:
            out["cache_hit"] = read / denom
    tools = conn.execute(
        f"""SELECT COUNT(*),
                   SUM(CASE WHEN status!='success' OR error_type IS NOT NULL THEN 1 ELSE 0 END)
            FROM evoflow_obs_tool_invocations WHERE substr(ended_at,1,10)=? {mw}""",
        (day, *mp),
    ).fetchone()
    t_total, t_err = int(tools[0] or 0), int(tools[1] or 0)
    out["tool_calls"] = t_total
    out["tool_error_rate"] = (t_err / t_total) if t_total else None
    # Loop-guard interceptions (PR #109 LoopDetectionMiddleware) are healthy
    # behavior, not failures — count them separately and exclude from the
    # error rate so the trend stays readable.
    guard = conn.execute(
        f"""SELECT COUNT(*) FROM evoflow_obs_tool_invocations
            WHERE substr(ended_at,1,10)=? AND error_message LIKE '%重复探索·已拦截%' {mw}""",
        (day, *mp),
    ).fetchone()[0]
    out["loop_guard_blocks"] = int(guard)
    out["tool_error_rate"] = ((t_err - int(guard)) / t_total) if t_total else None
    gate = conn.execute(
        f"""SELECT COUNT(*) FROM evoflow_obs_tool_invocations
            WHERE substr(ended_at,1,10)=? AND tool_name IN ('read','read_file','read_files')
              AND output_text LIKE '%Showing lines 1-%' {mw}""",
        (day, *mp),
    ).fetchone()[0]
    out["read_gate_triggers"] = int(gate)
    errs = conn.execute(
        f"""SELECT COALESCE(error_type,'?'), COUNT(*) FROM evoflow_obs_tool_invocations
            WHERE substr(ended_at,1,10)=? AND (status!='success' OR error_type IS NOT NULL) {mw}
            GROUP BY 1 ORDER BY 2 DESC LIMIT 3""",
        (day, *mp),
    ).fetchall()
    out["top_tool_errors"] = [(str(a), int(b)) for a, b in errs]
    return out


def verdict(stats: dict) -> tuple[str, list[str]]:
    if stats.get("invocations", 0) == 0:
        return "—", []
    reasons: list[str] = []
    level = "HEALTHY"
    def raise_to(new: str) -> None:
        nonlocal level
        order = {"HEALTHY": 0, "WATCH": 1, "ALERT": 2}
        if order[new] > order[level]:
            level = new
    tp = stats.get("ttft_p95")
    if tp is not None and tp > THRESHOLDS["ttft_p95_ms"]:
        reasons.append(f"TTFT p95 {tp:.0f}ms > {THRESHOLDS['ttft_p95_ms']}ms")
        raise_to("ALERT" if tp > THRESHOLDS["ttft_p95_ms"] * 2 else "WATCH")
    cp = stats.get("ctx_p95")
    if cp is not None and cp > THRESHOLDS["ctx_p95_tokens"]:
        reasons.append(f"ctx p95 {cp:,.0f} > cap {THRESHOLDS['ctx_p95_tokens']:,}")
        raise_to("ALERT")
    if stats.get("ctx_gt_cap"):
        reasons.append(f"{stats['ctx_gt_cap']} requests over 150K cap")
        raise_to("WATCH")
    ch = stats.get("cache_hit")
    if ch is not None and ch < THRESHOLDS["cache_hit_rate"]:
        reasons.append(f"cache hit {ch * 100:.1f}% < {THRESHOLDS['cache_hit_rate'] * 100:.0f}%")
        raise_to("WATCH")
    te = stats.get("tool_error_rate")
    if te is not None and te > THRESHOLDS["tool_error_rate"]:
        reasons.append(f"tool error rate {te * 100:.1f}% > {THRESHOLDS['tool_error_rate'] * 100:.0f}%")
        raise_to("WATCH")
    mf = stats.get("fail_rate")
    if mf is not None and mf > THRESHOLDS["model_fail_rate"]:
        reasons.append(f"model failure rate {mf * 100:.1f}%")
        raise_to("ALERT")
    return level, reasons


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--days", type=int, default=7)
    ap.add_argument("--model", default=None, help="Substring filter on model name")
    ap.add_argument("--db", default=None)
    ap.add_argument("--json", action="store_true", help="Emit machine-readable JSON instead of text")
    args = ap.parse_args()

    db = resolve_db_path(args.db)
    if not db.exists():
        raise SystemExit(f"observability db not found: {db}")
    conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    days = [r[0] for r in conn.execute(
        "SELECT DISTINCT substr(requested_at,1,10) FROM evoflow_obs_model_invocations ORDER BY 1 DESC LIMIT ?",
        (args.days,),
    ).fetchall()][::-1]
    report = []
    for day in days:
        s = day_stats(conn, day, args.model or "")
        v, reasons = verdict(s)
        s["day"], s["verdict"], s["reasons"] = day, v, reasons
        report.append(s)
    conn.close()

    if args.json:
        print(json.dumps({"db": str(db), "thresholds": THRESHOLDS, "days": report},
                         ensure_ascii=False, indent=2, default=str))
        return

    print(f"AI-interaction health report  db={db}")
    print(f"model filter: {args.model or '(all)'}   thresholds: {THRESHOLDS}")
    print()
    hdr = ("day         verdict  inv    TTFT p50/p95       ctx p95    cache hit  tool err  gate")
    print(hdr)
    for s in report:
        ttft = "-" if s.get("ttft_p50") is None else f"{s['ttft_p50']:.0f}/{s['ttft_p95']:.0f}ms"
        ctx = "-" if s.get("ctx_p95") is None else f"{s['ctx_p95']:,.0f}"
        ch = "-" if s.get("cache_hit") is None else f"{s['cache_hit'] * 100:.0f}%"
        te = "-" if s.get("tool_error_rate") is None else f"{s['tool_error_rate'] * 100:.1f}%"
        print(f"{s['day']}  {s['verdict']:7s}  {s['invocations']:4d}  {ttft:>16s}  {ctx:>9s}  {ch:>9s}  {te:>8s}  {s['read_gate_triggers']:4d}")
    print()
    flagged = [s for s in report if s["verdict"] in ("WATCH", "ALERT")]
    if flagged:
        print("needs attention:")
        for s in flagged:
            print(f"  [{s['verdict']}] {s['day']}: {'; '.join(s['reasons'])}")
            if s.get("top_tool_errors"):
                print(f"      top tool errors: {s['top_tool_errors']}")
    else:
        print("all days HEALTHY against thresholds.")


if __name__ == "__main__":
    main()
