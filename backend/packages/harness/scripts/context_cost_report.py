#!/usr/bin/env python
"""上下文成本报表：谁在往上下文里灌字节、缓存命不命中、TTFT 花在哪。

用法（在 backend/ 下，不需要 PYTHONPATH）：
    python packages/harness/scripts/context_cost_report.py --days 7
    python packages/harness/scripts/context_cost_report.py --days 2 --top 10

【self-evolution-bot · 2026-11-19 · 第67轮 · 模型:deepseek-v4.1-flash-1017】新建。
为什么：已有 tool_latency_report（工具耗时）与 agent_self_metrics（错误率/慢调用），
但**「工具返回值体积 → 上下文膨胀 → TTFT」这条链没有现成脚本**，我每轮现写
`python - <<EOF` 长探针（近 7 天 265 次）。固化成脚本后一条命令即可。

只读：`file:...?mode=ro`，不写观测库。
"""

from __future__ import annotations

import argparse
import os
import sqlite3
import sys
from pathlib import Path


def _default_db() -> Path:
    """与 obs_query.py 同一套口径：EVOFLOW_HOME 已是 profiles/default，只拼相对路径。

    【self-evolution-bot · 2026-11-19 · 第67轮 · 模型:deepseek-v4.1-flash-1017】
    最初我按 ``~/.evoflow/profiles/default`` 拼，实测 ``EVOFLOW_HOME`` 本身就已指向
    ``.../profiles/default``，于是拼成 ``profiles/default/profiles/default/...`` 找不到库。
    """
    rel = Path("data") / "observability" / "evoflow_observability.db"
    home = (os.environ.get("EVOFLOW_HOME") or "").strip()
    if home:
        p = Path(home).expanduser() / rel
        if p.is_file():
            return p
    base = Path.home() / ".evoflow" / "profiles"
    if base.is_dir():
        preferred = base / "default" / rel
        if preferred.is_file():
            return preferred
        cands = [q / rel for q in sorted(base.iterdir()) if (q / rel).is_file()]
        if cands:
            return max(cands, key=lambda x: x.stat().st_mtime)
    return Path.home() / ".evoflow" / "profiles" / "default" / rel


def _connect(db: Path) -> sqlite3.Connection:
    if not db.is_file():
        raise SystemExit(f"观测库不存在: {db}（用 --db 指定，或确认 EVOFLOW_HOME）")
    return sqlite3.connect(f"file:{db}?mode=ro", uri=True)


def _window(days: int) -> str:
    """窗口条件，格式必须与存储值一致。

    【self-evolution-bot · 2026-11-19 · 第67轮 · 模型:deepseek-v4.1-flash-1017】
    踩了两个坑，都静默返回空表：
    1. ``datetime('now','-7 days','local time')`` —— ``'local time'`` **不是合法修饰符**
       （正确的是 ``'localtime'``），SQLite 对未知修饰符返回 **NULL**，比较条件全为假 ⇒ 0 行。
    2. 存储值是 ``2026-11-19T13:15:51.868000+08:00``（带 ``T`` 与偏移），
       而 ``datetime()`` 产出 ``2026-11-19 13:15:51``（空格分隔）。
       字典序比较时 ``'T'(0x54) > ' '(0x20)``，边界那一天会被整片放进/挡掉。
    故用 ``strftime('%Y-%m-%dT%H:%M:%S', 'now', 'localtime', '-N days')`` 对齐格式。
    """
    return (
        "started_at >= strftime('%Y-%m-%dT%H:%M:%S', 'now', 'localtime', "
        f"'-{int(days)} days')"
    )


def report_tool_output(cur: sqlite3.Cursor, days: int, top: int) -> None:
    print(f"=== 工具返回值体积（近 {days} 天，进上下文后永久留存）===")
    cur.execute(
        f"""SELECT tool_name, count(*) n,
                   avg(length(COALESCE(output_text,''))) avg_len,
                   sum(length(COALESCE(output_text,''))) total
            FROM evoflow_obs_tool_invocations
            WHERE {_window(days)}
            GROUP BY tool_name ORDER BY total DESC LIMIT {int(top)}"""
    )
    rows = cur.fetchall()
    if not rows:
        print("  （无数据）")
        return
    grand = sum(r[3] or 0 for r in rows)
    print(f"  {'tool':24s} {'n':>6s} {'avg':>8s} {'total':>10s} {'占比':>7s}")
    for name, n, avg_len, total in rows:
        share = (total or 0) * 100.0 / grand if grand else 0
        print(f"  {str(name):24s} {n:6d} {float(avg_len or 0):7.0f}B "
              f"{float(total or 0) / 1048576:9.2f}MB {share:6.1f}%")
    print(f"  → 合计 {grand / 1048576:.1f}MB 文本")


def report_model_context(cur: sqlite3.Cursor, days: int) -> None:
    print(f"\n=== 模型上下文与缓存（近 {days} 天，invocation_kind=main）===")
    cur.execute(
        f"""SELECT count(*), avg(cache_read_tokens), avg(cache_miss_tokens),
                   avg(message_count), avg(first_token_latency_ms), avg(latency_ms),
                   avg(cache_creation_tokens)
            FROM evoflow_obs_model_invocations
            WHERE {_window(days)} AND invocation_kind='main'"""
    )
    n, hit, miss, msgs, ttft, lat, created = cur.fetchone()
    if not n:
        print("  （无数据）")
        return
    hit, miss = float(hit or 0), float(miss or 0)
    total = hit + miss
    rate = hit * 100.0 / total if total else 0
    print(f"  调用 {n} | 消息数均值 {float(msgs or 0):.0f}")
    print(f"  缓存命中 {hit / 1000:.1f}k / 未命中 {miss / 1000:.1f}k "
          f"→ 命中率 {rate:.1f}% | 新建 {float(created or 0) / 1000:.1f}k")
    print(f"  TTFT {float(ttft or 0):.0f}ms | 整轮 {float(lat or 0) / 1000:.1f}s")
    print("  提示：未命中占多数时，压上下文/改提示词/换模型都会让下轮全量重算——"
          "先看这个数再决定")


