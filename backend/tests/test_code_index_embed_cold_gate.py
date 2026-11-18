"""锁住「嵌入冷启不得压在首调检索上」。

【self-evolution-bot · 2026-11-18 · 第50轮 · 模型:deepseek-v4.1-flash-1017】为什么有这条测试：
Windows 上网关**默认跳过**嵌入暖机（background_startup 里
`win32 default (set EVOFLOW_EMBEDDING_WARMUP=1 to enable)`），于是 torch /
sentence_transformers 的冷导入与权重加载全都落在**第一次检索**的调用栈里。
现网实测（2026-11-18 17:50）重启后首次 search_code_index 撞满
`_MAX_WALL_SECONDS=45` 直接超时（45021ms error）；同机分段实测
`import local_provider` 3030ms + 首次 `embed_sync` 1669ms，之后每次 3~4ms。

本测试守三条不变量：
1. 门未开时首调**不得**把 torch / sentence_transformers 拉进 sys.modules；
2. 门未开时首调直接返回 None（调用方回退词法），不阻塞；
3. 暖机成功后门自动开，嵌入恢复可用。

注意：用 `module.attr` 读全局，不要 `from ... import` —— 后者拿的是快照，
本文件第一版就因此把「门已开」误读成 False（我白等了 120 秒才发现）。
"""

from __future__ import annotations

import importlib
import sys

import pytest


@pytest.fixture()
def store_mod():
    mod = importlib.import_module("evoflow.code_index.store")
    saved = (mod._embed_gate_open, mod._embed_warm_last_try)
    yield mod
    mod._embed_gate_open, mod._embed_warm_last_try = saved


def test_first_query_does_not_import_torch(store_mod):
    """门未开的首调必须立刻返回 None，且不把 torch 拉进来。"""
    store_mod._embed_gate_open = False
    store_mod._embed_warm_last_try = 0.0
    # 清掉可能已被别的测试加载的嵌入栈，让「没 import」这个断言有意义
    for name in list(sys.modules):
        if name.startswith("sentence_transformers"):
            sys.modules.pop(name, None)

    had_torch = "torch" in sys.modules
    vec = store_mod._embed_query_sync("build_lease")
    assert vec is None, "门未开时首调必须返回 None（调用方回退词法），不许同步 load 模型"
    if not had_torch:
        assert "torch" not in sys.modules, "门未开时首调把 torch 拉起来了 —— 冷启又回到检索路径上"


def test_gate_closed_returns_none_and_opens_after_warmup(store_mod, monkeypatch):
    """门未开 -> 返回 None；暖机成功后门开 -> 恢复语义向量。"""
    store_mod._embed_gate_open = False
    store_mod._embed_warm_last_try = 0.0

    calls: list[int] = []

    def _fake_warm() -> None:
        calls.append(1)

    monkeypatch.setattr(store_mod, "_start_embed_warmup", _fake_warm)
    monkeypatch.setattr(store_mod, "_embed_ready_without_import", lambda: False)

    assert store_mod._embed_query_sync("x") is None
    assert calls, "门未开时必须触发一次后台暖机"


def test_warmup_is_single_flight_within_cooldown(store_mod, monkeypatch):
    """冷却期内重复调用不得反复起暖机线程（否则每次检索都新起一个）。"""
    store_mod._embed_gate_open = False
    store_mod._embed_warm_last_try = 0.0

    started: list[int] = []

    class _FakeThread:
        def __init__(self, *, target, name, daemon):  # noqa: ARG002
            started.append(1)

        def start(self) -> None:
            return None

    monkeypatch.setattr(store_mod.threading, "Thread", _FakeThread)

    store_mod._start_embed_warmup()
    store_mod._start_embed_warmup()
    store_mod._start_embed_warmup()
    assert len(started) == 1, f"冷却期内只应起一次暖机线程，实际 {len(started)} 次"
