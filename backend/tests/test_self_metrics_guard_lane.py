"""守卫拦截必须与真故障在度量表里分流 —— 这条错了，我下一轮会把「拦得对」读成「又出新坑」。

【self-evolution-bot · 2026-11-16 · 第19轮】新建。

为什么值得单独钉一处
--------------------
`agent_self_metrics.py` 是我（自我进化BOT）唯一的自我度量入口，而它的 1/3 位置写着
「拦截不是故障，应单独成桶」。第19轮我跑它时第一屏读到：

    ! bash · ToolReturnedError::拦截:重复探索 —— 113 次（新增报错模式）

就把它当成了新回归去查，**多发了 3 次 obs 查询**才发现 113 次全在第17轮修复上线之前，
剩下 3 次是我自己 01:13 连跑同一门禁（正当拦截）。根因不在 `_message_stub`（它早就把
拦截单独做成桶键），而在**输出层没接上**：签名照旧进了「新增报错模式 / 复发 / 已消失」三条判断。

同型两处顺带钉住（都是本轮现网表里真出现的自相矛盾）：
② 同一键同时印在「复发」与「已消失」两栏（末桶归零 = 已修好，却又被标成没修好）；
③ 键印成 ``write_path_not_allowed::write_path_not_allowed``（error_type 与文案首词相同还重复一遍）。

反证同样要有：真故障（非拦截）必须照旧进三条判断，改判据不许把它一起吞掉 —— 否则
「不报假故障」就变成了「什么都不报」，比原来更坏。
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

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


def _row(tool: str, *, etype: str = "ToolReturnedError", msg: str = "", ts: str = "") -> dict:
    return {
        "tool_name": tool,
        "status": "error",
        "error_type": etype,
        "error_message": msg,
        "duration_ms": 10,
        "queue_wait_ms": 0,
        "started_at": ts or "2026-11-15T10:00:00+08:00",
    }


def _stats_with(sig_series: list[dict]) -> list[dict]:
    return [{"label": f"11-{9 + i:02d}", "sig": s} for i, s in enumerate(sig_series)]


# ── ① 守卫拦截不进三条故障判断 ─────────────────────────────────────────────
BLOCK = "[重复探索·已拦截] 同一探索工具目标已达上限，本次调用未执行。请换策略：不要再次 read/rg 同一目标"


def test_guard_block_is_not_reported_as_new_failure_mode(m):
    """拦截只在末桶出现时，绝不能被印成「新坑」。这是本轮多花 3 次查询的直接原因。"""
    row = _row("bash", msg=BLOCK)
    sig = m._failure_signature([row])
    assert list(sig) == [("bash", "ToolReturnedError::拦截:重复探索")], sig

    cls = m._classify_signatures(_stats_with([{}, {}, sig]))
    assert cls["new"] == [], f"守卫拦截被当成新故障: {cls['new']}"
    assert [r["failure"] for r in cls["guard"]] == ["ToolReturnedError::拦截:重复探索"]


def test_guard_block_is_not_recurring_when_last_bucket_has_it(m):
    """拦截跨两个桶都在时，也不该进「复发＝上次没修好」。"""
    k = ("bash", "ToolReturnedError::拦截:重复探索")
    cls = m._classify_signatures(_stats_with([{k: 5}, {k: 2}, {k: 3}]))
    assert cls["recurring"] == [], f"拦截被当成复发: {cls['recurring']}"
    assert cls["guard"] and cls["guard"][0]["total"] == 10


def test_real_failure_still_reported(m):
    """反证：真故障不许被这条判据吞掉 —— 否则「不报假故障」变成「什么都不报」。"""
    sig = m._failure_signature([_row("assets", msg='{"ok": false, "error": "kind_required"}')])
    cls = m._classify_signatures(_stats_with([{}, {}, sig]))
    assert cls["new"], "真故障被漏报了"
    assert cls["guard"] == []


# ── ② 复发 / 已消失 不得重叠 ────────────────────────────────────────────────
def test_recurring_and_resolved_are_mutually_exclusive(m):
    """末桶归零 = 已修好，不能再被标成「上次没真修好」。"""
    k = ("tasks", "ToolReturnedError")
    cls = m._classify_signatures(_stats_with([{k: 15}, {k: 7}, {}]))
    assert not any(r["failure"] == k[1] for r in cls["recurring"]), "末桶归零却仍报复发"
    assert any(r["failure"] == k[1] for r in cls["resolved"])

    still = m._classify_signatures(_stats_with([{k: 15}, {k: 7}, {k: 1}]))
    assert any(r["failure"] == k[1] for r in still["recurring"]), "末桶还有却不算复发"
    assert not any(r["failure"] == k[1] for r in still["resolved"])


# ── ③ 键不重复印 ────────────────────────────────────────────────────────────
def test_no_duplicated_key_when_error_type_equals_stub(m):
    """``write_path_not_allowed::write_path_not_allowed`` 这种重复键不许再出现。"""
    sig = m._failure_signature([_row("assets", etype="write_path_not_allowed", msg="write_path_not_allowed")])
    assert list(sig) == [("assets", "write_path_not_allowed")], sig


# ── ④ 首末时刻取数与签名键必须是同一形状（本轮我第一版就栽在这） ────────────
def test_guard_span_lookup_uses_same_key_shape(m):
    """签名键是 ``ToolReturnedError::拦截:x``，_guard_spans 记的是 ``拦截:x`` ——
    第一版直接拿签名键去查，字面永不命中，表里印出「全窗口 0 次 / 首末：无时刻」。"""
    rows = [
        _row("bash", msg=BLOCK, ts="2026-11-14T17:05:00+08:00"),
        _row("bash", msg=BLOCK, ts="2026-11-16T01:13:00+08:00"),
    ]
    spans = m._guard_spans(rows)
    key_sig = ("bash", "ToolReturnedError::拦截:重复探索")
    assert m._is_guard_sig(key_sig)
    stub = m._guard_stub(key_sig)
    assert stub == "拦截:重复探索"
    assert spans[( "bash", stub)]["count"] == 2
    assert spans[("bash", stub)]["first"].startswith("2026-11-14T17:05")
    assert spans[("bash", stub)]["last"].startswith("2026-11-16T01:13")


def test_guard_span_ignores_success_rows(m):
    """成功行不该被算成拦截 —— 否则「首末时刻」会被无关行拉宽。"""
    ok = _row("bash", msg=BLOCK)
    ok["status"] = "success"
    assert m._guard_spans([ok]) == {}


# ── ⑤ 两条出口（对半切 / 逐桶）判据必须一致 ────────────────────────────────
def test_both_lanes_agree_on_guard_split(m):
    """只改一个口径 = 没改：换个 --bucket 就自相矛盾，正是我第16轮栽过的接线漏项。"""
    k = ("bash", "ToolReturnedError::拦截:重复探索")
    half = m._classify_signatures(_stats_with([{}, {}, {k: 4}]))
    trend = m._classify_signatures(_stats_with([{}, {k: 4}, {k: 4}]))
    for cls in (half, trend):
        assert cls["new"] == [] and cls["recurring"] == [], cls
        assert cls["guard"], cls
