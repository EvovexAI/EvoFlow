"""第22轮新增：terminal 硬拦的「同一条命令」精确判据测试。

判据：硬拦要求「粗指纹 ≥5」**且**「归一化完整命令 ≥5」同时成立。

用例全部取自 obs 现网被拦最多的真实桶（2026-11-09~16）：
  · ``terminal:ls -l --time-style craft.py`` 被拦 111 次，吞 5 条不同命令
  · ``terminal:git diff --name-only head``   吞多条不同文件路径

重要：本文件的「同桶不同命令」样例必须先用生产指纹函数验过（见各用例注释），
否则会出现「测试全绿但根本没走到双条件分支」的空过 —— 我第22轮第一版就踩了这个。
"""
from unittest.mock import MagicMock

from langchain_core.messages import ToolMessage

from evoflow.agents.middlewares.loop_detection_middleware import (
    _EXPLORE_BLOCK_MSG,
    _EXPLORE_WARNING_MSG,
    LoopDetectionMiddleware,
    _explore_loop_fingerprint,
    _terminal_exact_command_key,
)


def _bash(cmd, call_id=None):
    return {"name": "bash", "id": call_id or f"c_{abs(hash(cmd))}", "args": {"command": cmd}}


def _fp(cmd):
    return _explore_loop_fingerprint({"name": "bash", "args": {"command": cmd}, "id": ""})


# 实测同桶、不同命令的两族（下面两个 class 直接 import 用）
LS_FAMILY = [
    "cd /d/dev/github/EvoFlow && ls -l --time-style=+%H:%M:%S craft.py hub.py",
    "cd /d/dev/github/EvoFlow && ls -l --time-style=+%H:%M:%S craft.py hub.py; echo done",
    "cd D:/dev/github/EvoFlow && ls -l --time-style=+%H:%M:%S craft.py hub.py 2>&1",
    "cd /d/dev/github/EvoFlow && ls -l --time-style=+%H:%M:%S craft.py hub.py | head -3",
    "cd /d/dev/github/EvoFlow && ls -l --time-style=+%H:%M:%S craft.py hub.py && true",
]

GIT_DIFF_FAMILY = [
    "cd /d/dev/github/EvoFlow && echo V1 && git diff --name-only HEAD -- evopanel/CHANGELOG.md",
    "cd /d/dev/github/EvoFlow && echo V2 && git diff --name-only HEAD -- scripts/x.json",
    "cd /d/dev/github/EvoFlow && echo V3 && git diff --name-only HEAD -- docs/a.md",
    "cd /d/dev/github/EvoFlow && echo V4 && git diff --name-only HEAD -- backend/b.py",
    "cd /d/dev/github/EvoFlow && echo V5 && git diff --name-only HEAD -- evopanel/c.ts",
]


class TestTerminalExactCommandKey:
    """精确尺本身的归一化语义。"""

    def test_same_command_different_cd_prefix_is_same_key(self):
        a = _terminal_exact_command_key({"command": "cd /d/dev/github/EvoFlow && python -m pytest tests/x.py"})
        b = _terminal_exact_command_key({"command": "cd D:/dev/github/EvoFlow && python -m pytest tests/x.py"})
        c = _terminal_exact_command_key({"command": "python -m pytest tests/x.py"})
        assert a == b == c == "python -m pytest tests/x.py", (a, b, c)

    def test_whitespace_and_case_folded(self):
        a = _terminal_exact_command_key({"command": "cd x && python  -m   pytest  A.py"})
        b = _terminal_exact_command_key({"command": "python -m pytest a.py"})
        assert a == b, (a, b)

    def test_different_test_files_different_key(self):
        a = _terminal_exact_command_key({"command": "python -m pytest tests/test_a.py"})
        b = _terminal_exact_command_key({"command": "python -m pytest tests/test_b.py"})
        assert a != b

    def test_empty_command_none(self):
        assert _terminal_exact_command_key({}) is None
        assert _terminal_exact_command_key({"command": "   "}) is None


