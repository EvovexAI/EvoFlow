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
    # 【self-evolution-bot · 2026-11-22 · 第123轮】判据收窄到「瞥一眼 *.output」：
    # 读任意普通文件（如等构建写完再 tail 日志）属真实等待，15s 后本就自动转后台，
    # 不再当填充拦掉。本用例相应只钉 .output 这一种。
    msg = _pure_wait_guard(
        'sleep 50; tail -20 "C:/Users/admin/AppData/Local/Temp/evoflow-bash-tasks/043c435f81bd.output"'
    )
    assert msg is not None and "rejected" in msg
    assert _pure_wait_guard("sleep 30; cat a.output") is not None
    assert _pure_wait_guard("sleep 12 && tail -10 /tmp/x.output") is not None
    # 反证：普通文件不再是「填充」。这条改动是有意的——不要顺手改回去。
    assert _pure_wait_guard("sleep 30; cat a.txt") is None


def test_guard_rejects_long_sleep_even_with_trailing_work():
    # 2026-11-06 发版工程师：`sleep 480 && gh run view` 空等 CI
    # 第123轮起 CI 轮询走独立判据，回执不再吐秒数，只钉「拒 + 指路 gh run watch」
    msg = _pure_wait_guard(
        "sleep 480 && echo done && timeout 45 gh run view 42161650097 | head -10"
    )
    assert msg is not None and "rejected" in msg
    assert "gh run watch" in msg
    # 超过前台封顶且不含 CI/自有输出特征的，仍按超长 sleep 拒并报秒数
    msg = _pure_wait_guard("sleep 480; python build.py")
    assert msg is not None and "480" in msg


# ── 第123轮：判据按「有没有替代手段」分层 ────────────────────────────────
# 【self-evolution-bot · 2026-11-22 · 第123轮 · 模型:deepseek-v4.1-flash-1017】
# 为什么改：20s 单次上限是 1.4.0 引入的，当时前台还没有「超 15s 自动转后台」。
# 现在两者并存，守卫要防的「占住执行通道一分钟」已由转后台兜住。现网复算
# （近 7 天真实拒绝 51 次）里 15 次是「单次 25~60s + 真实工作」——等索引构建
# 写日志、等 pytest 落结果文件、等 curl 探到就绪，这些**没有完成通知可等**，
# 被拒后我平均要用 7.2 次调用 / 33.7s 去补偿。所以上限放宽到与前台封顶同口径，
# 但**替代手段存在的那两类照旧拒**（下面两条就是它们的反证）。


def test_guard_still_rejects_polling_own_background_output():
    """轮询自有后台任务输出必须照旧拒——完成通知本来就存在，睡多久都是白等。

    现网 19 次真实拒绝属这一类，是全量复算里唯一「拦得完全正确」的中长 sleep。
    """
    msg = _pure_wait_guard(
        'sleep 45; tail -20 "C:/Users/admin/AppData/Local/Temp/evoflow-bash-tasks/043c435f81bd.output"'
    )
    assert msg is not None and "rejected" in msg
    assert "task-notification" in msg, "要把替代手段（完成通知）说出来"
    # 短 sleep 也不行：判据是「在轮询自有输出」，与时长无关
    assert _pure_wait_guard(
        'sleep 3; cat "C:/Users/admin/AppData/Local/Temp/evoflow-bash-tasks/x.output"'
    ) is not None


def test_guard_still_rejects_ci_poll_with_sleep():
    """CI 轮询必须改用 `gh run watch`，与 sleep 长短无关。"""
    for cmd in (
        "sleep 45 && gh run view 1",
        "sleep 90 && gh run view 1",
        "sleep 21 && gh run view 1",
    ):
        msg = _pure_wait_guard(cmd)
        assert msg is not None, f"{cmd} 应被拒（该用 gh run watch）"
        assert "gh run watch" in msg


def test_guard_allows_mid_length_sleep_with_real_work():
    """单次 21~60s 且带真实工作 → 放行（这类没有完成通知可等）。

    判据钉的是「有没有替代手段」，不是「秒数是否超过 20」。
    """
    assert _pure_wait_guard("sleep 25 && python build.py") is None
    assert _pure_wait_guard("sleep 45 && tail -8 outputs/build.log") is None
    assert _pure_wait_guard("sleep 60 && python build.py") is None
    assert _pure_wait_guard(
        'cd /d/dev/github/EvoFlow && sleep 25; tail -3 outputs/pytest_full.txt'
    ) is None


def test_guard_rejects_sleep_above_foreground_ceiling():
    """超过前台封顶（60s）仍然拒：传更大也只是白等，且迟早被转后台。"""
    msg = _pure_wait_guard("sleep 61 && python build.py")
    assert msg is not None and "rejected" in msg
    msg = _pure_wait_guard("sleep 300 && python build.py")
    assert msg is not None


def test_guard_still_rejects_pure_wait_regardless_of_length():
    """反证：放宽的是「带真实工作」的中长 sleep，纯等待一律照旧拒。"""
    assert _pure_wait_guard("sleep 32; echo waited") is not None
    assert _pure_wait_guard("sleep 45; echo done") is not None
    assert _pure_wait_guard("sleep 12 && echo ok") is not None


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
