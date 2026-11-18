"""search_code_index 必须把分段耗时落进 obs 的 timing_json。

【self-evolution-bot · 2026-11-19 · 第63轮 · 模型:deepseek-v4.1-flash-1017】

为什么有这条：本轮为了定位「检索 P50 6.5s 落在哪一段」，现写了 4 个探针、
发了十几次 bash —— 而 obs 里 `search_code_index` 的 `timing_json` **一直是 null**
（bash / assets 都有分段，只有它没有）。少一个字段就等于每轮重新猜一遍，
而「我自己写的探针」一天 1345 次、平均 2.4s，本身就是被优化对象。

判据（四条，缺一即等于没接线）：
1. 有 `tool_call_id` 时必须真的写进 tool_timing（能被中间件 pop 出来）；
2. 三段耗时字段齐全，且 `body_ms >= search_ms`（顺序计时不可能倒挂）；
3. `tool_call_id` 为空时**不上报**（避免污染别人的键）；
4. 上报逻辑抛异常时不能影响检索返回值 —— 旁路观测绝不允许拖垮主路。

注意：`.func` 是必须的。`@tool` 装饰后模块级名字已是 `StructuredTool`，
直接调用会 `TypeError: 'StructuredTool' object is not callable`（本轮实测）。
"""

from __future__ import annotations

import pytest

import evoflow.tools.host_direct.search_code_index as T
from evoflow.code_index import store as S
from evoflow.observability import tool_timing as TT


def _search_fn():
    """取原始同步函数：`@tool` 装饰后模块级名字已是 StructuredTool 对象。"""
    return getattr(T.search_code_index_hd, "func", None) or T.search_code_index_hd


class _RT:
    def __init__(self, root: str, tcid: str) -> None:
        self.tool_call_id = tcid
        self.context = {"thread_id": "t-63", "workspace_root": root}
        self.config = {}
        self.state = {}


def _seed(tmp_path) -> str:
    root = str(tmp_path).replace("\\", "/")
    conn = S._connect(root)
    S._ensure_schema(conn)
    conn.execute(
        "INSERT INTO fts_content(path, content) VALUES (?, ?)",
        ("src/lease.py", "def try_acquire_build_lease():\n    return True\n"),
    )
    conn.execute(
        "INSERT INTO symbols(path, name, kind, line) VALUES (?, ?, ?, ?)",
        ("src/lease.py", "try_acquire_build_lease", "function", 1),
    )
    conn.commit()
    conn.close()
    return root


def test_timing_fields_are_reported(tmp_path) -> None:
    """判据 1 + 2：字段齐全、可被 pop、且不倒挂。"""
    root = _seed(tmp_path)
    tcid = "call-63-fields"
    TT.pop_tool_exec_detail(tcid)  # 清残
    out = _search_fn()(
        query="try_acquire_build_lease", limit=5, read_limit=0, runtime=_RT(root, tcid)
    )
    assert "try_acquire_build_lease" in str(out)

    detail = TT.pop_tool_exec_detail(tcid)
    assert detail is not None, "没有上报 timing_json，等于这轮改动没接线"
    for key in ("search_ms", "format_ms", "follow_read_ms", "body_ms"):
        assert key in detail, f"缺少分段字段 {key}，实际 {detail}"
    assert detail["body_ms"] >= detail["search_ms"], f"计时倒挂：{detail}"
    assert detail["kind"] == "search_code_index"


def test_no_tool_call_id_means_no_report(monkeypatch) -> None:
    """判据 3：拿不到 key 就不写，别污染别人的观测行。"""
    calls: list[object] = []
    monkeypatch.setattr(
        TT, "note_tool_exec_detail", lambda *a, **k: calls.append((a, k))
    )
    T._note_search_timing(
        "",
        search_ms=1.0,
        fmt_ms=1.0,
        read_ms=0.0,
        total_ms=2.0,
        read_limit=0,
        semantic_degraded="",
    )
    assert calls == [], f"空 tool_call_id 仍上报了：{calls}"


def test_timing_failure_does_not_break_search(monkeypatch, tmp_path) -> None:
    """判据 4：上报抛异常，检索必须照常返回结果。"""

    def _boom(*_a, **_k):
        raise RuntimeError("观测炸了")

    monkeypatch.setattr(TT, "note_tool_exec_detail", _boom)
    root = _seed(tmp_path)
    tcid = "call-63-boom"
    out = _search_fn()(
        query="try_acquire_build_lease", limit=5, read_limit=0, runtime=_RT(root, tcid)
    )
    assert "try_acquire_build_lease" in str(out), "观测异常把检索结果弄丢了"


def test_runtime_tool_call_id_reaches_timing(tmp_path) -> None:
    """接线：runtime 上的 id 必须一路传到 timing（本轮第 4 次栽的「最后一米」）。"""
    root = _seed(tmp_path)
    tcid = "call-63-wire"
    TT.pop_tool_exec_detail(tcid)
    _search_fn()(query="try_acquire_build_lease", limit=5, read_limit=0, runtime=_RT(root, tcid))
    detail = TT.pop_tool_exec_detail(tcid)
    assert detail is not None, "runtime.tool_call_id 没有传到 _note_search_timing"
