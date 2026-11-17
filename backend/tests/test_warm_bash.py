"""Warm bash sessions: reuse one Git Bash process per thread channel."""

from __future__ import annotations

import importlib
import subprocess
import time

import pytest

bt = importlib.import_module("evoflow.tools.zcode_port.bash_tool")
wb = importlib.import_module("evoflow.tools.zcode_port.warm_bash")


@pytest.fixture(autouse=True)
def _reset_warm_pool():
    wb.reset_warm_sessions_for_tests(kill_tree=lambda pid: bt._kill_process_tree(pid))
    yield
    wb.reset_warm_sessions_for_tests(kill_tree=lambda pid: bt._kill_process_tree(pid))


@pytest.mark.parametrize(
    ("command", "need"),
    [
        ("git status --short", False),
        ("ls -la", False),
        ("echo hi", False),
        ("grep -n foo bar.txt", True),
        ("find . -name '*.py'", True),
        ("rg TODO src", True),
        ("cd x && grep foo *.md", True),
    ],
)
def test_needs_search_prelude(command: str, need: bool) -> None:
    assert bt._needs_search_prelude(command) is need


def test_script_skips_prelude_for_plain_echo(monkeypatch) -> None:
    monkeypatch.setattr(bt, "bash_shell", lambda: ["/bin/bash"])
    monkeypatch.setattr(bt, "embedded_search_enabled", lambda: True)
    monkeypatch.setattr(bt, "_embedded_prelude_text", lambda: "PRELUDE\n")
    argv, dialect = bt._script("echo hello", cwd="/tmp")
    assert dialect == "bash"
    script = argv[-1]
    assert "PRELUDE" not in script
    assert "echo hello" in script


def test_script_includes_prelude_for_grep(monkeypatch) -> None:
    monkeypatch.setattr(bt, "bash_shell", lambda: ["/bin/bash"])
    monkeypatch.setattr(bt, "embedded_search_enabled", lambda: True)
    monkeypatch.setattr(bt, "_embedded_prelude_text", lambda: "PRELUDE\n")
    argv, dialect = bt._script("grep foo bar", cwd="/tmp")
    assert dialect == "bash"
    assert argv[-1].startswith("PRELUDE")


@pytest.mark.skipif(bt.bash_shell() is None, reason="Git Bash / bash required")
def test_warm_reuses_same_pid(tmp_path) -> None:
    shell = bt.bash_shell()
    assert shell is not None
    key = "warm-test-reuse"
    kw = bt._popen_kwargs()
    r1 = wb.run_in_warm_bash(
        key=key,
        command="echo first",
        posix_cwd=bt._to_posix(str(tmp_path)),
        shell_argv=shell,
        prelude="",
        popen_kwargs=kw,
        timeout_s=10,
        kill_tree=lambda pid: bt._kill_process_tree(pid),
    )
    assert not r1.timed_out
    assert "first" in r1.stdout
    pid1 = r1.proc.pid if r1.proc else None

    r2 = wb.run_in_warm_bash(
        key=key,
        command="echo second",
        posix_cwd=bt._to_posix(str(tmp_path)),
        shell_argv=shell,
        prelude="",
        popen_kwargs=kw,
        timeout_s=10,
        kill_tree=lambda pid: bt._kill_process_tree(pid),
    )
    assert not r2.timed_out
    assert "second" in r2.stdout
    pid2 = r2.proc.pid if r2.proc else None
    assert pid1 and pid2 and pid1 == pid2


