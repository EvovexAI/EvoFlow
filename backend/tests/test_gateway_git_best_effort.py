"""Gateway best-effort git probes must not stall the event loop / other REST."""

from __future__ import annotations

import asyncio
import os
import time
from pathlib import Path
from unittest.mock import patch

import pytest

from app.gateway.hang_diagnostics import (
    register_inflight_request,
    should_shed_best_effort,
    unregister_inflight_request,
)
from app.gateway.middleware import _is_streaming_request_path
from app.gateway.routers import workspaces as ws


@pytest.mark.parametrize(
    ("path", "expected"),
    [
        ("/api/langgraph/threads/t1/runs/stream", True),
        ("/api/events/threads/__evopanel_shell__/panel-stream", True),
        ("/api/events/threads/abc/panel-stream", True),
        ("/api/v4/conversation/frames", True),
        ("/api/v4/conversation/frames?connectionId=x", True),
        ("/api/workspaces/git_status", False),
        ("/api/workspaces/git_ignored_paths", False),
        ("/api/chat/sessions", False),
        ("/health/ready", False),
    ],
)
def test_streaming_paths_excluded_from_hang_inflight(path: str, expected: bool) -> None:
    assert _is_streaming_request_path(path) is expected


def test_should_shed_when_multiple_slow_inflight() -> None:
    ids: list[int] = []
    try:
        for i in range(3):
            sid = 9000 + i
            ids.append(sid)
            register_inflight_request(scope_id=sid, method="GET", path=f"/api/slow/{i}", query=None)
            # Backdate so wait_seconds exceeds shed threshold.
            from app.gateway import hang_diagnostics as hd

            with hd._inflight_requests_lock:
                hd._inflight_requests[sid]["started_mono"] = time.monotonic() - 8.0
        assert should_shed_best_effort(min_slow=2, min_wait_s=5.0) is True
    finally:
        for sid in ids:
            unregister_inflight_request(sid)


@pytest.mark.asyncio
async def test_git_status_soft_fails_on_wall_timeout(tmp_path: Path) -> None:
    base = tmp_path

    def _hang() -> ws.GitStatusResponse:
        time.sleep(2.0)
        return ws._empty_git_status(base)

    with (
        patch.object(ws, "_GIT_STATUS_WALL_S", 0.2),
        patch.object(ws, "_collect_git_status_sync", side_effect=_hang),
        patch("app.gateway.hang_diagnostics.should_shed_best_effort", return_value=False),
    ):
        started = time.monotonic()
        result = await ws._run_git_bounded(
            lambda: _hang(),
            wall_s=0.2,
            label="git_status_test",
        )
        elapsed = time.monotonic() - started
    assert result is None
    assert elapsed < 1.5


@pytest.mark.asyncio
async def test_git_status_sheds_when_overloaded(tmp_path: Path) -> None:
    called = {"n": 0}

    def _boom() -> ws.GitStatusResponse:
        called["n"] += 1
        return ws._empty_git_status(tmp_path)

    with patch("app.gateway.hang_diagnostics.should_shed_best_effort", return_value=True):
        result = await ws._run_git_bounded(_boom, wall_s=5.0, label="shed_test")
    assert result is None
    assert called["n"] == 0


@pytest.mark.asyncio
async def test_git_ignored_collect_off_loop(tmp_path: Path) -> None:
    """Path.resolve batch must live in the sync helper, not the async route."""
    # Non-repo → empty ignored without touching event-loop Path.resolve in route.
    out = await asyncio.to_thread(ws._collect_git_ignored_sync, tmp_path, [str(tmp_path / "a.py")])
    assert out == []


def test_git_subprocess_hides_windows_console(monkeypatch: pytest.MonkeyPatch) -> None:
    """git.exe is a console subsystem app — must pass CREATE_NO_WINDOW or a black window flashes."""
    import subprocess

    captured: dict = {}

    class _Proc:
        returncode = 1

        def communicate(self, input=None, timeout=None):
            return ("", "")

        def kill(self):
            return None

        def wait(self, timeout=None):
            return 1

    def fake_popen(*args, **kwargs):
        captured.update(kwargs)
        return _Proc()

    monkeypatch.setattr(subprocess, "Popen", fake_popen)
    ws._git_subprocess_run(["git", "--version"], timeout=1.0)
    assert captured.get("stderr") is subprocess.DEVNULL
    if os.name == "nt":
        assert "creationflags" in captured or "startupinfo" in captured
    else:
        assert "creationflags" not in captured


def test_packaged_builtin_vault_skips_git(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    vault = tmp_path / "_internal" / "evoflow" / "assets" / "builtin_knowledge_vaults" / "user-guide"
    vault.mkdir(parents=True)
    called = {"n": 0}

    def boom(*_a, **_k):
        called["n"] += 1
        raise AssertionError("git must not spawn for packaged vaults")

    monkeypatch.setattr(ws, "_git_subprocess_run", boom)
    assert ws._is_packaged_non_git_workspace(vault) is True
    assert ws._git_repo_probe(vault) == (None, False, "")
    assert ws._collect_git_status_sync(vault).summary.isRepository is False
    assert ws._collect_git_ignored_sync(vault, [str(vault / "a.md")]) == []
    assert called["n"] == 0


def test_git_subprocess_kill_on_timeout(monkeypatch: pytest.MonkeyPatch) -> None:
    import subprocess

    killed = {"n": 0}

    class _Proc:
        returncode = None

        def communicate(self, input=None, timeout=None):
            if timeout is not None and timeout < 5:
                raise subprocess.TimeoutExpired(cmd=["slow"], timeout=timeout)
            return ("ok", "")

        def kill(self):
            killed["n"] += 1

        def wait(self, timeout=None):
            self.returncode = -9
            return self.returncode

    monkeypatch.setattr(subprocess, "Popen", lambda *a, **k: _Proc())
    with pytest.raises(subprocess.TimeoutExpired):
        ws._git_subprocess_run(["slow"], timeout=0.1)
    assert killed["n"] == 1
