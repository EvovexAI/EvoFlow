"""同线程多车道：bash 并行调用不再被单锁串行化。

【self-evolution-bot · 2026-11-19 · 第64轮 · 模型:deepseek-v4.1-flash-1017】

回归对象（现网实测 2026-11-19，近 3 天 9254 次 bash 调用）：
每个 thread_key 原本只有一把执行锁，同一线程里的并行 bash 调用被完整串行化，
于是单个 agent 永远只占到进程级 4 槽中的 1 槽。排队累计 1663s，其中 49 次
单次等 19.6s 的长尾占 962s。

本文件守三件事，缺一不可：
1. 车道键隔离（``_lane_key``）—— lane 0 必须沿用历史键，否则老会话全丢；
2. 车道真并行 —— lane 0 被占时，同线程第二条调用必须立刻拿到 lane 1；
3. **接线** —— ``bash_tool`` 入口必须把 ``channel.lane`` 真送到 ``_run_foreground``。
   前 4 轮栽过的都是「函数层全绿、接线没通」，所以第 3 条是从真实入口进的。
"""

from __future__ import annotations

import importlib
import threading

import pytest

# 坑：``evoflow.tools.zcode_port.bash_tool`` 这个**属性**已被 @tool 装饰成
# StructuredTool 对象，`from ... import bash_tool` 拿到的是工具而不是模块
# （本岗在 bash_tool 上踩过同一坑），必须用 importlib 取模块真身。
bt_mod = importlib.import_module("evoflow.tools.zcode_port.bash_tool")


@pytest.fixture(autouse=True)
def _clean_locks():
    """每个用例用独立 thread key，避免跨用例互相持锁。"""
    yield


def test_lane_key_keeps_lane0_identical_to_legacy_key():
    # lane 0 必须是历史键本身：改了这一条，重启后所有既有 warm 会话全部失效。
    assert bt_mod._lane_key("thread-a", 0) == "thread-a"
    assert bt_mod._lane_key("thread-a", 1) == "thread-a#1"
    assert bt_mod._lane_key("thread-a", 2) == "thread-a#2"


def test_lanes_per_thread_default_and_env(monkeypatch):
    monkeypatch.delenv("EVOFLOW_BASH_LANES_PER_THREAD", raising=False)
    assert bt_mod._bash_max_lanes_per_thread() == 2
    monkeypatch.setenv("EVOFLOW_BASH_LANES_PER_THREAD", "1")
    assert bt_mod._bash_max_lanes_per_thread() == 1
    monkeypatch.setenv("EVOFLOW_BASH_LANES_PER_THREAD", "garbage")
    assert bt_mod._bash_max_lanes_per_thread() == 2


def test_second_call_skips_to_lane1_while_lane0_busy(monkeypatch):
    """lane 0 被占时，同线程第二条调用必须立刻拿到 lane 1（而不是排队）。"""
    monkeypatch.setenv("EVOFLOW_BASH_LANES_PER_THREAD", "2")
    key = "lane-test-thread"

    held = bt_mod._thread_channel(key)
    held.__enter__()
    assert held.lane == 0

    got: list[int] = []
    done = threading.Event()

    def _second() -> None:
        with bt_mod._thread_channel(key) as ch:
            got.append(ch.lane)
        done.set()

    t = threading.Thread(target=_second, daemon=True)
    t.start()
    # 老实现（单锁）在这里会卡满 3 秒；新实现毫秒级返回。
    assert done.wait(3.0), "lane 1 没有生效：同线程第二条调用仍在等 lane 0"
    assert got == [1]
    held.__exit__()


def test_all_lanes_busy_falls_back_to_lane0(monkeypatch):
    """两条车道都占满时，第三条应退回等 lane 0 —— 保留原先进先出语义。"""
    monkeypatch.setenv("EVOFLOW_BASH_LANES_PER_THREAD", "2")
    key = "lane-test-thread-full"
    lanes = bt_mod._bash_max_lanes_per_thread()

    holders = []
    for _ in range(lanes):
        ch = bt_mod._thread_channel(key)
        ch.__enter__()
        holders.append(ch)
    assert sorted(h.lane for h in holders) == list(range(lanes))

    got: list[int] = []
    done = threading.Event()

    def _third() -> None:
        with bt_mod._thread_channel(key) as ch:
            got.append(ch.lane)
        done.set()

    t = threading.Thread(target=_third, daemon=True)
    t.start()
    # 全部车道占满 → 必须阻塞（≤2s 内不该拿到）
    assert not done.wait(0.3), "所有车道都已占满，第三条却立刻返回了（说明闸没生效）"
    holders[0].__exit__()
    assert done.wait(3.0), "释放 lane 0 后第三条调用仍未拿到车道"
    assert got == [0]
    for h in holders[1:]:
        h.__exit__()


def test_bash_entry_passes_real_lane(monkeypatch):
    """接线：真实入口 ``bash_tool`` 必须把车道号送到 ``_run_foreground``。

    这是本岗栽过 4 次的那一类缺陷（函数层全绿、调用点没接）。改法是让
    ``_run_foreground`` 在 lane 0 上挂住，同时由另一线程发起第二条调用；
    老代码第二条会卡在单锁上，新代码会以 lane 1 进来。
    """
    monkeypatch.setenv("EVOFLOW_BASH_LANES_PER_THREAD", "2")
    seen: list[int] = []
    entered = threading.Event()
    release = threading.Event()

    def _fake_run_foreground(command, timeout_ms, cwd, tool_call_id, **kwargs):
        lane = kwargs.get("lane")
        seen.append(lane)
        if lane == 0:
            entered.set()
            release.wait(5.0)
        return f"ok:{lane}"

    monkeypatch.setattr(bt_mod, "_run_foreground", _fake_run_foreground)

    entry = getattr(bt_mod.bash_tool, "func", bt_mod.bash_tool)
    results: list[str] = []
    first: list[threading.Thread] = [
        threading.Thread(target=lambda: results.append(entry("cmd-a")), daemon=True)
    ]
    first[0].start()
    assert entered.wait(3.0), "第一条调用没有进入 _run_foreground（接线断）"

    # 同一 thread_key（runtime=None 时两者都落到 _default）上的第二条调用
    second = threading.Thread(
        target=lambda: results.append(entry("cmd-b")), daemon=True
    )
    second.start()
    second.join(3.0)
    release.set()
    first[0].join(5.0)

    assert not second.is_alive(), "同线程第二条调用被串行化了：入口没把车道传下去"
    assert sorted(seen) == [0, 1], f"车道未按预期分配：{seen}"
    assert "ok:1" in results
