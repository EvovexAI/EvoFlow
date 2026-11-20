"""维护性重活不许堵请求路径：db_async 专用池必须与默认池隔离。

【self-evolution-bot · 2026-11-20 · 第70轮 · 模型:deepseek-v4.1-flash-1017】

现网事故（2026-11-20 07:32:17→07:37:31）：后台
`run_deferred_full_preflight` 用 `asyncio.to_thread`（**默认**池）对 3 个库
做全量 `PRAGMA integrity_check` + WAL truncate（evoflow.db 3.14GB、
observability.db 2.46GB），占住默认池 **5 分 14 秒**。同一池上的端点被饿死：

  /api/tasks        排队 10s → tasks_catalog_timeout → **503**
  /api/mcp/config   正常 47ms，实际等到 **26s** 才回
  /api/knowledge/owned/bases  7.7s

判据指纹：`lag_s=0.000` —— 事件循环没被阻塞，是线程池空转。
所以「改 asyncio 调度」没用，必须换池。

本测试钉死三件事：
1. run_db 真的跑在 `evoflow-db` 线程上（不是默认池）；
2. 默认池被打满时，run_db 依然秒回（隔离真实生效）；
3. 该改走 run_db 的几个热点没退回 to_thread。
"""

from __future__ import annotations

import asyncio
import re
import threading
import time
from pathlib import Path

import pytest


def test_run_db_executes_on_dedicated_pool() -> None:
    """run_db 必须跑在 evoflow-db 线程上。

    只断言「有返回值」是不够的 —— 那 tour 测不出它到底用了哪个池。
    """

    async def main() -> str:
        from app.gateway.db_async import run_db

        return await run_db(lambda: threading.current_thread().name)

    name = asyncio.run(main())
    assert name.startswith("evoflow-db"), f"run_db 跑在错误的线程上：{name}"


def test_run_db_stays_fast_when_default_pool_is_saturated() -> None:
    """默认池打满时 run_db 仍须秒回 —— 这是「隔离」的可证伪判据。

    事故现场就是这个形状：默认池被长活占死，请求路径跟着排队。
    """

    async def main() -> float:
        from app.gateway.db_async import run_db

        def block() -> str:
            time.sleep(1.2)
            return "done"

        blockers = [asyncio.to_thread(block) for _ in range(40)]
        try:
            t0 = time.perf_counter()
            got = await run_db(lambda: "fast")
            elapsed_ms = (time.perf_counter() - t0) * 1000
            assert got == "fast"
            return elapsed_ms
        finally:
            await asyncio.gather(*blockers, return_exceptions=True)

    elapsed = asyncio.run(main())
    # 实测 0.1ms；给足余量防止 CI 抖动，但必须远小于一次 block 的 1200ms
    assert elapsed < 300, f"专用池被默认池拖住了：{elapsed:.0f}ms（隔离失效）"


@pytest.mark.parametrize(
    "relpath,needle",
    [
        ("app/gateway/background_startup.py", "run_deferred_full_preflight"),
        ("app/gateway/routers/mcp.py", "build_mcp_status_snapshot"),
        ("app/gateway/routers/tasks.py", "_list_tasks_catalog_sync"),
    ],
)
def test_heavy_or_hot_paths_use_run_db(relpath: str, needle: str) -> None:
    """这三个点必须走 run_db；退回 asyncio.to_thread 就会再阻塞请求路径。

    静态断言而非端到端：这两类缺陷只在「启动预热窗口」出现，
    平时 curl 一下永远碰上不，必须靠代码形态兜住。

    注意：朴素做法 `src.find(needle)` 会命中**注释里**的同名文字
    （本仓注释大量引用这些符号名），从而把违规判成合规。
    所以必须先剥掉注释行，再找真正的调用行。
    """
    root = Path(__file__).resolve().parents[1]
    raw_lines = (root / relpath).read_text(encoding="utf-8").splitlines()
    # 剥注释（只留代码），但保留行号以便报错定位
    code_lines = [
        (i, ln) for i, ln in enumerate(raw_lines)
        if not ln.lstrip().startswith("#")
    ]
    hits = [
        (i, ln) for i, ln in code_lines
        if needle in ln
        and not ln.lstrip().startswith(('"', "'"))
        # 跳过函数**定义**行：要验的是调用点，不是 def 本身
        and not re.match(r"\s*(async\s+)?def\s+" + re.escape(needle) + r"\b", ln)
        # 跳过 import 行：`from x import build_mcp_status_snapshot` 不是调用
        and not re.match(r"\s*(from|import)\s", ln)
    ]
    assert hits, f"{relpath} 的代码里找不到 {needle} 的真实调用点，测试前提失效"

    for lineno, line in hits:
        # 该调用点所在的语句（含上一行，因为常有换行续写）必须出现 run_db
        context = "\n".join(raw_lines[max(0, lineno - 3) : lineno + 2])
        assert "run_db" in context, (
            f"{relpath}:{lineno + 1} 的 {needle} 没走 db_async.run_db：\n    {line.strip()}\n"
            "会把维护性长活与请求路径挤在同一个默认池里"
        )
        assert not re.search(r"asyncio\.to_thread\(\s*" + re.escape(needle), context), (
            f"{relpath}:{lineno + 1} 的 {needle} 仍在用 asyncio.to_thread（默认池）"
        )