class TestFixtureSanity:
    """先证明样本真的同桶 —— 否则下面「不该拦」的断言是空过。"""

    def test_ls_family_shares_one_bucket(self):
        fps = {_fp(c) for c in LS_FAMILY}
        assert len(fps) == 1 and None not in fps, f"样本不同桶，用例无效：{fps}"

    def test_git_diff_family_shares_one_bucket(self):
        fps = {_fp(c) for c in GIT_DIFF_FAMILY}
        assert len(fps) == 1 and None not in fps, f"样本不同桶，用例无效：{fps}"

    def test_families_have_distinct_exact_keys(self):
        """同桶但精确命令两两不同 —— 这才是双条件能救的场景。"""
        keys = {_terminal_exact_command_key({"command": c}) for c in LS_FAMILY}
        assert len(keys) == len(LS_FAMILY), f"样本精确键重复，用例无效：{keys}"


class TestTerminalExactHardBlock:
    """硬拦的双条件行为。"""

    def test_ls_family_five_distinct_commands_not_blocked(self):
        """反证核心：同一个桶里 5 条不同命令 → 一条都不许拦（旧判据第 5 条必被误拦）。"""
        mw = LoopDetectionMiddleware()
        tid = "ls-family-thread"
        for i, cmd in enumerate(LS_FAMILY):
            out = mw._check_explore_loops(tid, [_bash(cmd, call_id=f"l{i}")])
            assert out != _EXPLORE_BLOCK_MSG, f"第 {i+1} 条全新命令被误拦（第22轮要修的正是这个）：{out}"

    def test_git_diff_family_five_distinct_commands_not_blocked(self):
        mw = LoopDetectionMiddleware()
        tid = "git-diff-thread"
        for i, cmd in enumerate(GIT_DIFF_FAMILY):
            out = mw._check_explore_loops(tid, [_bash(cmd, call_id=f"g{i}")])
            assert out != _EXPLORE_BLOCK_MSG, f"第 {i+1} 条全新命令被误拦：{out}"

    def test_same_command_five_times_still_blocked(self):
        """正证：同一条命令第 5 次必须拦住（真 thrash 一次不放过）。"""
        mw = LoopDetectionMiddleware()
        tid = "same-cmd-thread"
        cmd = LS_FAMILY[0]
        for i in range(4):
            out = mw._check_explore_loops(tid, [_bash(cmd, call_id=f"s{i}")])
            assert out != _EXPLORE_BLOCK_MSG, f"前 4 次不该拦，第 {i+1} 次：{out}"
        fifth = mw._check_explore_loops(tid, [_bash(cmd, call_id="s4")])
        assert fifth == _EXPLORE_BLOCK_MSG, f"同一条命令第 5 次必须拦，实际：{fifth}"

    def test_same_command_with_changing_cd_prefix_blocked(self):
        """同一条命令换 cd 前缀重跑 → 仍算同一条，第 5 次拦住。

        注意不能用 ``git status``：裸 ``git status`` 被 _is_safe_terminal_command 豁免
        （指纹 None），带 cd 前缀才进检测 —— 第一版用例就是撞了这条，空过。
        """
        mw = LoopDetectionMiddleware()
        tid = "cd-variant-thread"
        base = "python -m pytest tests/test_x.py"
        seq = [
            f"cd /d/dev/github/EvoFlow/backend && {base}",
            f"cd D:/dev/github/EvoFlow/backend && {base}",
            f"cd /d/dev/github/EvoFlow/backend && {base}",
            f"cd D:/dev/github/EvoFlow/backend && {base}",
        ]
        assert all(_fp(c) is not None for c in seq), "样本被豁免了，用例无效"
        for i, cmd in enumerate(seq):
            assert mw._check_explore_loops(tid, [_bash(cmd, call_id=f"v{i}")]) != _EXPLORE_BLOCK_MSG
        out = mw._check_explore_loops(tid, [_bash(base, call_id="v4")])
        assert out == _EXPLORE_BLOCK_MSG, f"同一命令换 cd 前缀仍应被拦，实际：{out}"

    def test_warn_still_fires_on_coarse_bucket(self):
        """回归：warn(3) 仍只看粗指纹 —— 同桶第 3 条就给提示（提示不拦，保持灵敏度）。"""
        mw = LoopDetectionMiddleware()
        tid = "warn-thread"
        mw._check_explore_loops(tid, [_bash(LS_FAMILY[0], call_id="w0")])
        mw._check_explore_loops(tid, [_bash(LS_FAMILY[1], call_id="w1")])
        third = mw._check_explore_loops(tid, [_bash(LS_FAMILY[2], call_id="w2")])
        assert third == _EXPLORE_WARNING_MSG, f"同桶第 3 条应给 warn，实际：{third}"


