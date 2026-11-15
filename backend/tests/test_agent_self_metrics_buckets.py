"""逐桶趋势的分桶与归零判据 —— 这两个错了，我下轮就会把假结论写成配方。

【fullstack-dev · 2026-11-15 · 第13轮】新建。

为什么钉这一处而不是整脚本
--------------------------
`agent_self_metrics.py` 的「已消失（末桶归零）」是我判断「上次真修好了 / 只是这次没走到」
的唯一依据，而它依赖两件事同时成立：① 桶切分**连续不重叠且收满窗口**（漏一天就可能把
"最后一次报错"切到窗口外，归零变成假的）；② 某桶完全没出现该错误时 series 必须是 **0 而不是跳过**
（跳过会让 series 与 labels 错位，判「末桶」时看的其实是别的桶）。这两条在第13轮我先写错过一版
（一趟 setdefault 只 append 见过的桶），当场改成两趟建列 —— 光靠肉眼跑现网数据看不出错位，
故用合成数据把长度对齐与边界钉死。

模块用 importlib 按文件路径加载：脚本在 packages/harness/scripts/ 下，不是可 import 的包。
"""

from __future__ import annotations

import importlib.util
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

CST = timezone(timedelta(hours=8))
_SCRIPT = (
    Path(__file__).resolve().parents[1] / "packages" / "harness" / "scripts" / "agent_self_metrics.py"
)


@pytest.fixture(scope="module")
def m():
    spec = importlib.util.spec_from_file_location("agent_self_metrics", _SCRIPT)
    assert spec and spec.loader, f"度量脚本不在预期路径：{_SCRIPT}"
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _t(day: int, hour: int = 0) -> datetime:
    return datetime(2026, 11, day, hour, 0, tzinfo=CST)


# ── ① 桶切分 ──────────────────────────────────────────────────────────────


def test_day_bounds_are_contiguous_and_cover_window(m):
    lo, hi = _t(9, 8), _t(15, 6)
    bounds = m._split_bounds("day", lo, hi)
    assert bounds[0][1] == lo and bounds[-1][2] == hi, "首尾必须收满窗口，否则边缘数据被吞"
    for (_, _, b), (_, a, _) in zip(bounds, bounds[1:]):
        assert a == b, "桶间必须无缝相接（重叠会双计，留缝会漏计）"
    assert [lbl for lbl, _, _ in bounds] == ["11-09", "11-10", "11-11", "11-12", "11-13", "11-14", "11-15"]


def test_week_bounds_split_at_monday(m):
    # 11-09 是周一：从周中起算时第一个桶应止于下一个周一 00:00，而不是硬凑 7 天。
    lo, hi = _t(5, 12), _t(20, 12)
    bounds = m._split_bounds("week", lo, hi)
    assert bounds[0][1] == lo and bounds[0][2] == _t(9)
    assert bounds[1][1] == _t(9) and bounds[1][2] == _t(16)
    assert bounds[-1][2] == hi


def test_sub_day_window_yields_single_bucket(m):
    bounds = m._split_bounds("day", _t(12, 1), _t(12, 20))
    assert len(bounds) == 1 and bounds[0][2] == _t(12, 20), "不足一天也必须产出一桶（不能空列表或零长度桶）"


# ── ② 归零判据与 series 对齐 ──────────────────────────────────────────────


def _stats_with(sig_series: list[dict]) -> list[dict]:
    return [{"label": f"11-{9 + i:02d}", "sig": s} for i, s in enumerate(sig_series)]


def test_absent_bucket_pads_zero_not_skipped(m):
    """错误只在桶 0、2 出现：series 必须是 [x, 0, x] 长度 3，不能塌成 [x, x]。"""
    k = ("bash", "ToolReturnedError::boom")
    stats = _stats_with([{k: 3}, {}, {k: 5}])
    cls = m._classify_signatures(stats)
    row = next(r for r in cls["recurring"] if r["failure"].endswith("boom"))
    assert row["series"] == [3, 0, 5], "缺席桶漏 0 会导致末桶判断看错列"
    assert row["total"] == 8