@pytest.mark.skipif(bt.bash_shell() is None, reason="Git Bash / bash required")
def test_warm_faster_than_cold_second_call(tmp_path) -> None:
    """Second warm call should beat a fresh bash -c cold start on average."""
    shell = bt.bash_shell()
    assert shell is not None
    key = "warm-test-bench"
    kw = bt._popen_kwargs()
    cwd = bt._to_posix(str(tmp_path))

    # Prime warm shell (exclude spawn from the comparison).
    primed = wb.run_in_warm_bash(
        key=key,
        command="echo prime",
        posix_cwd=cwd,
        shell_argv=shell,
        prelude="",
        popen_kwargs=kw,
        timeout_s=10,
        kill_tree=lambda pid: bt._kill_process_tree(pid),
    )
    assert not primed.timed_out

    warm_times: list[float] = []
    for i in range(3):
        t0 = time.perf_counter()
        r = wb.run_in_warm_bash(
            key=key,
            command=f"echo warm{i}",
            posix_cwd=cwd,
            shell_argv=shell,
            prelude="",
            popen_kwargs=kw,
            timeout_s=10,
            kill_tree=lambda pid: bt._kill_process_tree(pid),
        )
        warm_times.append(time.perf_counter() - t0)
        assert not r.timed_out

    cold_times: list[float] = []
    for i in range(3):
        t0 = time.perf_counter()
        argv = bt._bash_args(shell, f'cd "{cwd}" && echo cold{i}')
        run_kw: dict = {"capture_output": True, "text": True, "timeout": 10}
        if "creationflags" in kw:
            run_kw["creationflags"] = kw["creationflags"]
        proc = subprocess.run(argv, **run_kw)
        cold_times.append(time.perf_counter() - t0)
        assert proc.returncode == 0

    warm_med = sorted(warm_times)[len(warm_times) // 2]
    cold_med = sorted(cold_times)[len(cold_times) // 2]
    # Warm must not be slower than cold by much; absolute floor covers noisy CI
    # where both are already ~40ms and the ratio is meaningless.
    assert warm_med <= cold_med * 1.15 or warm_med < 0.08, (
        f"warm={warm_med:.3f}s cold={cold_med:.3f}s (warm_times={warm_times} cold_times={cold_times})"
    )


@pytest.mark.skipif(bt.bash_shell() is None, reason="Git Bash / bash required")
def test_run_foreground_warm_echo(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("EVOFLOW_BASH_WARM", "1")
    out = bt._run_foreground(
        "echo hello-warm",
        15_000,
        str(tmp_path),
        "call-warm-1",
        thread_id="thread-warm-1",
        explicit=True,
        description="echo",
        session_key="",
    )
    assert "hello-warm" in out
    assert "status: completed" in out


def test_warm_disabled_env(monkeypatch) -> None:
    monkeypatch.setenv("EVOFLOW_BASH_WARM", "0")
    assert wb.warm_enabled() is False
    assert bt._warm_bash_eligible("echo hi") is False


# 【self-evolution-bot · 2026-11-17 · 第32轮】回归：后台路径的终端事件必须真的发出去。
# 缺陷原样：_promote_warm_to_background / _run_background 的 _pump() 跑在普通线程里，
# 而 _emit → capture_stream_writer() 靠 contextvar 取 writer；threading.Thread 不继承
# contextvar（主线程 True / 新线程 False），于是后台 start/stdout/exit 全部静默丢弃，
# 且 continue_drain 没传 on_chunk → 整段后台期只有结束时才补一次性输出。
# 门禁对这类缺陷零分辨力：py_compile / ruff / 原有 13 个测试全绿。只有"接线断言"能抓。


def test_capture_writer_survives_thread_boundary() -> None:
    """捕获到的 writer 必须在另起的线程里照样可用（这正是修复的全部内容）。"""
    import threading

    from evoflow.scheduler.subagent_stream import parent_chat_stream_writer_ctx

    events: list[dict] = []
    with parent_chat_stream_writer_ctx(events.append):
        writer = bt._capture_writer()
        assert writer is not None, "调用线程上必须能抓到 writer"

        def _in_thread() -> None:
            # 新线程里 contextvar 是空的 —— 这是缺陷的物理来源，先断言它确实为空。
            from evoflow.tools.host_direct.terminal_stream import capture_stream_writer

            assert capture_stream_writer() is None, "前提失效：线程居然继承了 contextvar"
            # 显式传入捕获的 writer 则必须送达。
            bt._emit(
                "stdout",
                invocation_id="i",
                tool_call_id="tc",
                text="from-pump",
                stream_writer=writer,
            )

        t = threading.Thread(target=_in_thread)
        t.start()
        t.join()

    assert [e.get("text") for e in events if e.get("type") == "terminal_stdout"] == ["from-pump"]


def test_continue_drain_accepts_on_chunk() -> None:
    """continue_drain 必须支持 on_chunk 透传（后台续读同样要流式）。"""
    import inspect

    params = inspect.signature(wb.continue_drain).parameters
    assert "on_chunk" in params, "continue_drain 少了 on_chunk，后台路径又只能整段静默"


@pytest.mark.skipif(bt.bash_shell() is None, reason="Git Bash / bash required")
def test_promote_to_background_emits_events_from_pump_thread() -> None:
    """端到端：超预算转后台后，输出仍逐段出现在终端事件流里，且不重复不丢失。"""
    from evoflow.scheduler.subagent_stream import parent_chat_stream_writer_ctx
    from evoflow.tools.zcode_port.background import get_task

    wb._mark_warm_bash_child = lambda *a, **k: None
    events: list[dict] = []
    tool_call_id = "promote-bg-tc"
    command = "for i in 1 2 3; do echo bg$i; sleep 0.6; done"

    # 走真实入口 _run_foreground：它才会把 on_chunk 接给 run_in_warm_bash，
    # 于是"前台已发 + 后台续发"才能拼成一份完整输出。
    monkeypatch = pytest.MonkeyPatch()
    monkeypatch.setattr(bt, "FOREGROUND_BLOCKING_CEILING_MS", 1000)
    try:
        with parent_chat_stream_writer_ctx(events.append):
            out = bt._run_foreground(
                command,
                20_000,
                "/tmp",
                tool_call_id,
                thread_id="promote-bg-thread",
                explicit=True,
                description="promote-bg",
                session_key="promote-bg-sk",
            )
            assert "backgroundTaskId: " in out, f"预期转后台，实际: {out[:200]}"
            task_id = out.split("backgroundTaskId: ")[1].split("\n")[0].strip()

            deadline = time.time() + 25
            while time.time() < deadline:
                task = get_task(task_id)
                if task is not None and task.status != "running":
                    break
                time.sleep(0.1)
    finally:
        monkeypatch.undo()

    mine = [e for e in events if str(e.get("tool_call_id") or "") == tool_call_id]
    streamed = "".join(
        str(e.get("text") or "") for e in mine if e.get("type") == "terminal_stdout"
    )
    types = {str(e.get("type")) for e in mine}

    assert "terminal_stdout" in types, (
        "后台 pump 线程一条 stdout 都没发出去——writer 没跨线程传下来"
    )
    assert "terminal_exit" in types, "后台结束事件也丢了"
    # 前台 + 后台合计必须是完整输出，且每一行只出现一次（无重复、无丢失）。
    for i in (1, 2, 3):
        assert streamed.count(f"bg{i}") == 1, f"bg{i} 出现 {streamed.count(f'bg{i}')} 次: {streamed!r}"
    stripped = streamed.strip()
    assert stripped.endswith("bg3"), f"最后一行缺失: {streamed!r}"



@pytest.mark.skipif(bt.bash_shell() is None, reason="Git Bash / bash required")
def test_promote_writes_output_file_incrementally(monkeypatch) -> None:
    """转后台之后，output 文件的行数必须**继续增长**。

    判据必须用两个都在转后台之后的快照：转后台那一刻本来就会 write_text 一次
    前台已收内容，拿「转后台后文件非空」当证据会被这份旧快照骗过——我第一版
    就这么写的，A/B 时在修复前的代码上照样绿。
    """
    from evoflow.scheduler.subagent_stream import parent_chat_stream_writer_ctx
    from evoflow.tools.zcode_port.background import get_task

    wb._mark_warm_bash_child = lambda *a, **k: None
    monkeypatch.setattr(bt, "FOREGROUND_BLOCKING_CEILING_MS", 1000)

    with parent_chat_stream_writer_ctx(lambda _e: None):
        out = bt._run_foreground(
            "for i in 1 2 3 4 5 6 7 8; do echo tick$i; sleep 0.6; done",
            30_000,
            "/tmp",
            "interim-tc-2",
            thread_id="interim-thread-2",
            explicit=True,
            description="interim2",
            session_key="interim-sk-2",
        )
        assert "backgroundTaskId: " in out, f"预期转后台: {out[:200]}"
        task_id = out.split("backgroundTaskId: ")[1].split("\n")[0].strip()
        task = get_task(task_id)
        assert task is not None
        path = task.output_path

        def _lines() -> list[str]:
            txt = path.read_text(encoding="utf-8", errors="replace")
            return [ln for ln in txt.splitlines() if ln.startswith("tick")]

        # 两个快照都取在转后台之后，此时命令仍在跑（总时长约 4.8s）。
        time.sleep(1.2)
        early = _lines()
        time.sleep(1.4)
        late = _lines()

        deadline = time.time() + 30
        while time.time() < deadline:
            t = get_task(task_id)
            if t is not None and t.status != "running":
                break
            time.sleep(0.1)
        final = _lines()

    assert early, "转后台 1.2s 后 output 文件还是空的——连前台已收内容都没落盘"
    assert len(late) > len(early), (
        f"命令还在跑，但文件行数没增长（{len(early)} -> {len(late)} 行）："
        "增量落盘没生效，返回文案里「Read 该文件看中间输出」是空头支票"
    )
    # 每行只出现一次（增量 append + 收尾重写不能叠加成双份）
    assert final == [f"tick{i}" for i in range(1, 9)], f"内容不符: {final}"
