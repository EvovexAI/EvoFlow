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
    # 有实质命令且单次 sleep ≤20s 不拦；纯读文件的「假有活」见 progress-poll 用例
    assert _pure_wait_guard("sleep 15 && python build.py") is None
    assert _pure_wait_guard("sleep 20 && python build.py") is None
    assert _pure_wait_guard("for i in 1 2 3; do curl -s http://x; sleep 15; done") is None


def test_guard_rejects_progress_poll_sleep_tail_cat():
    # 2026-11-10 正式包：`sleep 50; tail …evoflow-bash-tasks…output` 假等待
    msg = _pure_wait_guard(
        'sleep 50; tail -20 "C:/Users/admin/AppData/Local/Temp/evoflow-bash-tasks/043c435f81bd.output"'
    )
    assert msg is not None and "rejected" in msg
    assert _pure_wait_guard("sleep 30; cat a.txt") is not None
    assert _pure_wait_guard("sleep 12 && tail -10 /tmp/x.output") is not None


def test_guard_rejects_long_sleep_even_with_trailing_work():
    # 2026-11-06 发版工程师：`sleep 480 && gh run view` 空等 CI；单次 >20s 一律拒
    msg = _pure_wait_guard(
        "sleep 480 && echo done && timeout 45 gh run view 42161650097 | head -10"
    )
    assert msg is not None and "rejected" in msg
    assert "480" in msg
    assert _pure_wait_guard("sleep 90 && gh run view 1") is not None
    assert _pure_wait_guard("sleep 45 && gh run view 1") is not None
    assert _pure_wait_guard("sleep 21 && gh run view 1") is not None
    assert _pure_wait_guard("sleep 20 && gh run view 1") is None


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


# ── 转后台时长等待必须放行（第89轮补）───────────────────────────────
# 【self-evolution-bot · 2026-11-20 · 第89轮 · 模型:deepseek-v4.1-flash-1017】
# 拒绝文案自己写着「长等待请用 run_in_background=true」，而判定只看单次 sleep
# 时长、压根没看是否转后台——等于文案在教一个它自己不允许的动作。
# 实证：2026-11-20 为验 taskoutput 30s 封顶需造 40s 后台任务，连撞两次拒绝，
# 最后只能用 `(sleep 18; sleep 18)` 绕过。


def test_guard_allows_long_sleep_when_backgrounded():
    """转后台的长等待必须放行——它不占前台通道。"""
    assert _pure_wait_guard("sleep 40", run_in_background=True) is None
    assert _pure_wait_guard("sleep 480 && gh run view 1", run_in_background=True) is None


def test_guard_still_rejects_long_sleep_in_foreground():
    """前台限制逐字不变（反证：别为了让后台过而把前门敞开）。"""
    assert _pure_wait_guard("sleep 40") is not None
    assert _pure_wait_guard("sleep 40", run_in_background=False) is not None
    assert _pure_wait_guard("sleep 21", run_in_background=False) is not None


def test_guard_background_does_not_allow_without_sleep():
    """不含等待的命令本来就不归这个守卫管，转后台与否都不该报错。"""
    assert _pure_wait_guard("ls -la", run_in_background=True) is None
    assert _pure_wait_guard("", run_in_background=True) is None


def test_bash_tool_wires_background_flag_into_guard(monkeypatch):
    """接线测试：必须从 bash_tool 真实入口进，`run_in_background="true"` 能传到守卫。

    只测 `_pure_wait_guard(...)` 等于没修——第12/16轮教训：函数层绿、调用点没传参。
    """
    import importlib

    bt = importlib.import_module("evoflow.tools.zcode_port.bash_tool")
    seen: dict = {}
    real = bt._pure_wait_guard

    def _spy(command, *, run_in_background=False):
        seen["run_in_background"] = run_in_background
        return real(command, run_in_background=run_in_background)

    monkeypatch.setattr(bt, "_pure_wait_guard", _spy)

    class _RT:
        context = {"thread_id": "t-guard-wire"}
        config: dict = {}
        state: dict = {}

    # 模块属性 bash_tool 已被 @tool 覆盖为 StructuredTool，取原函数用 .func
    out = bt.bash_tool.func("sleep 40", run_in_background="true", runtime=_RT())
    assert seen.get("run_in_background") is True, ("标志没传到守卫：", seen, "输出", out)
    assert "过长 sleep" not in str(out), ("转后台仍被拒：", out)
