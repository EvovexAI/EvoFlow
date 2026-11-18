"""漂移检测的过期重算不能在检索主路上同步 walk 全树。

【self-evolution-bot · 2026-11-19 · 第63轮 · 模型:deepseek-v4.1-flash-1017】

为什么有这条：`_source_drift_cached` 的 TTL 是 30s、缓存键按 60s 分桶，
意味着**每 30~60 秒必然有一次检索**要重新算漂移。而重算要
`_iter_source_files` 遍历全树（本仓 7899 个文件、17558 次 `nt.stat`）。

本机实测（同一 root、同一库 mtime）：
- 进程首次（缓存空，无旧值可用）同步兜底   **653.5ms**
- 稳态过期后（有旧值可用，后台刷新）        **0.6ms**
- 同场景改成同步算（旧行为）              **1252.5ms**

即稳态那条路省掉 1.2s/次，而现网 `search_code_index` P50 是 6.5s。

判据（三条）：
1. **稳态不阻塞**：有旧值时，过期重算必须立刻返回旧值，且**不调用** `source_drift`。
   这条用 spy 断言「根本没同步算」，比断言耗时可靠（耗时随负载飘）。
2. **首次不静默丢信息**：进程内一次都没算过时必须同步算出来 —— 不能为了快
   把漂移提示变成「永远空的」。
3. **后台刷新真的落值**：起线程但不干活等于没改。

边界：这里测的是「阻塞与否」，不测绝对毫秒数。
"""

from __future__ import annotations

import threading
import time

import pytest

from evoflow.code_index import store as S

_ROOT = "D:/tmp/fake-root"


@pytest.fixture(autouse=True)
def _clean_caches():
    S._DRIFT_CACHE.clear()
    for attr in ("_lock", "_inflight"):
        if hasattr(S._source_drift_cached, attr):
            delattr(S._source_drift_cached, attr)
    yield
    S._DRIFT_CACHE.clear()
    for attr in ("_lock", "_inflight"):
        if hasattr(S._source_drift_cached, attr):
            delattr(S._source_drift_cached, attr)


def _seed_prev(mtime: float, drift: dict) -> str:
    key = f"{_ROOT}\u0000{int(mtime // 60)}"
    S._DRIFT_CACHE[key] = (time.time(), drift)
    return key


def test_steady_state_expiry_does_not_walk_sync(monkeypatch) -> None:
    """有过期旧值时，必须秒回旧值且**完全不调** source_drift（判据 1）。"""
    mtime = 1_700_000_000.0
    prev = {"changed": 0, "added": 0, "deleted": 3, "total": 100}
    key = _seed_prev(mtime, prev)

    main_calls: list[float] = []
    bg_calls: list[float] = []
    main_thread = threading.current_thread()

    def _spy(root, *, since_ts=None):
        # 关键：必须按线程区分。后台刷新线程**本来就该**调 source_drift，
        # 把它的调用算进来会让这条测试永远红（本轮第一版就是这么错的）。
        if threading.current_thread() is main_thread:
            main_calls.append(since_ts)
        else:
            bg_calls.append(since_ts)
        return {"changed": 0, "added": 0, "deleted": 99, "total": 999}

    monkeypatch.setattr(S, "source_drift", _spy)
    # 只让 TTL 过期，保留旧值
    ts, d = S._DRIFT_CACHE[key]
    S._DRIFT_CACHE[key] = (ts - S._DRIFT_CACHE_TTL_SECONDS - 1, d)

    t0 = time.perf_counter()
    out = S._source_drift_cached(_ROOT, mtime)
    waited_ms = (time.perf_counter() - t0) * 1000

    assert out == prev, f"没有返回旧值，实际 {out}"
    assert main_calls == [], f"主线程仍同步算了漂移（{len(main_calls)} 次），等于没改"
    assert waited_ms < 50, f"过期重算阻塞了 {waited_ms:.0f}ms"


def test_first_call_in_process_still_syncs(monkeypatch) -> None:
    """进程首次（无任何旧值）必须同步算，不能静默丢掉漂移信息（判据 2）。"""
    want = {"changed": 1, "added": 0, "deleted": 0, "total": 100}
    calls: list[float] = []

    def _stub(root, *, since_ts=None):
        calls.append(since_ts)
        return want

    monkeypatch.setattr(S, "source_drift", _stub)
    out = S._source_drift_cached(_ROOT, 1_700_000_000.0)
    assert out == want, f"首次调用没有同步算出结果，得到 {out}"
    assert len(calls) == 1, f"首次调用应同步算一次，实际 {len(calls)} 次"


def test_background_refresh_writes_fresh_value(monkeypatch) -> None:
    """后台线程必须真的把新结论落进缓存（判据 3）。"""
    mtime = 1_700_000_000.0
    fresh = {"changed": 7, "added": 2, "deleted": 1, "total": 123}
    _seed_prev(mtime, {"changed": 0, "added": 0, "deleted": 3, "total": 100})
    key = f"{_ROOT}\u0000{int(mtime // 60)}"
    ts, d = S._DRIFT_CACHE[key]
    S._DRIFT_CACHE[key] = (ts - S._DRIFT_CACHE_TTL_SECONDS - 1, d)

    def _stub(root, *, since_ts=None):
        return fresh

    monkeypatch.setattr(S, "source_drift", _stub)
    S._source_drift_cached(_ROOT, mtime)

    deadline = time.time() + 5.0
    while time.time() < deadline:
        hit = S._DRIFT_CACHE.get(key)
        if hit is not None and hit[1] == fresh:
            break
        time.sleep(0.02)
    hit = S._DRIFT_CACHE.get(key)
    assert hit is not None and hit[1] == fresh, f"后台刷新没落值，当前 {hit}"
