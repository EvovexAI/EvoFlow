"""工具延迟归因报表 —— 一条命令回答「我的工具为什么慢」。

【self-evolution-bot · 2026-11-19 · 第62轮 · 模型:deepseek-v4.1-flash-1017】

为什么需要它（不是我「觉得」需要，是拿数字换来的）
------------------------------------------------
用户 2026-11-19 说「你自己调用的终端工具和普通工具的极致速度处理」。我为了
拿「哪个工具慢、慢在哪一段」，在同一个会话里现写了 **12 个 python 探针**。
事后查观测库（近 1 天、全部 agent、12322 次调用）：

  bash 3821 次 / 6875s，其中
    · cd + python 探针  1283 次 / **2937s / 占 bash 总时长 44.5%**，avg 2289ms
    · pytest             420 次 / 2450s / 35.5%（任务本身，不该优化）
    · 其它 cd 简单命令    1938 次 / 987s / 14.3%

也就是说：**「工具慢」的最大单项是「我自己写探针查工具慢」**。
现写的每一行 `python -c` 要付：新进程启动 + `import evoflow.code_index.store`
约 154ms + 猜列名失败重试 + 我把 2GB 观测库读错的往返。
而纯 `sqlite3` 查同一件事只要 10ms —— 差两个数量级。

这已经是第 3 次栽在同一件事（见 craft/工具耗时与报错的观测入口.md、
craft/bash终端响应速度-实测瓶颈与已修项.md）：**bàsh 里最大的一块耗时可修，
但修法不是加快 bash，是别再用它干「本来有脚本」的活。**
`obs_query.py` 解决「别再猜列名」，本脚本解决「别再重写聚合」。

为什么不加进 obs_query.py
--------------------------
那个文件自己写着「不做聚合封装（P50/P95 之类留在 SQL 里写窗口函数）——
聚合口径会变，把它写死进脚本就等于把一次性的结论伪装成通用能力」。
那条判断对**任意** SQL 成立，但对本报表不成立：这里的口径只有一套
（见下「口径」一节），而且已经连续三轮被同一批问题反复问。所以独立成文件、
把口径钉死在 docstring 里，谁要改口径必须先改这段说明。

口径（改之前先想清楚为什么改）
------------------------------
· 时间：`started_at` 带 `+08:00`，一律
  `replace(substr(started_at,1,19),'T',' ') >= datetime('now','+8 hours','-N days')`。
  别用 `datetime(started_at)`——它会把 `+08:00` 再叠一次时区。
· 分位：对每个工具取自己的 duration_ms 全集排序后取下标，**不跨工具混算**。
· 外壳开销 = `duration_ms - exec_ms`（exec_ms 只在 bash 的 timing_json 里有）。
  这是「命令之外、工具之内」的钱：进程往返、输出装饰、落库。
  **它不等于「可优化量」**——里面有一部分是必要的观测写入，先看数再谈砍。
· python 探针判定：命令里出现 `python` 且以 `cd ` 开头、且不含 pytest/install。
  这是个**启发式**，只用于看趋势；要精确判定得看 exec_ms 与 import 成本。

用法
----
  python packages/harness/scripts/tool_latency_report.py            # 近 1 天
  python packages/harness/scripts/tool_latency_report.py --days 7
  python packages/harness/scripts/tool_latency_report.py --agent self-evolution-bot

只读：以 `mode=ro` 打开观测库，不写任何东西。
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import sys
from collections import Counter

_OBS_DB = os.path.expanduser(
    r"~/.evoflow/profiles/default/data/observability/evoflow_observability.db"
)

# bash 命令归类。顺序有意义：先命中先归，pytest/install 排在 cd 之前，
# 否则「cd backend && python -m pytest」会被归进 python 探针，把任务成本
# 算到「我写探针」头上——那会把归因引到错的方向。
_BASH_CATEGORIES: list[tuple[str, str]] = [
    ("pytest", r"\bpytest\b"),
    ("pip/uv install", r"\b(pip|uv)\s+install\b"),
    ("python 探针", r"\bpython\b"),
    ("git", r"\bgit\s"),
    ("npm/node", r"\b(npm|node|pnpm|yarn)\b"),
    ("find/ls 遍历", r"\b(find|ls)\s"),
    ("grep/rg 全树", r"\b(grep|rg)\s+-[a-zA-Z]*r"),
    ("sleep", r"\bsleep\s"),
    ("powershell", r"\bpowershell"),
    ("curl/web", r"\b(curl|wget)\b"),
]


def _connect() -> sqlite3.Connection:
    if not os.path.exists(_OBS_DB):
        sys.exit(f"观测库不存在：{_OBS_DB}")
    conn = sqlite3.connect(f"file:{_OBS_DB}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def _where(days: int, agent: str | None) -> tuple[str, list]:
    sql = (
        "replace(substr(started_at,1,19),'T',' ') "
        f">= datetime('now','+8 hours','-{int(days)} days')"
    )
    args: list = []
    if agent:
        sql += " AND agent_code = ?"
        args.append(agent)
    return sql, args


def _pct(sorted_vals: list[float], q: float) -> float:
    if not sorted_vals:
        return 0.0
    return sorted_vals[min(len(sorted_vals) - 1, int(len(sorted_vals) * q))]


def report_overview(conn: sqlite3.Connection, days: int, agent: str | None) -> None:
    where, args = _where(days, agent)
    rows = conn.execute(
        f"""
        SELECT tool_name,
               count(*) AS n,
               sum(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errs,
               sum(coalesce(duration_ms, 0)) AS tot
        FROM evoflow_obs_tool_invocations
        WHERE {where}
        GROUP BY tool_name
        ORDER BY tot DESC
        """,
        args,
    ).fetchall()
    if not rows:
        print("窗口内没有调用记录。")
        return

    grand = sum(r["tot"] for r in rows) / 1000.0
    print(f"\n=== 分工具延迟（近 {days} 天"
          f"{'，agent=' + agent if agent else '，全部 agent'}）===")
    print(f"{'tool':26s} {'n':>6s} {'err':>4s} {'P50':>8s} {'P90':>9s} "
          f"{'P99':>9s} {'max':>9s} {'总秒':>9s} {'占比':>6s}")
    for r in rows:
        vals = sorted(
            x[0]
            for x in conn.execute(
                f"SELECT duration_ms FROM evoflow_obs_tool_invocations "
                f"WHERE {where} AND tool_name = ? AND duration_ms IS NOT NULL",
                [*args, r["tool_name"]],
            )
        )
        if not vals:
            continue
        share = 100.0 * (r["tot"] / 1000.0) / grand if grand else 0.0
        print(
            f"{r['tool_name']:26s} {r['n']:6d} {r['errs']:4d} "
            f"{_pct(vals, .5):8.0f} {_pct(vals, .9):9.0f} {_pct(vals, .99):9.0f} "
            f"{vals[-1]:9.0f} {r['tot'] / 1000.0:9.1f} {share:5.1f}%"
        )
    print(f"{'合计':26s} {'':6s} {'':4s} {'':8s} {'':9s} {'':9s} {'':9s} "
          f"{grand:9.1f}")


def report_daily_trend(
    conn: sqlite3.Connection, days: int, agent: str | None, top: int = 4
) -> None:
    """按天看趋势。判据：P50 逐日抬升 = 持续劣化，不是偶发抖动。"""
    where, args = _where(days, agent)
    hottest = [
        r[0]
        for r in conn.execute(
            f"""
            SELECT tool_name FROM evoflow_obs_tool_invocations
            WHERE {where} GROUP BY tool_name
            ORDER BY sum(coalesce(duration_ms,0)) DESC LIMIT {int(top)}
            """,
            args,
        )
    ]
    print(f"\n=== 按天趋势（总耗时前 {top} 的工具）===")
    for tool in hottest:
        day_rows = conn.execute(
            f"""
            SELECT substr(started_at,1,10) AS d, count(*) AS n
            FROM evoflow_obs_tool_invocations
            WHERE {where} AND tool_name = ?
            GROUP BY d ORDER BY d
            """,
            [*args, tool],
        ).fetchall()
        if len(day_rows) < 2:
            continue
        print(f"\n  {tool}")
        for d in day_rows:
            vals = sorted(
                x[0]
                for x in conn.execute(
                    f"SELECT duration_ms FROM evoflow_obs_tool_invocations "
                    f"WHERE {where} AND tool_name = ? AND substr(started_at,1,10) = ? "
                    f"AND duration_ms IS NOT NULL",
                    [*args, tool, d["d"]],
                )
            )
            if not vals:
                continue
            print(
                f"    {d['d']}  n={d['n']:5d}  P50={_pct(vals, .5):7.0f}  "
                f"P90={_pct(vals, .9):8.0f}  max={vals[-1]:8.0f}"
            )


def report_bash(conn: sqlite3.Connection, days: int, agent: str | None) -> None:
    where, args = _where(days, agent)
    rows = conn.execute(
        f"""
        SELECT duration_ms, input_json, timing_json
        FROM evoflow_obs_tool_invocations
        WHERE {where} AND tool_name = 'bash'
        """,
        args,
    ).fetchall()
    if not rows:
        print("\n（窗口内没有 bash 调用）")
        return

    total_ms = sum(r["duration_ms"] or 0 for r in rows)
    cat_n: Counter = Counter()
    cat_ms: Counter = Counter()
    for r in rows:
        try:
            cmd = (json.loads(r["input_json"] or "{}") or {}).get("command", "") or ""
        except Exception:
            cmd = ""
        low = cmd.lower()
        for name, pat in _BASH_CATEGORIES:
            if re.search(pat, low):
                cat_n[name] += 1
                cat_ms[name] += r["duration_ms"] or 0
                break
        else:
            cat_n["其它"] += 1
            cat_ms["其它"] += r["duration_ms"] or 0

    print(f"\n=== bash 归因（{len(rows)} 次，总 {total_ms / 1000:.0f}s）===")
    print(f"{'类别':18s} {'n':>6s} {'总秒':>9s} {'占比':>7s} {'avg':>8s}")
    for name, ms in cat_ms.most_common():
        n = cat_n[name]
        print(
            f"{name:18s} {n:6d} {ms / 1000:9.1f} "
            f"{100.0 * ms / max(total_ms, 1):6.1f}% {ms / max(n, 1):8.0f}ms"
        )

    # 外壳开销：命令之外、工具之内。别把它直接当「可砍的量」。
    gaps = []
    for r in rows:
        try:
            timing = json.loads(r["timing_json"] or "{}")
        except Exception:
            continue
        exec_ms = timing.get("exec_ms")
        if exec_ms and r["duration_ms"]:
            gaps.append(r["duration_ms"] - exec_ms)
    if gaps:
        gaps.sort()
        print(
            f"\n  外壳开销 duration_ms - exec_ms：n={len(gaps)} "
            f"P50={_pct(gaps, .5):.0f}ms P90={_pct(gaps, .9):.0f}ms "
            f"合计={sum(gaps) / 1000:.0f}s"
        )
        print("  （含必要的观测落库与输出装饰，不等于可优化量）")


def main() -> None:
    ap = argparse.ArgumentParser(description="工具延迟归因报表（只读观测库）")
    ap.add_argument("--days", type=int, default=1, help="回看天数，默认 1")
    ap.add_argument("--agent", default=None, help="只看某个 agent_code")
    ap.add_argument("--no-bash", action="store_true", help="跳过 bash 归因段")
    ns = ap.parse_args()

    conn = _connect()
    try:
        report_overview(conn, ns.days, ns.agent)
        report_daily_trend(conn, ns.days, ns.agent)
        if not ns.no_bash:
            report_bash(conn, ns.days, ns.agent)
        print("\n提示：慢≠该优化。pytest/构建/嵌入计算是任务本身；"
              "先看「python 探针」与外壳开销这两栏。")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