def report_ttft_buckets(cur: sqlite3.Cursor, days: int) -> None:
    print(f"\n=== TTFT 按未命中量分桶（近 {days} 天）===")
    cur.execute(
        f"""SELECT CASE
                 WHEN CAST(cache_miss_tokens AS REAL) < 6000 THEN '<6k'
                 WHEN CAST(cache_miss_tokens AS REAL) < 15000 THEN '6-15k'
                 WHEN CAST(cache_miss_tokens AS REAL) < 30000 THEN '15-30k'
                 ELSE '>=30k' END bucket,
               count(*), avg(first_token_latency_ms), avg(latency_ms)
            FROM evoflow_obs_model_invocations
            WHERE {_window(days)} AND invocation_kind='main'
            GROUP BY bucket ORDER BY min(CAST(cache_miss_tokens AS REAL))"""
    )
    for bucket, n, ttft, lat in cur.fetchall():
        print(f"  {bucket:8s} n={n:6d} TTFT={float(ttft or 0):7.0f}ms "
              f"整轮={float(lat or 0) / 1000:6.1f}s")


def report_volume_by_agent(cur: sqlite3.Cursor, days: int, top: int) -> None:
    print(f"\n=== 按岗位（近 {days} 天，main 调用）===")
    cur.execute(
        f"""SELECT agent_code, count(*) n, avg(latency_ms) lat,
                   sum(CAST(latency_ms AS REAL)) total
            FROM evoflow_obs_model_invocations
            WHERE {_window(days)} AND invocation_kind='main'
            GROUP BY agent_code ORDER BY total DESC LIMIT {int(top)}"""
    )
    rows = cur.fetchall()
    grand = sum(float(r[3] or 0) for r in rows) or 1
    for code, n, lat, total in rows:
        print(f"  {str(code):24s} n={n:6d} 平均{float(lat or 0) / 1000:6.1f}s "
              f"合计{float(total or 0) / 3600000:6.1f}h ({float(total or 0) * 100 / grand:4.1f}%)")


def report_low_cache_hits(cur: sqlite3.Cursor, days: int, top: int) -> None:
    """命中率偏低的单次调用，方便对照 run/seq/消息条数排查。"""
    print(f"\n=== 缓存命中偏低样本（近 {days} 天，main，命中率<30%）===")
    cur.execute(
        f"""SELECT id, model, model_call_seq, message_count,
                   COALESCE(cache_read_tokens,0), COALESCE(cache_miss_tokens,0),
                   COALESCE(cache_creation_tokens,0), started_at, thread_id
            FROM evoflow_obs_model_invocations
            WHERE {_window(days)} AND invocation_kind='main'
              AND (COALESCE(cache_read_tokens,0) + COALESCE(cache_miss_tokens,0)
                   + COALESCE(cache_creation_tokens,0)) > 0
            ORDER BY
              CASE
                WHEN (COALESCE(cache_read_tokens,0)+COALESCE(cache_miss_tokens,0)) > 0
                THEN CAST(COALESCE(cache_read_tokens,0) AS REAL)
                     / (COALESCE(cache_read_tokens,0)+COALESCE(cache_miss_tokens,0))
                ELSE 0 END ASC,
              COALESCE(cache_miss_tokens,0) DESC
            LIMIT {int(top) * 3}"""
    )
    rows = cur.fetchall()
    shown = 0
    for row in rows:
        _id, model, seq, msgs, read, miss, create, started, thread = row
        denom = float(read or 0) + float(miss or 0)
        if denom <= 0:
            denom = float(read or 0) + float(create or 0)
        rate = (float(read or 0) * 100.0 / denom) if denom else None
        if rate is not None and rate >= 30:
            continue
        shown += 1
        rate_s = f"{rate:.1f}%" if rate is not None else "—"
        print(
            f"  {rate_s:>6s} read={int(read or 0):6d} miss={int(miss or 0):6d} "
            f"seq={seq or '—'} msgs={msgs or '—'} "
            f"model={str(model or '')[:28]} thread={str(thread or '')[:16]} "
            f"at={str(started or '')[:19]}"
        )
        if shown >= int(top):
            break
    if not shown:
        print("  （无偏低样本，或窗口内无缓存字段）")
    else:
        print("  → 点开运维观测「调用记录」详情看 cache_hit_notes；首轮冷启动属正常")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="上下文成本报表（只读观测库）")
    ap.add_argument("--days", type=int, default=7)
    ap.add_argument("--db", default="", help="观测库路径（默认用 EVOFLOW_HOME）")
    ap.add_argument("--top", type=int, default=8)
    args = ap.parse_args(argv)

    db = Path(args.db) if args.db else _default_db()
    conn = _connect(db)
    cur = conn.cursor()
    print(f"# {db}\n")
    report_tool_output(cur, args.days, args.top)
    report_model_context(cur, args.days)
    report_ttft_buckets(cur, args.days)
    report_volume_by_agent(cur, args.days, args.top)
    report_low_cache_hits(cur, args.days, args.top)
    conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
