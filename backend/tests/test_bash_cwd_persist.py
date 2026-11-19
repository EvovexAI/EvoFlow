"""bash 工具的 cwd 持久化：命令里的 `cd` 必须影响下一条调用。

【self-evolution-bot · 2026-11-19 · 第68轮 · 模型:deepseek-v4.1-flash-1017】

为什么单独建这个文件：现有 test_warm_bash.py 只断言「脚本能 cd 进初始目录」，
从没断言「命令内部的 cd 会不会留到下一条」——而后者才是工具描述里
"Working directory persists between calls" 承诺的东西。改前改后那 33 条都绿，
说明它们对这个缺陷零分辨力。

现网证据（7 天 19561 次 bash）：92.8% 的命令自带 `cd … &&` 前缀，
我自己 96.0%、release-engineer 98.4%；不带 cd 的命令「路径不存在」类报错率
2.82% vs 带 cd 的 0.93%（3 倍）。根因是 warm 脚本用 `( … )` 子shell，
`cd` 只在子shell 内生效，而标记行在子shell 外 printf "$PWD"，永远是初始目录。
"""

from __future__ import annotations

import importlib

import pytest

bt = importlib.import_module("evoflow.tools.zcode_port.bash_tool")
wb = importlib.import_module("evoflow.tools.zcode_port.warm_bash")


@pytest.fixture(autouse=True)
def _reset_warm_pool():
    wb.reset_warm_sessions_for_tests(kill_tree=lambda pid: bt._kill_process_tree(pid))
    bt._PERSISTED_CWD.clear()
    yield
    wb.reset_warm_sessions_for_tests(kill_tree=lambda pid: bt._kill_process_tree(pid))
    bt._PERSISTED_CWD.clear()


class _Runtime:
    """够 bash_tool 取 thread_id / session_key 的最小替身。"""

    def __init__(self, thread_id: str) -> None:
        self.context = {"thread_id": thread_id, "session_key": thread_id}
        self.state: dict = {}
        self.config: dict = {}
        self.stream_writer = None
        self.tool_call_id = "tc-cwd-probe"
        self.store = None


def _run(thread_id: str, command: str) -> str:
    out = bt.bash_tool.func(
        description="cwd persistence probe",
        command=command,
        runtime=_Runtime(thread_id),
    )
    return out if isinstance(out, str) else str(out)


def _reported_cwd(result: str) -> str:
    for line in result.splitlines():
        if line.startswith("cwd:"):
            return line[len("cwd:") :].strip()
    return ""


def test_cd_inside_command_persists_to_next_call(tmp_path) -> None:
    """命令里的 cd 必须影响下一条调用的 cwd（工具描述承诺的语义）。"""
    target = tmp_path / "sub"
    target.mkdir()
    tid = "pytest-cwd-persist-1"

    target_posix = bt._to_posix(str(target))
    _run(tid, f'cd "{target_posix}"')

    # 关键断言：下一条命令不带 cd，也必须已经在 target 里
    reported = _reported_cwd(_run(tid, "pwd"))
    assert reported == target_posix, (
        f"cd 没有持久化：期望 {target_posix}，实际 {reported}。"
        "说明命令内部的 cd 被 `( … )` 子shell 吃掉了。"
    )


def test_reported_cwd_matches_actual_pwd(tmp_path) -> None:
    """回显的 cwd 行必须等于命令自己 pwd 出来的值（不是初始目录）。"""
    target = tmp_path / "another"
    target.mkdir()
    tid = "pytest-cwd-persist-2"
    target_posix = bt._to_posix(str(target))

    result = _run(tid, f'cd "{target_posix}" && pwd')
    actual = ""
    for line in result.splitlines():
        if line.strip() == target_posix:
            actual = line.strip()
            break

    assert actual == target_posix, "命令内 pwd 没到目标目录，环境本身有问题"
    reported = _reported_cwd(result)
    assert reported == target_posix, (
        f"回显 cwd({reported}) 与命令内 pwd({actual}) 不一致 —— "
        "标记行取的是子shell外的 $PWD。"
    )


def test_exit_code_still_reported_after_fix() -> None:
    """标记行搬进子shell 后，退出码必须仍然是命令的真实退出码。"""
    tid = "pytest-cwd-persist-3"
    ok = _run(tid, "true")
    assert "status: completed" in ok

    bad = _run(tid, "exit 7")
    assert "exitCode: 7" in bad, f"退出码丢失或被 trap 覆盖：{bad[:200]}"
