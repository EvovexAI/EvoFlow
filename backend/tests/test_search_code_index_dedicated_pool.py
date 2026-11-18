"""search_code_index 必须跑在专用线程池上，不能跟事件循环默认 executor 抢槽。

【self-evolution-bot · 2026-11-19 · 第63轮 · 模型:deepseek-v4.1-flash-1017】

为什么有这条：本工具是**同步**函数，`ainvoke` 默认走
``loop.run_in_executor(None, ...)``。桌面 Gateway 上那个默认池会被压缩、
MCP 同步包装、阻塞 I/O 一起抢；而实际使用形态正是「多个 bash 并发 + 夹一次
search_code_index」。assets 工具挂专用池前实测「本体 <1ms 却整批卡 2s+」，
挂后消失——同一机制对检索成立。

判据（三条，缺一即等于没接线）：
1. 工具对象上**真的挂了 coroutine**（只定义函数不挂 = 没改，本岗栽过 4 次）；
2. 该 coroutine 就是把 ``.func`` 提交给 ``run_in_executor``，且 executor 是
   本模块的专用池，**不是**默认的 ``None``；
3. 端到端能跑出正常结果——证明没有因为改调度而搞坏返回值。

注意：本文件测的是**接线与调度目标**，不测绝对耗时（耗时随机器负载漂移）。
"""

from __future__ import annotations

import asyncio
import inspect

import pytest

from evoflow.tools.host_direct import search_code_index as T


class _StubRuntime:
    """最小 ToolRuntime 替身：只提供本工具实际读取的字段。"""

    def __init__(self, root: str) -> None:
        self.context = {"thread_id": "t-63", "workspace_root": root}
        self.config = {}
        self.state = {}


def test_tool_object_has_dedicated_pool_coroutine() -> None:
    """工具对象上必须挂 coroutine（判据 1）。"""
    mounted = getattr(T.search_code_index_hd, "coroutine", None)
    assert mounted is not None, "search_code_index 没有挂 coroutine，仍会在默认 executor 上排队"
    assert mounted is T._search_code_index_coroutine


def test_coroutine_submits_to_dedicated_pool(monkeypatch) -> None:
    """必须提交到专用池，而不是 ``run_in_executor(None, ...)``（判据 2）。"""
    seen: dict[str, object] = {}

    class _Loop:
        def run_in_executor(self, executor, fn):
            seen["executor"] = executor
            seen["fn"] = fn

            async def _noop():
                return "stub"

            return _noop()

    monkeypatch.setattr(asyncio, "get_running_loop", lambda: _Loop())
    out = asyncio.run(T._search_code_index_coroutine(query="x", runtime=None))
    assert out == "stub"
    assert seen["executor"] is T._SEARCH_TOOL_POOL, (
        f"提交到了 {seen['executor']!r}，应为专用池 _SEARCH_TOOL_POOL（None = 默认 executor）"
    )
    # 被提交的必须是原始同步函数，不能是 StructuredTool 对象
    assert seen["fn"] is not None
    assert not hasattr(seen["fn"], "ainvoke"), "提交进池的是 StructuredTool 对象，调用会 TypeError"


def test_coroutine_runs_real_search(tmp_path) -> None:
    """端到端：接线对不对不看有没有抛异常，要看真的搜出东西（判据 3）。"""
    from evoflow.code_index import store as S

    root = str(tmp_path).replace("\\", "/")
    conn = S._connect(root)
    S._ensure_schema(conn)
    conn.execute(
        "INSERT INTO fts_content(path, content) VALUES (?, ?)",
        ("src/lease.py", "def try_acquire_build_lease(): return True\n"),
    )
    conn.execute(
        "INSERT INTO symbols(path, name, kind, line) VALUES (?, ?, ?, ?)",
        ("src/lease.py", "try_acquire_build_lease", "function", 1),
    )
    conn.commit()
    conn.close()

    out = asyncio.run(
        T._search_code_index_coroutine(
            query="try_acquire_build_lease", limit=5, read_limit=0, runtime=_StubRuntime(root)
        )
    )
    text = str(out)
    assert "try_acquire_build_lease" in text, f"检索没返回命中，实际输出：{text[:400]}"


def test_coroutine_signature_matches_tool() -> None:
    """专用池 coroutine 必须接住工具的全部入参形态（*args/**kwargs）。"""
    sig = inspect.signature(T._search_code_index_coroutine)
    kinds = {p.kind for p in sig.parameters.values()}
    assert inspect.Parameter.VAR_KEYWORD in kinds, "缺少 **kwargs，工具按关键字调用会 TypeError"
