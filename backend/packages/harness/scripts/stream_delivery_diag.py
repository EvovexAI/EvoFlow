"""流式「没返回 / 过一会整段显示」一条命令定位：是没推，还是推了屏幕收不到。

【self-evolution-bot · 2026-11-27 · 第140轮 · 模型:deepseek-v4-1-flash-261017】
新建。为什么要有它：第139轮定案「流式没返回」= 404 remint 换线程后镜像仍按旧 tid
记账，取证靠临时手写 python 探针按 event+tid 分桶。同类查询每轮重写一遍本身就是
一笔固定开销（我自己的 journal 反复记过：别现写探针，固化成脚本复用）。
本脚本把那次取证固化成一条命令。

判据（分清两类，处置完全不同）
------------------------------
① **真没推**：上游没出 token（TTFT 慢 / 模型报错 / 空流）。
② **推了但屏幕收不到**：事件落进没人订阅的投影（线程 ID 漂移，即 remint 后
   镜像/编码器没跟到新 tid）。用户眼里①②一模一样，只有这个脚本能分开。

决定性证据 = 同一次 remint 前后，``feed_events`` 落在**旧 tid**还是**新 tid**。
   旧 tid 有量、新 tid 为 0  → ②（本仓 2026-11-27 实测：旧 3060 条 / 三个新 tid 各 0 条）
   新 tid 有量            → 已跟到新 tid（修好了）
   两边都 0               → 该轮在窗口内没流（空流/未开轮），**不能当证据**

用法
----
    python backend/packages/harness/scripts/stream_delivery_diag.py --days 1
    python backend/packages/harness/scripts/stream_delivery_diag.py --date 2026-11-27 --since 18:50 --until 18:57
    python backend/packages/harness/scripts/stream_delivery_diag.py --log <日志目录或单个文件>

边界
----
- **只读**：只按行扫日志，不写文件、不碰库、不起服务、零依赖（只用 stdlib）。
- 诊断文件里的 tid 是**截断到 24 字符**的（``_diag_log(tid=tid[:24])``），
  所以配对一律按 24 字符前缀比，别拿完整 uuid 直接等值比较（那样恒为 0，
  且看起来像「没有」——最典型的假零）。
- 单测在隔离前的版本里会用字面量 tid（``remint-old-thread``）写进现网诊断文件。
  本脚本会**把带测试字面量的行单独计数并排除**，同时在输出里显式报出被排除多少条，
  不静默过滤（否则「0」只代表我的过滤器没命中）。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from collections import Counter
from datetime import date, timedelta
from pathlib import Path

_MIRROR_TS_RE = re.compile(r"^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})")
_REMINT_RE = re.compile(
    r"\[LG-ROUTE\] 404 remint v4 rehydrate old=([0-9a-f-]{20,}) new=([0-9a-f-]{20,})"
    r"(?: rows=(\d+))?(?: sk=(\S+))?"
)
_REMAP_DIAG_RE = re.compile('"event": "remap_thread"')
_REMAP_LOG_RE = re.compile(r"404 remint mirror remap old=([0-9a-f-]{20,}) new=([0-9a-f-]{20,})")
_TEST_TID_MARKERS = ("remint-old-thread", "remint-new-thread")


def resolve_log_dir(explicit: str = "") -> Path | None:
    if explicit:
        p = Path(explicit).expanduser()
        return p if p.exists() else None
    raw = (os.environ.get("EVOFLOW_LOGS_DIR") or "").strip()
    if raw:
        p = Path(raw).expanduser().resolve()
        if p.exists():
            return p
    home = (os.environ.get("EVOFLOW_HOME") or "").strip()
    candidates = []
    if home:
        base = Path(home).expanduser().resolve()
        candidates.append((base.parent if base.name.lower() == "data" else base) / "logs")
    candidates.append(Path.home() / ".evoflow" / "logs")
    candidates.append(Path.home() / ".evoflow-dev" / "logs")
    for c in candidates:
        if c.exists():
            return c
    return None


def _pick(directory: Path, prefix: str, day: str) -> Path | None:
    p = directory / f"{prefix}-{day}.log"
    return p if p.exists() else None


def _scan_remints(gw: Path, lo_hhmm: str, hi_hhmm: str) -> list[dict]:
    """从网关日志里取当天的 remint 事件（含新代码的 remap 成功日志）。"""
    out: list[dict] = []
    with gw.open("r", encoding="utf-8", errors="ignore") as fh:
        for line in fh:
            if "remint" not in line:
                continue
            m = _MIRROR_TS_RE.match(line)
            if not m:
                continue
            hhmm = m.group(1)[11:16]
            if lo_hhmm and hhmm < lo_hhmm:
                continue
            if hi_hhmm and hhmm > hi_hhmm:
                continue
            ts = m.group(1)
            r = _REMINT_RE.search(line)
            if r:
                out.append(
                    {
                        "ts": ts,
                        "old": r.group(1),
                        "new": r.group(2),
                        "rows": int(r.group(3) or 0),
                        "sk": r.group(4) or "",
                        "remapped": False,
                    }
                )
                continue
            rm = _REMAP_LOG_RE.search(line)
            if rm:
                out.append(
                    {
                        "ts": ts,
                        "old": rm.group(1),
                        "new": rm.group(2),
                        "rows": 0,
                        "sk": "",
                        "remapped": True,
                    }
                )
    return out


def _scan_feeds(diag: Path, lo_hhmm: str, hi_hhmm: str):
    """按 (event, tid前缀) 全量分桶；测试字面量单列，不静默丢。

    【self-evolution-bot · 2026-11-27 · 第140轮 · 模型:deepseek-v4-1-flash-261017】
    同时返回**带秒时间戳的 feed_events 明细**：remint 配对必须按「remint 时刻 →
    下一 remint 时刻」分段统计。头一版按整个窗口累加，导致同一天 3 次 remint 每行
    都重复报「旧 3060 / 新 0」——三次其实是三个不同区间的数，重复报数等于编数字。

    返回 (buckets, test_row_count, total_rows, remap_events, feed_timeline)
    feed_timeline: [(HH:MM:SS, tid_prefix), ...] 仅 feed_events
    """
    buckets: Counter[tuple[str, str]] = Counter()
    test_rows = 0
    total = 0
    remaps = 0
    feed_timeline: list[tuple[str, str]] = []
    with diag.open("r", encoding="utf-8", errors="ignore") as fh:
        for line in fh:
            i = line.find("{")
            if i < 0:
                continue
            m = _MIRROR_TS_RE.match(line)
            if not m:
                continue
            ts = m.group(1)
            hhmm = ts[11:16]
            if lo_hhmm and hhmm < lo_hhmm:
                continue
            if hi_hhmm and hhmm > hi_hhmm:
                continue
            try:
                d = json.loads(line[i:])
            except Exception:
                continue
            total += 1
            if _REMAP_DIAG_RE.search(line):
                remaps += 1
            ev = str(d.get("event") or "?")
            tid = str(d.get("tid") or "")
            if any(mk in tid for mk in _TEST_TID_MARKERS) or (
                tid and tid not in ("", "-") and len(tid) < 8
            ):
                test_rows += 1
                continue
            buckets[(ev, tid[:24])] += 1
            if ev == "feed_events":
                feed_timeline.append((ts[11:19], tid[:24]))
    return buckets, test_rows, total, remaps, feed_timeline


def analyze(day: str, lo: str, hi: str, logdir: Path) -> int:
    gw = _pick(logdir, "gateway", day)
    diag = _pick(logdir, "v4-mirror-diag", day.replace("-", ""))
    if gw is None and diag is None:
        print(f"[stream-diag] {day} 没有 gateway-*.log 也没有 v4-mirror-diag-*.log", file=sys.stderr)
        return 2

    print("=" * 74)
    print(f"流式投递诊断 · {day} · 窗口 {lo or '00:00'}~{hi or '23:59'} · 数据源 {logdir}")
    print(f"  网关日志: {gw.name if gw else '（缺）'}")
    print(f"  镜像诊断: {diag.name if diag else '（缺，说明镜像被禁或当天无流）'}")
    print("=" * 74)

    remints = _scan_remints(gw, lo, hi) if gw else []
    real_remints = [r for r in remints if not r["remapped"]]
    remap_logs = [r for r in remints if r["remapped"]]

    # ---- 【1】remint 事件 ----
    print("\n【1】404 remint 换线程事件（本症状的必要条件）")
    if not remints:
        print("  0 条：本轮**没有换线程** → 不是「投影漂移」这一类，去查上游/模型侧（见【4】）")
    else:
        for r in remints:
            tag = "remap已执行" if r["remapped"] else "remint"
            print(f"  {r['ts']} [{tag}] old={r['old'][:24]} → new={r['new'][:24]}"
                  f"{f' rows={r['rows']}' if r['rows'] else ''}{f' sk={r['sk']}' if r['sk'] else ''}")
    if real_remints and not remap_logs:
        print("  ⚠ 有 remint 但**没有** `mirror remap` 日志：要么新代码未生效（需重启网关），"
              "要么真的没迁 —— 这就是用户看到「流式没返回」的形态")

    if diag is None:
        print("\n无镜像诊断文件，后续分项跳过。")
        return 0

    # ---- 【2】feed_events 全量分桶（先看取值域，再谈结论）----
    buckets, test_rows, total_rows, remap_events, feed_timeline = _scan_feeds(diag, lo, hi)
    print("\n【2】镜像事件全量分桶（不带任何过滤条件，先看取值域）")
    print(f"  事件总数 {total_rows} 行；其中测试字面量行 **{test_rows}** 行已排除出统计"
          f"（排除不是静默：这里显式报数）")
    ev_c = Counter()
    for (ev, _tid), n in buckets.items():
        ev_c[ev] += n
    for ev, n in ev_c.most_common():
        print(f"  {n:>8}  {ev}")
    if remap_events:
        print(f"  其中 remap_thread 诊断事件 **{remap_events}** 条 → 迁移代码真的在跑")
    elif real_remints:
        print("  其中 remap_thread 诊断事件 0 条 → 迁移代码**没有**执行（重启前/未接线）")

    # ---- 【3】逐个 remint 配对：旧 tid vs 新 tid（按 remint 时刻分段）----
    print("\n【3】关键判据：remint 之后 feed_events 落在哪个 tid（前缀 24 字符比对）")
    if not real_remints:
        print("  无 remint 事件，本项不适用。")
    else:
        # 【self-evolution-bot · 2026-11-27 · 第140轮 · 模型:deepseek-v4-1-flash-261017】
        # 分段：第 i 次 remint 的统计区间 = [本次时刻, 下一次 remint 时刻)，最后一次到窗口尾。
        # 头一版对每次 remint 都拿整个窗口累加，同一天 3 次 remint 就三行都报
        # 「旧 3060 / 新 0」——那是把同一个数复读三次当三份证据，属编数字。
        cuts = [r["ts"][11:19] for r in real_remints] + ["99:99:99"]
        for idx, r in enumerate(real_remints):
            old_p = r["old"][:24]
            new_p = r["new"][:24]
            seg_lo = cuts[idx]
            seg_hi = cuts[idx + 1]
            old_n = sum(
                1 for (t, tid) in feed_timeline if seg_lo <= t < seg_hi and tid == old_p
            )
            new_n = sum(
                1 for (t, tid) in feed_timeline if seg_lo <= t < seg_hi and tid == new_p
            )
            print(f"  {r['ts']} old={old_p} → new={new_p}")
            print(
                f"     区间 [{seg_lo}, {seg_hi})  旧 tid feed_events={old_n:<6}"
                f" 新 tid feed_events={new_n:<6}",
                end="",
            )
            if new_n > 0:
                print("  ⇒ 已跟到新 tid（已修复 / 未受影响）")
            elif old_n > 0:
                print("  ⇒ **② 推了但屏幕收不到（投影漂移）**：本轮修复针对的就是这个")
            else:
                print("  ⇒ 两边都 0：该区间没有流，**不能当证据**（别报成「0 = 没修好」）")

    # ---- 【4】若没有 remint，给出另一条路 ----
    print("\n【4】分流指引")
    print("  有 remint + 旧 tid 有量 + 新 tid 0 → 投影漂移：查 remint 分支两处接线")
    print("      （mirror_remap_thread 调用 / normalizer.rebind_thread 改 _state.thread_id）")
    print("  无 remint，或新 tid 有量            → 不是投递问题：查 TTFT / 模型报错 / 空流")
    print("      交叉命令：python backend/packages/harness/scripts/chat_turn_health.py --days 1")
    print("=" * 74)
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="流式没返回：是没推，还是推了屏幕收不到")
    ap.add_argument("--date", default="", help="YYYY-MM-DD，默认今天")
    ap.add_argument("--days", type=int, default=1, help="往前推几天（默认今天一天）")
    ap.add_argument("--since", default="", help="起始钟点 HH:MM")
    ap.add_argument("--until", default="", help="结束钟点 HH:MM")
    ap.add_argument("--log", default="", help="日志目录或单个文件（默认自动定位）")
    args = ap.parse_args()

    logdir = resolve_log_dir(args.log)
    if not logdir:
        print("[stream-diag] 找不到日志目录（默认 ~/.evoflow/logs），用 --log 指定", file=sys.stderr)
        return 2

    day = args.date or (date.today() - timedelta(days=max(0, args.days - 1))).isoformat()
    return analyze(day, args.since, args.until, logdir)


if __name__ == "__main__":
    raise SystemExit(main())
