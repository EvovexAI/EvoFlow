"""``search_code_index`` 的 follow-read 不许把主检索按在超时天花板上。

【self-evolution-bot · 2026-11-19 · 第61轮 · 模型:deepseek-v4.1-flash-1017】

现网证据（2026-11-19 01:29 重启后）：
- 01:30:24 那次调用耗时 **26357ms**，输出里带
  ``[hint] post-search reads timed out after 15s`` —— 其中整整 15s 是**干等**。
- 同一批检索 3 分钟后只需 **2072ms**；重启后 90s 内 avg 15642ms vs 之后 2072ms，差 7.5 倍。
- 裸进程实测：search_index 冷 507ms / 热 87ms；follow_read 冷 2117ms / 热 87ms
  ⇒ 慢在**排队**，不是计算。

根因：follow-read 与主检索共用 ``_SEARCH_POOL``（4 worker）。重启窗口内
owned-KB worker（01:29:59 启动，本地 bge-small-zh 嵌入）与其它请求把 GIL/线程占满，
follow-read 排不上队，就一路干等到 15s 天花板才放弃——而它只产出「附赠的正文预览」，
主结果早已拿到。

本文件锁三条：
1. 兜底预算必须 ≤ 5s（改回 15s 会红）；
2. follow-read 必须跑在**独立**池上（共用主池会红）；
3. 真卡住时按预算返回**诚实超时文案**，并且说清「上面的结果已完整」。
"""

from __future__ import annotations

import time

import pytest

from evoflow.tools.host_direct import search_code_index as m


def test_预算不超过5秒() -> None:
    """15s 是白等出来的数字，不许回退。"""
    assert m._MAX_READ_WALL_SECONDS <= 5.0, (
        f"follow-read 预算被放回 {m._MAX_READ_WALL_SECONDS}s —— 现网实测 15s 全是干等"
    )


def test_follow_read用独立池() -> None:
    """接线：必须提交到 _READ_POOL，不是和主检索抢 _SEARCH_POOL。"""
    assert hasattr(m, "_READ_POOL"), "缺少独立池 _READ_POOL"
    assert m._READ_POOL is not m._SEARCH_POOL, "follow-read 又和主检索共用一个池了"

    import inspect

    src = inspect.getsource(m._follow_read_with_timeout)
    assert "_READ_POOL.submit" in src, "接线断了：follow-read 没用 _READ_POOL"
    assert "_SEARCH_POOL.submit(_reads)" not in src, "follow-read 又抢主检索的 worker"


def test_主检索仍走主池() -> None:
    """反证：别把主检索也挪走 —— 那会把 45s 预算换到别的池上，问题只是搬家。"""
    import inspect

    src = inspect.getsource(m._search_code_index_wallclock)
    assert "_SEARCH_POOL.submit" in src, "主检索必须留在 _SEARCH_POOL"


def test_卡住时按预算截断且文案诚实(monkeypatch: pytest.MonkeyPatch) -> None:
    """真卡住：按预算返回，且文案说明主结果已完整（不是「啥都没给你」）。"""
    import evoflow.scheduler.search_follow_read as fr

    def _hang(*_a, **_k):
        time.sleep(30)
        return "SHOULD_NEVER_APPEAR"

    monkeypatch.setattr(fr, "follow_read_after_search", _hang)

    t = time.perf_counter()
    out = m._follow_read_with_timeout(
        data={"hits": [], "symbols": []},
        read_root="D:/dev/github/EvoFlow",
        thread_id=None,
        read_offset=0,
        read_limit=2,
    )
    elapsed = time.perf_counter() - t

    assert elapsed < m._MAX_READ_WALL_SECONDS + 2.0, (
        f"超时没生效：等了 {elapsed:.1f}s，预算是 {m._MAX_READ_WALL_SECONDS}s"
    )
    assert "timed out" in out, out
    assert "results above are complete" in out, (
        "文案必须说明主结果已完整，否则调用方以为连结果都没有、会整轮重试"
    )
    assert "SHOULD_NEVER_APPEAR" not in out


def test_正常路径不受影响() -> None:
    """反证：正常 follow-read 要原样返回正文，不许被新预算误伤。"""
    def _fast(*_a, **_k):
        return "<post_search_reads>row</post_search_reads>"

    import evoflow.scheduler.search_follow_read as fr2

    orig = fr2.follow_read_after_search
    try:
        fr2.follow_read_after_search = _fast
        out = m._follow_read_with_timeout(
            data={"hits": [], "symbols": []},
            read_root="D:/dev/github/EvoFlow",
            thread_id=None,
            read_offset=0,
            read_limit=2,
        )
    finally:
        fr2.follow_read_after_search = orig

    assert "post_search_reads" in out
    assert "timed out" not in out
