"""Bash execution channels: per-thread locks + pure-wait guard.

2026-10-25 线上事故回归：主对话 `sleep 50 && echo waited`（显式超时，前台阻塞）
攥住进程级全局锁 50s，把并行 workflow worker 的琐碎 `ls/cat` 全堵成 40-55s。
修复 = 锁按 thread 分域 + 进程级并发上限 + 纯等待命令拒绝。
"""

from __future__ import annotations

import threading
import time

from evoflow.tools.zcode_port.bash_tool import (
    _exec_lock_for,
    _pure_wait_guard,
)


# ── pure-wait guard ─────────────────────────────────────────────────────


def test_guard_rejects_pure_sleep():
    msg = _pure_wait_guard("sleep 50")
    assert msg is not None and "rejected" in msg
    assert "50" in msg


def test_guard_rejects_sleep_with_echo_filler():
    # 2026-10-25 事故原句
    msg = _pure_wait_guard("sleep 50 && echo waited")
    assert msg is not None and "rejected" in msg


def test_guard_rejects_accumulated_sleeps():
    msg = _pure_wait_guard("sleep 6 && sleep 6 && echo done")
    assert msg is not None


def test_guard_allows_short_sleep():
    assert _pure_wait_guard("sleep 5") is None
    assert _pure_wait_guard("sleep 2 && echo ok") is None


def test_guard_allows_sleep_with_real_work():
    # 有实质命令的等待（轮询循环带动作）不拦
    assert _pure_wait_guard("sleep 30; cat a.txt") is None
    assert _pure_wait_guard("sleep 20 && python build.py") is None
    assert _pure_wait_guard("for i in 1 2 3; do curl -s http://x; sleep 15; done") is None


def test_guard_ignores_commands_without_sleep():
    assert _pure_wait_guard("ls -la outputs") is None
    assert _pure_wait_guard("") is None
    assert _pure_wait_guard(None) is None  # type: ignore[arg-type]


# ── per-thread execution channels ───────────────────────────────────────


def test_exec_lock_keying():
    a1 = _exec_lock_for("thread-a")
    a2 = _exec_lock_for("thread-a")
    b = _exec_lock_for("thread-b")
    assert a1 is a2, "same thread must share one channel"
    assert a1 is not b, "different threads must get independent channels"
    assert _exec_lock_for("") is _exec_lock_for("_default")


def test_parallel_threads_do_not_serialize():
    """两个线程各自持自己的通道睡 0.3s —— 总耗时应接近并行而非串行。"""
    start = time.monotonic()

    def _hold(key: str) -> None:
        with _exec_lock_for(key):
            time.sleep(0.3)

    t1 = threading.Thread(target=_hold, args=("ch-1",))
    t2 = threading.Thread(target=_hold, args=("ch-2",))
    t1.start()
    t2.start()
    t1.join()
    t2.join()
    elapsed = time.monotonic() - start
    assert elapsed < 0.55, f"independent channels serialized: {elapsed:.2f}s"


def test_same_thread_still_serializes():
    """同一通道仍然互斥（线程内一次一条命令的语义保留）。"""
    start = time.monotonic()

    def _hold() -> None:
        with _exec_lock_for("ch-same"):
            time.sleep(0.3)

    t1 = threading.Thread(target=_hold)
    t2 = threading.Thread(target=_hold)
    t1.start()
    t2.start()
    t1.join()
    t2.join()
    elapsed = time.monotonic() - start
    assert elapsed >= 0.55, f"same-channel mutual exclusion broken: {elapsed:.2f}s"
