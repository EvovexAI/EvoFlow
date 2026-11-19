"""检索工具 import 时即启动嵌入暖机（不再等第一次检索）。

【self-evolution-bot · 2026-11-19 · 第64轮 · 模型:deepseek-v4.1-flash-1017】

回归对象（现网实测，重启后同一查询在网关里 964ms ~ 8387ms 波动 8.7 倍）：
``_start_embed_warmup()`` 全仓只有一个调用点——``_embed_query_sync`` 内部，即
**第一次检索发生的那一刻**才启动后台暖机。于是进程启动后第一次检索必然吃到
完整冷启动（模型加载 ~3.8s + 首次 KNN 重建页缓存），同一时刻还占着检索线程干等。

观测库证据：重启后 08:21 / 08:27 / 08:58 三次检索 4478 / 11462 / 7119ms，
而间隔几分钟后的同类查询只要 964 / 1308ms。

本文件守三件事：
1. 模块 import 后暖机**已被请求**（`_embed_warm_last_try` 被置位）；
2. 暖机**真起了后台线程**（不是只置了个标志）；
3. 暖机失败时 import 仍然成功（纯加速，绝不能成为新的失败点）。
"""

from __future__ import annotations

import importlib
import threading

from evoflow.code_index import store


def test_import_kicks_warmup(monkeypatch):
    """import 检索工具后，暖机应已被请求（last_try 置位 = 真的调过）。"""
    calls: list[str] = []
    monkeypatch.setattr(store, "_embed_warm_last_try", None)

    def _spy() -> None:
        calls.append("warm")

    monkeypatch.setattr(store, "_start_embed_warmup", _spy)
    mod = importlib.import_module("evoflow.tools.host_direct.search_code_index")
    importlib.reload(mod)
    assert calls, "import 检索工具后没有请求暖机（改回了「等第一次检索」）"


def test_warmup_starts_background_thread(monkeypatch):
    """真实调用（不替换实现）：必须起一条 daemon 暖机线程。"""
    monkeypatch.setattr(store, "_embed_warm_last_try", None)
    monkeypatch.setattr(store, "_embed_gate_open", False)
    store._start_embed_warmup()

    names = [t.name for t in threading.enumerate()]
    assert any("embed-warmup" in n for n in names), f"没有起暖机线程：{names}"
    assert store._embed_warm_last_try, "暖机请求没有记录（last_try 仍为空）"


def test_warmup_failure_does_not_break_import(monkeypatch):
    """暖机内部抛错时，import 检索工具必须仍然成功。"""
    def _boom() -> None:
        raise RuntimeError("simulated warmup failure")

    monkeypatch.setattr(store, "_start_embed_warmup", _boom)
    mod = importlib.import_module("evoflow.tools.host_direct.search_code_index")
    mod = importlib.reload(mod) if mod else None
    # 只要没抛到外面就算通过
    assert mod is not None