def test_resolved_requires_last_bucket_zero(m):
    k = ("assets", "kind_required")
    stats = _stats_with([{k: 9}, {k: 4}, {}])
    cls = m._classify_signatures(stats)
    assert any(r["failure"] == "kind_required" for r in cls["resolved"]), "末桶归零才叫修好"

    still = _stats_with([{k: 9}, {k: 4}, {k: 1}])
    cls2 = m._classify_signatures(still)
    assert not any(r["failure"] == "kind_required" for r in cls2["resolved"]), "末桶还有 1 次就不是归零"


def test_new_failure_only_when_earlier_buckets_clean(m):
    k = ("replace", "path_required")
    cls = m._classify_signatures(_stats_with([{}, {}, {k: 6}]))
    assert [r["failure"] for r in cls["new"]] == ["path_required"]
    assert cls["recurring"] == []


def test_single_populated_bucket_reports_not_comparable(m, capsys):
    """只有 1 个有数据的桶时必须当场说破「无法环比」—— 否则下一个人会把「无复发」读成「没回归」。"""
    k = ("bash", "ToolReturnedError::x")
    stats = _stats_with([{}, {k: 30}])
    for s in stats:
        s["tools"] = m._tool_stats([], 3000.0)
        s["model"] = m._model_stats([])
    stats[1]["tools"] = m._tool_stats(
        [
            {
                "tool_name": "bash",
                "status": "error",
                "error_type": "ToolReturnedError",
                "error_message": "x",
                "duration_ms": 100,
                "queue_wait_ms": 0,
                "started_at": "2026-11-10T00:00:00+08:00",
            }
        ]
        * 30,
        3000.0,
    )
    m._print_trend(stats, 5)
    out = capsys.readouterr().out
    assert "无法环比" in out
    assert "--bucket day" in out


def test_all_nonstream_bucket_prints_wu_not_zero_ms(m, capsys):
    """全是非流式轮的桶：ttfts 为空 → _quantile 回 0.0，若照印「0ms」会被读成「首 token 极快」。
    这条钉住「无」占位，因为我自己就差点按 0ms 判过「那天模型很快」。"""
    stats = _stats_with([{}, {}])
    empty_tools = m._tool_stats([], 3000.0)
    nonstream_model = m._model_stats(
        [{"latency_ms": 5000, "first_token_latency_ms": None, "cache_read_tokens": 0, "usage_json": "{}"}] * 40
    )
    assert nonstream_model["ttft_missing"] == 40
    for s in stats:
        s["tools"] = empty_tools
        s["model"] = nonstream_model
    stats[1]["tools"] = m._tool_stats(
        [
            {
                "tool_name": "bash",
                "status": "success",
                "error_type": "",
                "error_message": "",
                "duration_ms": 100,
                "queue_wait_ms": 0,
                "started_at": "2026-11-10T00:00:00+08:00",
            }
        ]
        * 53,
        3000.0,
    )
    m._print_trend(stats, 5)
    out = capsys.readouterr().out
    assert "| 无 |" in out, "非流式桶的 TTFT 位必须显示「无」而不是 0ms"
    assert "0.0ms" not in out


def test_half_lane_default_untouched(m):
    """提示词第 7 条依赖默认 `--days 7` 的对半切口径，这里确认逐桶改动没把默认路径碰坏。"""
    rows = [
        {
            "tool_name": "bash",
            "status": "success",
            "error_type": "",
            "error_message": "",
            "duration_ms": 120,
            "queue_wait_ms": 0,
            "started_at": f"2026-11-{d:02d}T10:00:00+08:00",
        }
        for d in (9, 14)
    ]
    lo, mid, hi = _t(8), _t(11, 12), _t(15)
    assert len(m._bucket(rows, lo, mid)) == 1
    assert len(m._bucket(rows, mid, hi)) == 1
