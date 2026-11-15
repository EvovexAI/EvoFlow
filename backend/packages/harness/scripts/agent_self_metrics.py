"""Agent 自我度量：从观测库出「改动前 vs 改动后」的错误率 / 重复踩坑 / 慢调用环比.

【fullstack-dev · 2026-11-15 · 第10轮】新建。

为什么要有这个脚本
------------------
「让 agent 越改越强」缺的不是观测数据（``evoflow_obs_tool_invocations`` 早就有
duration_ms / status / error_type / error_message），而是**拿这些数据做前后对比的人**。
第 1~9 轮我改了一堆东西（`[obs]` 错误注记、assets 短名寻址、note 免 kind…），
但「改完之后我自己少撞几次墙吗」这件事**从来没有被量化过一次**——全靠印象说「应该有用」。
没有度量，就无法区分「真的修好了」和「这次运气好」，也就没有资格把经验写成配方。

它回答三个问题（都按 agent_code 过滤，窗口对半切成 前半期 / 后半期）
----------------------------------------------------------------
1. **错误率**变了没？（success / error 占比，按调用数）
2. **重复踩坑**还在不在？→ ``repeat offenders``：同 (tool, error_type) 在前半期出现过、
   后半期又出现的，逐条列出次数。这一栏是「同一个坑反复踩」的直接证据；
   某条已经修掉的坑应当在后半期归零，否则说明改动没接线（对照第3轮那次教训）。
3. **慢调用 / 排队**占比变了没？（阈值同 ``EVOFLOW_TOOL_OBS_SLOW_MS``，默认 3000ms）
   外加模型侧 TTFT / 解码速度 / 上下文规模，用来分「系统慢」还是「上下文大」。

判据提醒（写在这里免得下次误读）：前后半期**不是** A/B，任务难度、上下文规模、当期改动
数量都会混进来。所以只有「某条具体错误后半期归零」这种**定向**结论能拿来当证据；
总错误率涨跌只能当趋势看，别写成「因为我改了 X 所以降了 Y%」。

零依赖：只用 stdlib（sqlite3 / argparse / datetime），不 import evoflow，不起服务。

用法
----
    python backend/packages/harness/scripts/agent_self_metrics.py                 # 默认 fullstack-dev，近 7 天，对半切
    python backend/packages/harness/scripts/agent_self_metrics.py --agent main --days 14
    python backend/packages/harness/scripts/agent_self_metrics.py --bucket day --days 14   # 逐日趋势（数据少时先看这个）
    python backend/packages/harness/scripts/agent_self_metrics.py --bucket week --days 30  # 周环比（需跨过至少 1 个自然周一）
    python backend/packages/harness/scripts/agent_self_metrics.py --since 2026-11-09 --until 2026-11-16
    python backend/packages/harness/scripts/agent_self_metrics.py --json
    EVOFLOW_HOME=~/.evoflow/profiles/default python … # 库路径由 EVOFLOW_HOME 解析，勿改硬编码
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

CST = timezone(timedelta(hours=8))  # 库里 started_at 带 +08:00，对齐本地日界
OBS_DB_REL = Path("data") / "observability" / "evoflow_observability.db"
DEFAULT_AGENT = "fullstack-dev"
DEFAULT_SLOW_MS = 3000.0  # 与 EVOFLOW_TOOL_OBS_SLOW_MS 默认值保持一致

# 时间窗口一律在 Python 侧过滤（见 _in_window）：两表 started_at 都是 ISO 文本，
# 但历史写入的时区写法不统一（+08:00 / Z / 无偏移），按字典序在 SQL 里比 >= <= 会整体错位 ——
# 实测这样捞模型表会返回 0 行（该 agent 明明有 1704 行 main）。统一交给 _parse_ts 吸收。
_TOOL_ROWS_SQL = """
    SELECT tool_name, status, error_type, error_message, duration_ms, queue_wait_ms, started_at
    FROM evoflow_obs_tool_invocations
    WHERE agent_code = ?
