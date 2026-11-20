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
    """够 bash_tool 取 thread_id / session_key / 工作区的最小替身。"""

    def __init__(self, thread_id: str, workspace_root: str = "") -> None:
        self.context = {
            "thread_id": thread_id,
            "session_key": thread_id,
            "local_workspace_root": workspace_root,
        }
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


def _run_ws(thread_id: str, workspace_root: str, command: str) -> str:
    """带工作区绑定的调用（模拟 UI 里给这个会话选了一个本地工作区）。"""
    out = bt.bash_tool.func(
        description="cwd workspace probe",
        command=command,
        runtime=_Runtime(thread_id, workspace_root=workspace_root),
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


def test_switching_workspace_discards_stale_cwd(tmp_path) -> None:
    """同一个会话在 UI 里切换工作区后，旧工作区留下的 cwd 必须失效。

    【self-evolution-bot · 2026-11-19 · 第68轮】用户提醒「每个对话工作区不一样」。
    实测缺陷：会话先绑 wsA、在里面 `cd ../` 跳出，再切到 wsB，旧实现仍返回
    /Temp（wsA 的上级）——命令直接在本轮工作区之外执行。
    """
    ws_a = tmp_path / "wsA"
    ws_b = tmp_path / "wsB"
    ws_a.mkdir()
    ws_b.mkdir()
    tid = "pytest-cwd-ws-switch"

    _run_ws(tid, str(ws_a), "pwd")
    # 在 wsA 里故意跳出工作区，制造一个「对 wsB 来说非法」的残留 cwd
    _run_ws(tid, str(ws_a), "cd ../")

    reported = _reported_cwd(_run_ws(tid, str(ws_b), "pwd"))
    assert reported == bt._to_posix(str(ws_b)), (
        f"切换工作区后 cwd 仍是旧值：期望 {bt._to_posix(str(ws_b))}，实际 {reported}"
    )


def test_two_threads_do_not_share_cwd(tmp_path) -> None:
    """不同会话绑不同工作区时，cwd 不能互相串。"""
    ws_a = tmp_path / "tA"
    ws_b = tmp_path / "tB"
    ws_a.mkdir()
    ws_b.mkdir()

    _run_ws("pytest-iso-A", str(ws_a), "pwd")
    _run_ws("pytest-iso-B", str(ws_b), "pwd")

    assert _reported_cwd(_run_ws("pytest-iso-A", str(ws_a), "pwd")) == bt._to_posix(str(ws_a))
    assert _reported_cwd(_run_ws("pytest-iso-B", str(ws_b), "pwd")) == bt._to_posix(str(ws_b))


# ─────────── /tmp 这类 MSYS 虚拟路径的 cwd 不许静默丢弃（第89轮补）───────────


def test_msys_tmp_cwd_is_mapped_not_dropped(tmp_path, monkeypatch):
    """Git Bash 的 `/tmp` 转不成 Windows 路径时，曾把整个 cwd 静默丢掉。

    `from_bash_posix_path` 有意不转换 `/tmp`（当它“普通 POSIX 路径”原样返回），
    于是 `Path('/tmp/x').is_dir()` 恒 False，`_remember_cwd` 直接 return——
    模型以为 cd 生效了，read 的相对路径却拼到旧根上。
    实证：2026-11-20 重启后实测 `cd /tmp/evoflow-cwd-proof` 后 read 报错里的
    「bash 当前目录」仍是上一个目录。

    判据：映射到 %TEMP% 之后必须**记得住**，而不是记得住「原样 /tmp」。
    """
    import importlib

    bt = importlib.import_module("evoflow.tools.zcode_port.bash_tool")
    bt._PERSISTED_CWD.clear()

    real = tmp_path / "evoflow-cwd-proof"
    real.mkdir()
    # 让 /tmp 映射到 tmp_path，构造一个真实存在但 posix 形式不可解析的目录
    monkeypatch.setenv("TEMP", str(tmp_path))
    monkeypatch.setenv("TMP", str(tmp_path))

    bt._remember_cwd("t-tmp-map", "/tmp/evoflow-cwd-proof")
    got = bt.thread_cwd_for("t-tmp-map")

    assert got, "/tmp 下的 cwd 被静默丢弃了（本缺陷的原始形态）"
    assert got.replace("\\", "/").endswith("evoflow-cwd-proof"), got
    assert "/tmp" not in got.replace("\\", "/").rstrip("/").split("/")[:1]


def test_tmp_mapping_ignores_unmappable_paths():
    """`/dev`、`/usr` 没有可靠 Windows 对应物，不许硬映射成假路径。"""
    import importlib

    bt = importlib.import_module("evoflow.tools.zcode_port.bash_tool")
    assert bt._msys_tmp_to_windows("/dev/null") == ""
    assert bt._msys_tmp_to_windows("/usr/bin") == ""
    assert bt._msys_tmp_to_windows("") == ""