class TestReadOffsetBucketUnchanged:
    """回归：read_file 的 offset 分桶是准的，不许被第22轮波及。"""

    def test_read_same_path_same_bucket_still_blocked(self):
        mw = LoopDetectionMiddleware()
        tid = "read-thread"
        call = {"name": "read_file", "id": "r", "args": {"path": "/tmp/a.py", "offset": 10}}
        for i in range(4):
            assert mw._check_explore_loops(tid, [call]) != _EXPLORE_BLOCK_MSG, f"第 {i+1} 次不该拦"
        assert mw._check_explore_loops(tid, [call]) == _EXPLORE_BLOCK_MSG

    def test_read_different_paths_not_blocked(self):
        mw = LoopDetectionMiddleware()
        tid = "read-distinct-thread"
        for i in range(6):
            call = {"name": "read_file", "id": f"rd{i}", "args": {"path": f"/tmp/f{i}.py"}}
            out = mw._check_explore_loops(tid, [call])
            assert out != _EXPLORE_BLOCK_MSG, f"第 {i+1} 个不同文件被误拦：{out}"


class TestExactHistoryLifecycle:
    """接线：第二本账必须在 驱逐 / 写盘重置 / reset 三处都被清掉。"""

    def test_reset_clears_exact_history(self):
        mw = LoopDetectionMiddleware()
        tid = "lifecycle-thread"
        cmd = "cd /d/dev/github/EvoFlow && python -m pytest tests/x.py"
        for i in range(4):
            mw._check_explore_loops(tid, [_bash(cmd, call_id=f"l{i}")])
        assert tid in mw._explore_exact_history
        mw.reset(tid)
        assert tid not in mw._explore_exact_history
        for i in range(4):
            out = mw._check_explore_loops(tid, [_bash(cmd, call_id=f"m{i}")])
            assert out != _EXPLORE_BLOCK_MSG, f"reset 后第 {i+1} 次被拦：{out}"

    def test_reset_all_clears_exact_history(self):
        mw = LoopDetectionMiddleware()
        mw._check_explore_loops("t1", [_bash(LS_FAMILY[0], call_id="a")])
        mw._check_explore_loops("t2", [_bash(GIT_DIFF_FAMILY[0], call_id="b")])
        assert mw._explore_exact_history
        mw.reset()
        assert mw._explore_exact_history == {}

    def test_evict_clears_exact_history(self):
        """LRU 驱逐必须也清第二本账，否则线程历史泄漏。

        注意：``_evict_if_needed`` 的循环条件是 ``len(self._history)`` 超限，而
        ``_check_explore_loops`` 这条路径不写 ``_history``（生产里由全局批次检查写）。
        所以这里直接构造 ``_history`` 触发驱逐，验证的是**我新增的接线**，
        不是假装探索路径会自己触发驱逐。
        """
        mw = LoopDetectionMiddleware(max_tracked_threads=2)
        for i in range(3):
            tid = f"evict-{i}"
            mw._check_explore_loops(tid, [_bash(LS_FAMILY[0], call_id=f"e{i}")])
            mw._history[tid] = []          # 生产里另一条路径会写；这里手动补上
        assert len(mw._explore_exact_history) == 3
        mw._evict_if_needed()
        assert len(mw._explore_exact_history) <= 2, (
            f"第二本账没跟着驱逐：{list(mw._explore_exact_history)}"
        )
        assert "evict-0" not in mw._explore_exact_history, "最老的线程没被驱逐"

    def test_successful_write_clears_exact_history(self):
        """沿用第20轮语义：成功写盘作废两本账。"""
        mw = LoopDetectionMiddleware()
        tid = "write-exact-thread"
        cmd = "cd /d/dev/github/EvoFlow && python -m pytest tests/x.py"
        for i in range(4):
            mw._check_explore_loops(tid, [_bash(cmd, call_id=f"x{i}")])
        assert tid in mw._explore_exact_history

        wcall = {"name": "write", "id": "wr", "args": {"path": "/tmp/x.py", "content": "print(1)"}}
        req = MagicMock()
        req.tool_call = wcall
        req.runtime = MagicMock()
        req.runtime.context = {"thread_id": tid}
        mw._reset_explore_after_mutation(req, ToolMessage(content="ok", tool_call_id="wr"))
        assert tid not in mw._explore_exact_history