"""

_MODEL_ROWS_SQL = """
    SELECT latency_ms, first_token_latency_ms, cache_read_tokens, usage_json, started_at
    FROM evoflow_obs_model_invocations
    WHERE agent_code = ? AND invocation_kind = 'main'
"""


def resolve_db_path(explicit: str = "") -> Path | None:
    """按仓库口径定位观测库：--db > EVOFLOW_HOME > ~/.evoflow/profiles/<唯一/默认 profile>."""
    if explicit:
        p = Path(explicit).expanduser()
        return p if p.exists() else None
    home = (os.environ.get("EVOFLOW_HOME") or "").strip()
    if home:
        p = Path(home).expanduser() / OBS_DB_REL
        return p if p.exists() else None
    base = Path.home() / ".evoflow" / "profiles"
    if base.is_dir():
        cands = [q / OBS_DB_REL for q in sorted(base.iterdir()) if (q / OBS_DB_REL).exists()]
        if len(cands) == 1:
            return cands[0]
        preferred = base / "default" / OBS_DB_REL
        if preferred.exists():
            return preferred
        if cands:
            print(f"[metrics] 多个 profile 有观测库，取最近写入的那个：{len(cands)} 个候选", file=sys.stderr)
            return max(cands, key=lambda x: x.stat().st_mtime)
    legacy = Path.home() / ".evoflow" / OBS_DB_REL
    return legacy if legacy.exists() else None


def _iso(dt: datetime) -> str:
    return dt.astimezone(CST).isoformat()


def _pct(part: int, whole: int) -> float:
    return (part / whole * 100.0) if whole else 0.0


def _quantile(sorted_vals: list[float], q: float) -> float:
    if not sorted_vals:
        return 0.0
    idx = min(len(sorted_vals) - 1, max(0, int(round(q * (len(sorted_vals) - 1)))))
    return sorted_vals[idx]


def _delta(now: float, before: float) -> str:
    """有符号变化（百分点 / 绝对值都按 % 说清，避免「提升了 0.5」这种无单位表述）。"""
    if not before:
        return "n/a(前期为0)" if now else "0"
    return f"{(now - before) / before * 100.0:+.1f}%"


def _bucket(rows: list[dict[str, Any]], lo: datetime, hi: datetime) -> list[dict[str, Any]]:
    """按窗口捞子集；时间戳解析不出来的行**不静默丢**，计入 undated 供人工判读。"""
    out, undated = [], 0
    for r in rows:
        ts = _parse_ts(str(r.get("started_at") or ""))
        if ts is None:
            undated += 1
            continue
        if lo <= ts < hi:
            out.append(r)
    if undated:
        print(f"[metrics] 注：{undated} 行 started_at 解析失败，未计入窗口", file=sys.stderr)
    return out


def _parse_ts(raw: str) -> datetime | None:
    if not raw:
        return None
    try:
        ts = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None
    return ts if ts.tzinfo else ts.replace(tzinfo=CST)


def _tool_stats(rows: list[dict[str, Any]], slow_ms: float) -> dict[str, Any]:
    total = len(rows)
    err = [r for r in rows if str(r.get("status") or "").lower() not in ("success", "ok", "")]
    durs = sorted(float(r["duration_ms"]) for r in rows if r.get("duration_ms") is not None)
    queues = sorted(float(r["queue_wait_ms"]) for r in rows if r.get("queue_wait_ms") is not None)
    by_tool: dict[str, dict[str, int]] = {}
    for r in rows:
        name = str(r.get("tool_name") or "?")
        slot = by_tool.setdefault(name, {"calls": 0, "errors": 0})
        slot["calls"] += 1
        if str(r.get("status") or "").lower() not in ("success", "ok", ""):
            slot["errors"] += 1
    return {
        "calls": total,
        "errors": len(err),
        "error_rate_pct": round(_pct(len(err), total), 1),
        "p50_ms": round(_quantile(durs, 0.50), 0),
        "p95_ms": round(_quantile(durs, 0.95), 0),
        "slow_calls": sum(1 for d in durs if d >= slow_ms),
        "slow_pct": round(_pct(sum(1 for d in durs if d >= slow_ms), total), 1),
        "queue_p95_ms": round(_quantile(queues, 0.95), 0),
        "queued_calls": sum(1 for q in queues if q >= 500),
        "by_tool": {
            k: v
            for k, v in sorted(by_tool.items(), key=lambda kv: (-kv[1]["errors"], -kv[1]["calls"]))
            if v["errors"] or v["calls"] >= 5
        },
    }


def _failure_signature(rows: list[dict[str, Any]]) -> dict[tuple[str, str], int]:
    """(tool, error_type) → 次数。error_type 太粗时补 message 首个关键词，避免整类糊成一个。"""
    sig: dict[tuple[str, str], int] = {}
    for r in rows:
        if str(r.get("status") or "").lower() in ("success", "ok", ""):
            continue
        tool = str(r.get("tool_name") or "?")
        etype = str(r.get("error_type") or "").strip() or "(无类型)"
        msg = str(r.get("error_message") or "").strip()
        key = f"{etype}::{_message_stub(msg)}" if msg else etype
        sig[(tool, key)] = sig.get((tool, key), 0) + 1
    return sig


# 报错文案里的高频虚词：拿它们当签名会把不同故障糊成一条、也看不出是什么错。
_STUB_STOPWORDS = frozenset(
    {
        "not", "and", "for", "the", "was", "were", "been", "with", "found", "this", "that",
        "have", "has", "error", "errors", "tool", "tools", "path", "must", "should", "cannot",
        "invoking", "invalid", "unknown", "please", "your", "you", "are", "ist", "und",
    }
)


def _message_stub(msg: str) -> str:
    """取报错里最**稳定**的标识，让同一故障在不同文案下仍归为一条：
    ① snake_case 错误码（not_found / kind_required / path_ignored）；
    ② JSON 信封里的 "error" 字段；
    ③ 去掉虚词后的首个实词（或中文前 24 字）。
    """
    code = re.search(r"\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b", msg)
    if code:
        return code.group(0)[:40]
    jenvelope = re.search(r'"error"\s*:\s*"([^"]{2,40})', msg)
    if jenvelope:
        return jenvelope.group(1)
    cjk = re.search(r"[\u4e00-\u9fff]{6,}", msg)
    if cjk:
        return cjk.group(0)[:24]
    for token in re.split(r"[^0-9A-Za-z_.]+", msg):
        t = token.lower().strip("._")
        if len(t) >= 4 and t not in _STUB_STOPWORDS:
            return t[:40]
    return msg[:24]


def _model_stats(rows: list[dict[str, Any]]) -> dict[str, Any]:
    # 注意：分位数用 lat_sorted；按行配对（latency↔ttft↔tokens）必须用行序 lat_by_row，别拿排序后的列表按下标对齐。
    lat_by_row = [float(r["latency_ms"] or 0.0) for r in rows]
    lat = sorted(v for v in lat_by_row if v)
    ttfts = sorted(float(r["first_token_latency_ms"]) for r in rows if r.get("first_token_latency_ms"))
    # 非流式轮（_agenerate 路径）不传 TTFT，是语义缺失不是埋点坏了 —— 单独计数，别当成丢数据
    missing_ttft = sum(1 for r in rows if not r.get("first_token_latency_ms"))
    # usage_json 实测结构（2026-11-15 核）：顶层是 {usage_metadata, prompt_overhead, llm_output}，
    # token 数在 usage_metadata 里，cache_read 再嵌一层 input_token_details —— 别按顶层键取（取不到会静默全 0）。
    ttft_by_row = [float(r.get("first_token_latency_ms") or 0.0) for r in rows]
    in_tok: list[int] = []
    out_tok: list[int] = []
    cache: list[int] = []
    sys_tok: list[int] = []
    for r in rows:
        try:
            blob = json.loads(r.get("usage_json") or "{}")
        except (TypeError, ValueError):
            blob = {}
        meta = blob.get("usage_metadata") or {}
        details = meta.get("input_token_details") or {}
        overhead = blob.get("prompt_overhead") or {}
        in_tok.append(int(meta.get("input_tokens") or 0))
        out_tok.append(int(meta.get("output_tokens") or 0))
        cache.append(int(details.get("cache_read") or r["cache_read_tokens"] or 0))
        sys_tok.append(int(overhead.get("system_tokens") or 0))
    # 解码速度 tok/s = 输出 token ÷ 出字时长。出字时长 = 整轮 latency − TTFT；
    # 非流式轮没有 TTFT，只能按整轮算（分母偏大 → tok/s 偏低），故单列 decode_estimated 说明是下界。
    dec: list[float] = []
    dec_estimated = 0
    for lat_ms, ttft_ms, out_n in zip(lat_by_row, ttft_by_row, out_tok, strict=True):
        if out_n < 30 or lat_ms <= 0:
            continue  # 输出太短时 TTFT 占比过大，算出来的 tok/s 没有参考价值
        if ttft_ms > 0:
            gen_ms = max(lat_ms - ttft_ms, 1.0)
        else:
            gen_ms = lat_ms
            dec_estimated += 1
        dec.append(out_n / (gen_ms / 1000.0))
    dec.sort()
    return {
        "calls": len(rows),
        "ttft_p50_ms": round(_quantile(ttfts, 0.50), 0),
        "ttft_p95_ms": round(_quantile(ttfts, 0.95), 0),
        "ttft_missing": missing_ttft,
        "ttft_missing_pct": round(_pct(missing_ttft, len(rows)), 1),
        "model_p95_ms": round(_quantile(lat, 0.95), 0),
        "decode_tps_p50": round(_quantile(dec, 0.50), 1),
        "decode_sample_n": len(dec),
        "decode_estimated": dec_estimated,
        "input_tokens_p50": round(_quantile([float(v) for v in in_tok], 0.50), 0),
        "cache_read_p50": round(_quantile([float(v) for v in cache], 0.50), 0),
        "system_prompt_tokens_p50": round(_quantile([float(v) for v in sys_tok], 0.50), 0),
    }


# 【fullstack-dev · 2026-11-15 · 第13轮】新增 --bucket week|day 逐桶趋势。
# 为什么要这一档：原「对半切」只看两个半区，回答不了「坑到底哪天开始复发的」；
# 而周环比需要跨自然周才有意义 —— 实测本仓 obs 数据只有 11-09~11-15 一个自然周，
# 只加 week 档今天跑就是「1 个桶、无法环比」。故分桶做成通用函数，week/day 共用，
# 数据不足时**明确说不足并建议改跑 day**，不输出空头趋势冒充结论。
_MIN_BUCKET_CALLS = 30  # 低于此调用数的桶只当参考，不据此写「回归/好转」结论


def _next_midnight(t: datetime) -> datetime:
    return (t + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)


def _next_week_start(t: datetime) -> datetime:
    d = _next_midnight(t)
    while d.weekday() != 0:  # 周一起算（与「本周至今」的直觉一致）
        d += timedelta(days=1)
    return d


def _split_bounds(mode: str, lo: datetime, hi: datetime) -> list[tuple[str, datetime, datetime]]:
    """把 [lo, hi) 沿自然日或自然周切成**连续不重叠**的桶（末桶收在 hi）。"""
    step = _next_midnight if mode == "day" else _next_week_start
    out: list[tuple[str, datetime, datetime]] = []
    a = lo
    while a < hi:
        b = step(a)
        if b <= a:  # 防御：跨度不足一天时不要生成零长度桶
            b = hi
        if b > hi:
            b = hi
        label = f"{a:%m-%d}周" if mode == "week" else f"{a:%m-%d}"
        out.append((label, a, b))
        a = b
    return out


def _trend_rows(
    tool_rows: list[dict[str, Any]],
    model_rows: list[dict[str, Any]],
    bounds: list[tuple[str, datetime, datetime]],
    slow_ms: float,
) -> list[dict[str, Any]]:
    stats = []
    for label, a, b in bounds:
        t = _bucket(tool_rows, a, b)
        m = _bucket(model_rows, a, b)
        stats.append(
            {
                "label": label,
                "tools": _tool_stats(t, slow_ms),
                "model": _model_stats(m),
                "sig": _failure_signature(t),
            }
        )
    return stats


def _classify_signatures(stats: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    """按桶序把错误签名分成 复发 / 已消失 / 新坑 —— 只有末桶归零才够格写成配方。"""
    # 先收齐全集，再按**桶全长**建列：缺席的桶必须是 0，不能跳过（跳过会让 series 与
    # labels 错位，末桶判「归零」就成了假的 —— 故显式两趟而不是一趟 setdefault）。
    keys = {k for s in stats for k in s["sig"]}
    agg: dict[tuple[str, str], list[int]] = {k: [s["sig"].get(k, 0) for s in stats] for k in keys}
    out: dict[str, list[dict[str, Any]]] = {"recurring": [], "resolved": [], "new": []}
    for k, series in agg.items():
        if sum(1 for x in series if x) > 1:
            out["recurring"].append({"tool": k[0], "failure": k[1], "series": series, "total": sum(series)})
        if series[-1] == 0 and sum(series) > 0:
            out["resolved"].append({"tool": k[0], "failure": k[1], "series": series, "total": sum(series)})
        if series[-1] > 0 and sum(series[:-1]) == 0:
            out["new"].append({"tool": k[0], "failure": k[1], "series": series, "total": series[-1]})
    out["recurring"].sort(key=lambda x: -x["total"])
    out["resolved"].sort(key=lambda x: -x["total"])
    out["new"].sort(key=lambda x: -x["total"])
    return out


def _print_trend(stats: list[dict[str, Any]], top: int) -> None:
    print("\n── 逐桶趋势（与上一桶对比）" + "─" * 22)
    print("  桶 | 调用 | 错误率 | 工具P50 | 慢% | TTFT P50 | 输入tok P50")
    print("  （TTFT 位显示「无」= 该桶没有任何 TTFT 上报（空桶，或全部为非流式轮），不是首 token 快）")
    prev = None
    for s in stats:
        t, m = s["tools"], s["model"]
        # 实测踩点：某桶 53 次调用全是非流式 → ttfts 空 → _quantile 回 0.0，
        # 表里印成「0ms」会被读成「首 token 极快」。全缺时必须显式说无，不能留 0 冒充数。
        ttft_cell = "无" if (not m["calls"] or m["ttft_missing"] >= m["calls"]) else f"{m['ttft_p50_ms']:.0f}ms"
        cells = [
            s["label"],
            f"{t['calls']}",
            f"{t['error_rate_pct']}%",
            f"{t['p50_ms']:.0f}ms",
            f"{t['slow_pct']}%",
            ttft_cell,
            f"{m['input_tokens_p50']:.0f}",
        ]
        if prev is not None and prev[0]["calls"]:
            cells.append(
                "Δ "
                + _delta(t["calls"], prev[0]["calls"])
                + f" · 错误率 {t['error_rate_pct'] - prev[0]['error_rate_pct']:+.1f}pp"
                + " · "
                + _delta(m["input_tokens_p50"], prev[1]["input_tokens_p50"])
            )
        print("  " + " | ".join(cells))
        if t["calls"] < _MIN_BUCKET_CALLS:
            print(f"    ↳ 本桶 {t['calls']} 次调用（<{_MIN_BUCKET_CALLS}），涨跌只当参考")
        prev = (t, m)

    real = [s for s in stats if s["tools"]["calls"]]
    if len(real) < 2:
        # 数据不足必须说破：输出「0 个变化」会被下一个人读成「没有回归」，那是假的清白。
        print(f"  ⚠ 有数据的桶只有 {len(real)} 个（{', '.join(s['label'] for s in real) or '无'}）—— 无法环比。")
        print("     周环比需跨过自然周一才有第二个桶（默认 --days 7 通常只有 1 个周桶，用 --days 30）；")
        print("     库里数据本身不满两周时，改跑 --bucket day 看逐日趋势。")

    cls = _classify_signatures(stats)
    order = " > ".join(s["label"] for s in stats)
    print("\n── 错误签名逐桶（列序 " + order + "）" + "─" * 8)
    for title, key in (
        ("复发：≥2 个桶都有 = 上次没真修好", "recurring"),
        ("已消失：末桶归零 = 才允许写成配方", "resolved"),
        ("新坑：只在末桶出现", "new"),
    ):
        items = cls[key]
        print(f"\n  {title}" + ("" if items else " —— 无"))
        for it in items[:top]:
            print("    " + it["tool"] + " · " + it["failure"] + "  " + " > ".join(str(x) for x in it["series"]))
    print("\n  注：桶与桶之间不是 A/B（任务难度/上下文规模会混进来）。能当证据的只有末桶归零这类定向结论。")


def _print_block(title: str, cur: dict[str, Any], prev: dict[str, Any] | None) -> None:
    print(f"\n── {title} " + "─" * max(0, 46 - len(title)))
    print("  （标签 后半期 / 前半期 / 变化）" if prev is not None else "  （标签 后半期）")

    def line(label: str, key: str, unit: str = "") -> None:
        # 不用 {label:<14} 这类宽度对齐：中文标签终端占 2 格而 len() 算 1，会把值粘到标签上
        # （实测出现过 "cache_read P5094208.0"，真值 94208 被读成 5094208）。一律用竖线分隔。
        now_v = cur.get(key, 0)
        if prev is None:
            print(f"  {label} | {now_v}{unit}")
            return
        before_v = prev.get(key, 0)
        print(f"  {label} | {now_v}{unit} | {before_v}{unit} | {_delta(float(now_v or 0), float(before_v or 0))}")

    for label, key, unit in (
        ("调用数", "calls", ""),
        ("错误数", "errors", ""),
        ("错误率", "error_rate_pct", "%"),
        # 注意单位：耗时类是 ms，占比类是 %（别当成秒）
        ("P50 耗时", "p50_ms", "ms"),
        ("P95 耗时", "p95_ms", "ms"),
        ("慢调用", "slow_calls", ""),
        ("慢调用占比", "slow_pct", "%"),
        ("排队P95", "queue_p95_ms", "ms"),
    ):
        if key in cur:
            line(label, key, unit)


def _print_model_block(cur: dict[str, Any], prev: dict[str, Any] | None) -> None:
    print("\n── 模型侧（invocation_kind=main）" + "─" * 22)
    print("  （标签 后半期 / 前半期 / 变化；耗时单位 ms）")
    for label, key, unit in (
        ("调用数", "calls", ""),
        ("TTFT P50", "ttft_p50_ms", "ms"),
        ("TTFT P95", "ttft_p95_ms", "ms"),
        ("TTFT 缺失率", "ttft_missing_pct", "%"),
        ("整轮 P95", "model_p95_ms", "ms"),
        ("解码速度", "decode_tps_p50", "tok/s"),
        ("输入token P50", "input_tokens_p50", " tok"),
        ("cache_read P50", "cache_read_p50", " tok"),
        ("提示词token P50", "system_prompt_tokens_p50", " tok"),
    ):
        # 同 _print_block：竖线分隔，不用宽度对齐（中文标签会把数字粘进标签里）。
        now_v = cur.get(key, 0)
        if prev is None:
            print(f"  {label} | {now_v}{unit}")
        else:
            print(f"  {label} | {now_v}{unit} | {prev.get(key, 0)}{unit} | {_delta(float(now_v or 0), float(prev.get(key, 0) or 0))}")
    if cur.get("ttft_missing"):
        print(f"  ↳ 其中 {cur['ttft_missing']} 轮无 TTFT：非流式 _agenerate 路径本就不上报（语义缺失，非采集故障）")
    if cur.get("input_tokens_p50") and prev and prev.get("input_tokens_p50"):
        print("  ↳ 上下文规模变化会直接抬高 TTFT，归因前先对比 input_tokens_p50（外生成本，不是工具慢）")


def main() -> int:
    ap = argparse.ArgumentParser(description="Agent 自我度量：工具错误率 / 重复踩坑 / 慢调用环比")
    ap.add_argument("--agent", default=DEFAULT_AGENT, help=f"agent_code 过滤（默认 {DEFAULT_AGENT}）")
    ap.add_argument("--days", type=float, default=7.0, help="统计窗口天数（默认 7；被 --since/--until 覆盖）")
    ap.add_argument("--since", default="", help="窗口起点 ISO 日期，如 2026-11-09")
    ap.add_argument("--until", default="", help="窗口终点 ISO 日期（含）")
    ap.add_argument("--slow-ms", type=float, default=float(os.environ.get("EVOFLOW_TOOL_OBS_SLOW_MS") or DEFAULT_SLOW_MS))
    ap.add_argument("--db", default="", help="观测库路径（默认按 EVOFLOW_HOME / profiles 解析）")
    ap.add_argument("--top", type=int, default=8, help="重复踩坑榜单条数")
    ap.add_argument(
        "--bucket",
        choices=("half", "day", "week"),
        default="half",
        # 默认仍是 half：提示词第 7 条写的是 `--days 7`（对半切），不擅自换默认口径。
        help="对比方式：half=窗口对半切（默认）；day=按自然日逐桶趋势；week=按自然周逐桶（即周环比）",
    )
    ap.add_argument("--json", action="store_true", help="机器可读输出")
    args = ap.parse_args()

    db = resolve_db_path(args.db)
    if db is None:
        print("[metrics] 找不到观测库：请设 EVOFLOW_HOME 或用 --db 指定（未起 gateway 也有库文件）", file=sys.stderr)
        return 2

    if args.since or args.until:
        lo = _parse_ts(args.since or "1970-01-01") or datetime(1970, 1, 1, tzinfo=CST)
        hi_raw = (args.until or "").strip()
        hi = (_parse_ts(hi_raw) if hi_raw else None) or datetime.now(CST)
        # --until 只给日期（2026-11-16）时按「含当天」处理，补到次日 00:00；给了时刻就不动。
        if hi_raw and re.fullmatch(r"\d{4}-\d{2}-\d{2}", hi_raw):
            hi = hi + timedelta(days=1)
    else:
        hi = datetime.now(CST)
        lo = hi - timedelta(days=args.days)
    if lo >= hi:
        print("[metrics] --since 必须早于 --until", file=sys.stderr)
        return 2
    mid = lo + (hi - lo) / 2

    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    try:
        tool_rows = [dict(r) for r in con.execute(_TOOL_ROWS_SQL, (args.agent,))]
        model_rows = [dict(r) for r in con.execute(_MODEL_ROWS_SQL, (args.agent,))]
    finally:
        con.close()

    if not tool_rows:
        print(f"[metrics] 窗口内无 {args.agent} 的工具调用记录（{lo:%m-%d %H:%M} ~ {hi:%m-%d %H:%M}）；先确认 --agent 或放宽 --days")
        return 1

    # 【fullstack-dev · 2026-11-15 · 第13轮】逐桶趋势分支（--bucket day|week）：
    # 走独立出口，不与「对半切」共用尾部逻辑 —— 两种口径的结论形态不同（两桶 vs N 桶），
    # 混在一起改容易把默认路径（提示词第 7 条依赖的那个）碰坏。
    if args.bucket != "half":
        stats = _trend_rows(
            tool_rows, model_rows, _split_bounds(args.bucket, lo, hi), args.slow_ms
        )
        if args.json:
            print(
                json.dumps(
                    {
                        "agent": args.agent,
                        "db": str(db),
                        "window": {"from": _iso(lo), "to": _iso(hi)},
                        "bucket": args.bucket,
                        "slow_ms": args.slow_ms,
                        "buckets": [
                            {"label": s["label"], "tools": s["tools"], "model": s["model"]} for s in stats
                        ],
                        "signatures": _classify_signatures(stats),
                    },
                    ensure_ascii=False,
                    indent=2,
                )
            )
            return 0
        print(f"══ Agent 自我度量 · {args.agent} · 按{'自然日' if args.bucket == 'day' else '自然周'}逐桶 ══")
        print(f"  库：{db}")
        print(f"  窗口：{lo:%m-%d %H:%M} ~ {hi:%m-%d %H:%M}")
        print(f"  慢调用阈值：{args.slow_ms:.0f}ms（与 EVOFLOW_TOOL_OBS_SLOW_MS 同值）")
        _print_trend(stats, args.top)
        return 0

    cur_tools, prev_tools = _bucket(tool_rows, mid, hi), _bucket(tool_rows, lo, mid)
    cur_model, prev_model = _bucket(model_rows, mid, hi), _bucket(model_rows, lo, mid)
    ct, pt = _tool_stats(cur_tools, args.slow_ms), _tool_stats(prev_tools, args.slow_ms) if prev_tools else None

    cur_sig, prev_sig = _failure_signature(cur_tools), _failure_signature(prev_tools)
    carried = sorted(
        ((k, v, prev_sig.get(k, 0)) for k, v in cur_sig.items() if k in prev_sig),
        key=lambda x: -(x[1] + x[2]),
    )
    fixed = sorted((k for k in prev_sig if k not in cur_sig), key=lambda k: -prev_sig[k])
    new = sorted((k for k in cur_sig if k not in prev_sig), key=lambda k: -cur_sig[k])

    payload = {
        "agent": args.agent,
        "db": str(db),
        "window": {"from": _iso(lo), "to": _iso(hi), "split": _iso(mid)},
        "slow_ms": args.slow_ms,
        "tools_current": ct,
        "tools_previous": pt,
        "model_current": _model_stats(cur_model),
        "model_previous": _model_stats(prev_model) if prev_model else None,
        "repeat_offenders": [
            {"tool": k[0], "failure": k[1], "current": c, "previous": p} for k, c, p in carried[: args.top]
        ],
        "resolved": [{"tool": k[0], "failure": k[1], "previous": prev_sig[k]} for k in fixed[: args.top]],
        "new_failure_modes": [{"tool": k[0], "failure": k[1], "current": cur_sig[k]} for k in new[: args.top]],
    }
    if args.json:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return 0

    print(f"══ Agent 自我度量 · {args.agent} ══")
    print(f"  库：{db}")
    print(f"  窗口：{lo:%m-%d %H:%M} ~ {hi:%m-%d %H:%M}（对半切：前半 {lo:%m-%d}~{mid:%m-%d} / 后半 {mid:%m-%d}~{hi:%m-%d}）")
    print(f"  慢调用阈值：{args.slow_ms:.0f}ms（与 EVOFLOW_TOOL_OBS_SLOW_MS 同值）")
    _print_block("工具调用", ct, pt)

    print("\n── 分工具（有报错或调用≥5 次）" + "─" * 18)
    for name, v in list(ct["by_tool"].items())[: args.top]:
        print(f"  {name:<22}{v['calls']:>5} 次 · 错 {v['errors']:>3} 次 ({_pct(v['errors'], v['calls']):.0f}%)")

    print("\n── 重复踩坑（前半期出现过、后半期仍在）" + "─" * 8)
    if not carried:
        print("  无 —— 后半期的报错模式全是新面孔（旧坑没复发）")
    for k, c, p in carried[: args.top]:
        trend = "↑" if c > p else ("↓" if c < p else "＝")
        print(f"  {trend} {k[0]} · {k[1]:<34} 后半 {c} 次 / 前半 {p} 次")

    print("\n── 已消失（前半期有、后半期归零 = 修好了的定向证据）" + "─" * 6)
    for k in fixed[: args.top]:
        print(f"  ✓ {k[0]} · {k[1]} —— 前半 {prev_sig[k]} 次 → 后半 0 次")
    if fixed:
        print("  （注：后半期样本偏少时，归零也可能是当期没走到这条路径，别直接写成配方）")

    print("\n── 新增报错模式（后半期第一次见）" + "─" * 12)
    for k in new[: args.top]:
        print(f"  ! {k[0]} · {k[1]} —— {cur_sig[k]} 次")

    _print_model_block(_model_stats(cur_model), _model_stats(prev_model) if prev_model else None)

    print("\n提示：本表非 A/B 对比。可当证据的只有「某具体报错后半期归零」这类定向结论。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
