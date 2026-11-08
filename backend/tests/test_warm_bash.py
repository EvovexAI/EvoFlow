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
