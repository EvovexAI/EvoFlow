"""Tests for rg / ripgrep host-direct tool."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

from evoflow.tools.host_direct.rg import _find_rg_binary, _run_rg_wallclock
from evoflow.tools.host_direct.workspace_path_guard import runtime_with_workspace
from evoflow.utils.bundled_tools import bundled_ripgrep_binary


def test_find_rg_binary_returns_none_when_missing():
    with (
        patch("evoflow.tools.host_direct.rg.shutil.which", return_value=None),
        patch("evoflow.utils.bundled_tools.bundled_ripgrep_binary", return_value=None),
    ):
        assert _find_rg_binary() is None


def test_find_rg_binary_uses_bundled_when_path_missing(tmp_path: Path):
    bundled = tmp_path / "tools" / "ripgrep" / "rg.exe"
    bundled.parent.mkdir(parents=True)
    bundled.write_bytes(b"")
    with (
        patch("evoflow.tools.host_direct.rg.shutil.which", return_value=None),
        patch("evoflow.utils.bundled_tools.bundled_ripgrep_binary", return_value=str(bundled)),
    ):
        assert _find_rg_binary() == str(bundled)


def test_bundled_ripgrep_binary_frozen_layout(tmp_path: Path, monkeypatch):
    rg_dir = tmp_path / "tools" / "ripgrep"
    rg_dir.mkdir(parents=True)
    rg_exe = rg_dir / "rg.exe"
    rg_exe.write_bytes(b"")
    fake_exe = tmp_path / "evoflow-gateway.exe"
    fake_exe.write_bytes(b"")
    monkeypatch.setattr("evoflow.utils.bundled_tools.sys.frozen", True, raising=False)
    monkeypatch.setattr("evoflow.utils.bundled_tools.sys.executable", str(fake_exe))
    assert bundled_ripgrep_binary() == str(rg_exe)


def test_bundled_ripgrep_binary_dev_layout(tmp_path: Path, monkeypatch):
    backend = tmp_path / "backend"
    bundle_dir = backend / "packaging" / "ripgrep-bundle" / "win-x64"
    bundle_dir.mkdir(parents=True)
    rg_exe = bundle_dir / "rg.exe"
    rg_exe.write_bytes(b"")
    monkeypatch.setattr("evoflow.utils.bundled_tools.sys.frozen", False, raising=False)
    monkeypatch.setattr("evoflow.utils.bundled_tools._backend_dir_from_harness", lambda: backend)
    assert bundled_ripgrep_binary() == str(rg_exe)


def test_rg_fallback_when_binary_missing(tmp_path: Path):
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "app.py").write_text("raise ValueError('x')\n", encoding="utf-8")
    rt = runtime_with_workspace(str(tmp_path), "t-rg")
    with patch("evoflow.tools.host_direct.rg._find_rg_binary", return_value=None):
        out = _run_rg_wallclock(
            pattern="ValueError",
            path="src",
            glob_pattern="*.py",
            context_before=0,
            context_after=0,
            case_sensitive=False,
            output_mode="content",
            max_results=20,
            runtime=rt,
        )
    assert "ValueError" in out or "no matches" in out.lower()
    assert "fallback" in out.lower() or "[index" in out.lower() or "app.py" in out


def test_rg_fallback_single_file_path(tmp_path: Path):
    fp = tmp_path / "only.js"
    fp.write_text("installModelDetailDelegate\n", encoding="utf-8")
    rt = runtime_with_workspace(str(tmp_path), "t-rg-file")
    with patch("evoflow.tools.host_direct.rg._find_rg_binary", return_value=None):
        out = _run_rg_wallclock(
            pattern="installModelDetailDelegate",
            path=str(fp),
            glob_pattern=None,
            context_before=0,
            context_after=0,
            case_sensitive=False,
            output_mode="content",
            max_results=20,
            runtime=rt,
        )
    assert "installModelDetailDelegate" in out
    assert "Workspace root is not a directory" not in out


def test_rg_native_invocation(tmp_path: Path):
    (tmp_path / "a.txt").write_text("hello rg tool\n", encoding="utf-8")
    rt = runtime_with_workspace(str(tmp_path), "t-rg2")
    fake_rg = "C:\\fake\\rg.exe"

    def _fake_run(cmd, **kwargs):
        class _P:
            returncode = 0
            stdout = "a.txt:1:hello rg tool"
            stderr = ""

        assert cmd[0] == fake_rg
        assert "hello" in cmd or "rg tool" in " ".join(cmd)
        return _P()

    with (
        patch("evoflow.tools.host_direct.rg._find_rg_binary", return_value=fake_rg),
        patch("evoflow.tools.host_direct.rg.subprocess.run", side_effect=_fake_run),
    ):
        out = _run_rg_wallclock(
            pattern="rg tool",
            path=".",
            glob_pattern=None,
            context_before=0,
            context_after=0,
            case_sensitive=False,
            output_mode="content",
            max_results=10,
            runtime=rt,
        )
    assert "hello rg tool" in out
    assert not out.startswith("[rg]")


def test_rg_pipe_keywords_use_fixed_string_not_regex_or(tmp_path: Path):
    pages = tmp_path / "evopanel" / "src" / "pages"
    pages.mkdir(parents=True)
    (pages / "agent-trace-obs-sqlite.js").write_text(
        "import { renderModelResponseTypeCell, summarizeModelResponse } from './agent-trace-model-response.js'\n"
        "const kind = 1\n",
        encoding="utf-8",
    )
    rt = runtime_with_workspace(str(tmp_path), "t-rg-pipe")
    fake_rg = "C:\\fake\\rg.exe"
    calls: list[list[str]] = []

    def _fake_run(cmd, **kwargs):
        calls.append(list(cmd))

        class _P:
            returncode = 0
            stdout = ""
            stderr = ""

        if "-F" in cmd:
            term = cmd[cmd.index("-F") + 1]
            if term == "renderModelResponseTypeCell":
                _P.stdout = "agent-trace-obs-sqlite.js:1:renderModelResponseTypeCell"
        return _P()

    with (
        patch("evoflow.tools.host_direct.rg._find_rg_binary", return_value=fake_rg),
        patch("evoflow.tools.host_direct.rg.subprocess.run", side_effect=_fake_run),
        patch(
            "evoflow.tools.host_direct.search_content._try_index_keyword_redirect",
            return_value=None,
        ),
    ):
        out = _run_rg_wallclock(
            pattern="renderModelResponseTypeCell|summarizeModelResponse|kind",
            path="evopanel/src/pages",
            glob_pattern=None,
            context_before=1,
            context_after=5,
            case_sensitive=False,
            output_mode="content",
            max_results=20,
            runtime=rt,
        )
    assert "[rg → fixed-string]" in out or "[rg -F keywords]" in out
    assert "renderModelResponseTypeCell" in out
    assert calls
    assert all("-F" in c for c in calls)
    assert not any("kind" in c for c in calls)


def test_rg_pipe_keywords_on_single_file_use_fixed_string_not_index(tmp_path: Path):
    fp = tmp_path / "evopanel" / "src" / "pages" / "agent-trace-obs-sqlite.js"
    fp.parent.mkdir(parents=True)
    fp.write_text("renderModelResponseTypeCell\n", encoding="utf-8")
    rt = runtime_with_workspace(str(tmp_path), "t-rg-idx")
    fake_rg = "C:\\fake\\rg.exe"
    calls: list[list[str]] = []

    def _fake_run(cmd, **kwargs):
        calls.append(list(cmd))

        class _P:
            returncode = 0
            stdout = ""
            stderr = ""

        if "-F" in cmd and "renderModelResponseTypeCell" in cmd:
            _P.stdout = "agent-trace-obs-sqlite.js:1:renderModelResponseTypeCell"
        return _P()

    redirect = patch(
        "evoflow.tools.host_direct.search_content._try_index_keyword_redirect",
        side_effect=AssertionError("rg must not redirect to FTS"),
    )
    with (
        redirect,
        patch("evoflow.tools.host_direct.rg._find_rg_binary", return_value=fake_rg),
        patch("evoflow.tools.host_direct.rg.subprocess.run", side_effect=_fake_run),
    ):
        out = _run_rg_wallclock(
            pattern="responseTypeCell|renderModelResponseTypeCell",
            path="evopanel/src/pages/agent-trace-obs-sqlite.js",
            glob_pattern=None,
            context_before=0,
            context_after=0,
            case_sensitive=False,
            output_mode="content",
            max_results=20,
            runtime=rt,
        )
    assert "[rg → code index]" not in out
    assert "renderModelResponseTypeCell" in out
    assert calls
    assert all("-F" in c for c in calls)
