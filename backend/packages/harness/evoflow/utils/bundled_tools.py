"""Resolve bundled CLI tools shipped next to the frozen gateway or under packaging/."""

from __future__ import annotations

import platform
import sys
import threading
from pathlib import Path


_chromium_install_lock = threading.Lock()

def _backend_dir_from_harness() -> Path | None:
    here = Path(__file__).resolve()
    # .../backend/packages/harness/evoflow/utils/bundled_tools.py
    try:
        backend_dir = here.parents[4]
    except IndexError:
        return None
    if (backend_dir / "packages" / "harness").is_dir():
        return backend_dir
    return None


def _platform_rg_subdir() -> str:
    if sys.platform == "win32":
        return "win-x64"
    if sys.platform == "darwin":
        machine = platform.machine().lower()
        if machine in ("arm64", "aarch64"):
            return "macos-arm64"
        return "macos-x64"
    return "linux-x64"


def _rg_candidate_names() -> tuple[str, ...]:
    if sys.platform == "win32":
        return ("rg.exe", "rg")
    return ("rg",)


def bundled_ripgrep_binary() -> str | None:
    """Return path to bundled ``rg`` when present (frozen install or dev packaging bundle)."""
    names = _rg_candidate_names()

    if getattr(sys, "frozen", False):
        exe_dir = Path(sys.executable).resolve().parent
        for name in names:
            candidate = exe_dir / "tools" / "ripgrep" / name
            if candidate.is_file():
                return str(candidate)

    backend_dir = _backend_dir_from_harness()
    if backend_dir is not None:
        subdir = backend_dir / "packaging" / "ripgrep-bundle" / _platform_rg_subdir()
        for name in names:
            candidate = subdir / name
            if candidate.is_file():
                return str(candidate)

    return None


def _evoflow_cli_script_names() -> tuple[str, ...]:
    if sys.platform == "win32":
        return ("evoflow.cmd", "evoflow.exe", "evoflow")
    return ("evoflow", "evoflow.sh")


def _venv_scripts_dir(backend_dir: Path) -> Path | None:

    rel = "Scripts" if sys.platform == "win32" else "bin"
    scripts = backend_dir / ".venv" / rel
    if not scripts.is_dir():
        return None
    for name in _evoflow_cli_script_names():
        if (scripts / name).exists():
            return scripts
    return None


def evoflow_cli_search_dirs() -> list[str]:
    """Directories that may contain an ``evoflow`` executable (first match wins)."""
    dirs: list[Path] = []

    if getattr(sys, "frozen", False):
        exe_dir = Path(sys.executable).resolve().parent
        bundled = exe_dir / "tools" / "evoflow"
        if bundled.is_dir():
            dirs.append(bundled)

    py = Path(sys.executable).resolve()
    if py.parent.is_dir():
        dirs.append(py.parent)

    backend_dir = _backend_dir_from_harness()
    if backend_dir is not None:
        scripts = _venv_scripts_dir(backend_dir)
        if scripts is not None:
            dirs.append(scripts)

    out: list[str] = []
    seen: set[str] = set()
    for d in dirs:
        key = str(d.resolve())
        if key in seen:
            continue
        seen.add(key)
        out.append(key)
    return out


def apply_evoflow_cli_to_path() -> None:
    """Prepend ``evoflow`` CLI directory to ``PATH`` for terminal subprocesses."""
    import os

    dirs = evoflow_cli_search_dirs()
    if not dirs:
        return
    existing = os.environ.get("PATH", "")
    parts = [p for p in existing.split(os.pathsep) if p]
    prefix: list[str] = []
    for d in dirs:
        if d not in parts and d not in prefix:
            prefix.append(d)
    if not prefix:
        return
    os.environ["PATH"] = os.pathsep.join([*prefix, *parts])
    os.environ.setdefault("EVOFLOW_CLI_DIR", prefix[0])


def gateway_cli_argv(extra: list[str] | None = None) -> list[str]:
    """Argv to invoke admin CLI (frozen gateway --mode cli, or dev venv evoflow.exe)."""
    if getattr(sys, "frozen", False):
        argv: list[str] = [str(Path(sys.executable).resolve()), "--mode", "cli"]
    else:
        scripts = Path(sys.executable).resolve().parent
        names = _evoflow_cli_script_names()
        exe: Path | None = None
        for name in names:
            candidate = scripts / name
            if candidate.is_file():
                exe = candidate
                break
        if exe is not None:
            argv = [str(exe)]
        else:
            argv = [str(Path(sys.executable).resolve()), "-m", "evoflow.cli.main"]
    if extra:
        argv.extend(extra)
    return argv


def _agent_browser_cli_names() -> tuple[str, ...]:
    if sys.platform == "win32":
        return ("agent-browser.cmd", "agent-browser.exe", "agent-browser")
    return ("agent-browser",)


def agent_browser_bundle_roots() -> list[Path]:
    """Known roots that may contain bundled agent-browser (frozen or dev packaging)."""
    roots: list[Path] = []
    seen: set[str] = set()

    def _push(path: Path) -> None:
        key = str(path.resolve())
        if key in seen:
            return
        seen.add(key)
        roots.append(path)

    if getattr(sys, "frozen", False):
        exe_dir = Path(sys.executable).resolve().parent
        _push(exe_dir / "tools" / "agent-browser")

    backend_dir = _backend_dir_from_harness()
    if backend_dir is not None:
        _push(backend_dir / "packaging" / "agent-browser-bundle")

    override = str(__import__("os").environ.get("EVOFLOW_AGENT_BROWSER_ROOT", "")).strip()
    if override:
        _push(Path(override))
    return roots


def find_bundled_chrome_executable(ab_root: Path) -> str | None:
    browsers = ab_root / "browsers"
    if not browsers.is_dir():
        return None
    chrome_names = ("chrome.exe", "chrome")
    for ver_dir in sorted(browsers.glob("chrome-*"), reverse=True):
        for name in chrome_names:
            candidate = ver_dir / name
            if candidate.is_file():
                return str(candidate)
    return None


def _user_agent_browser_roots() -> list[Path]:
    """User-level Chromium caches written by ``agent-browser install``."""
    import os

    roots: list[Path] = []
    home = Path.home()
    roots.append(home / ".agent-browser" / "browsers")
    # Windows / macOS / Linux app-data style caches (future-proof).
    local_app = os.environ.get("LOCALAPPDATA") or os.environ.get("XDG_CACHE_HOME")
    if local_app:
        roots.append(Path(local_app) / "EvoFlow" / "browsers")
        roots.append(Path(local_app) / "agent-browser" / "browsers")
    return roots


def find_chrome_executable() -> str | None:
    """Resolve Chromium for agent-browser (env override → bundle → user cache)."""
    import os

    override = str(os.environ.get("AGENT_BROWSER_EXECUTABLE_PATH", "")).strip()
    if override and Path(override).is_file():
        return override

    for root in agent_browser_bundle_roots():
        chrome = find_bundled_chrome_executable(root)
        if chrome:
            return chrome

    chrome_names = ("chrome.exe", "chrome")
    for browsers in _user_agent_browser_roots():
        if not browsers.is_dir():
            continue
        for ver_dir in sorted(browsers.glob("chrome-*"), reverse=True):
            for name in chrome_names:
                candidate = ver_dir / name
                if candidate.is_file():
                    return str(candidate)
    return None


def ensure_agent_browser_chromium(*, timeout: int = 900) -> tuple[bool, str]:
    """Install Chromium via ``agent-browser install`` when missing.

    Not called automatically by the browser tool (silent install is brittle).
    Available for explicit maintainer / agent-driven install flows.
    """
    import logging
    import os
    import subprocess

    from evoflow.utils.subprocess_platform import (
        subprocess_hide_window_kwargs,
        subprocess_text_io_kwargs,
    )

    logger = logging.getLogger(__name__)

    existing = find_chrome_executable()
    if existing:
        os.environ.setdefault("AGENT_BROWSER_EXECUTABLE_PATH", existing)
        return True, existing

    cli = bundled_agent_browser_cli()
    if not cli:
        return (
            False,
            "agent-browser CLI not found. Dev: run `make setup-agent-browser` "
            "from repo root, or: npm install -g agent-browser && agent-browser install",
        )

    with _chromium_install_lock:
        existing = find_chrome_executable()
        if existing:
            os.environ.setdefault("AGENT_BROWSER_EXECUTABLE_PATH", existing)
            return True, existing

        apply_agent_browser_to_path()
        logger.info(
            "Chromium missing — running `agent-browser install` (first use, ~400MB)..."
        )
        try:
            proc = subprocess.run(
                [cli, "install"],
                capture_output=True,
                timeout=max(60, int(timeout)),
                env=dict(os.environ),
                **subprocess_hide_window_kwargs(),
                **subprocess_text_io_kwargs(),
            )
        except subprocess.TimeoutExpired:
            return (
                False,
                "浏览器引擎下载超时。请检查网络后重试，或在终端执行："
                "agent-browser install",
            )
        except Exception as exc:
            return False, f"浏览器引擎安装失败: {exc}"

        if proc.returncode != 0:
            detail = (proc.stderr or proc.stdout or "").strip() or f"exit {proc.returncode}"
            return (
                False,
                f"浏览器引擎安装失败（需联网，约 400MB）: {detail}",
            )

        chrome = find_chrome_executable()
        if not chrome:
            return (
                False,
                "agent-browser install 已完成但未找到 chrome 可执行文件。"
                "请检查 ~/.agent-browser/browsers 后重试。",
            )
        os.environ["AGENT_BROWSER_EXECUTABLE_PATH"] = chrome
        logger.info("Chromium ready at %s", chrome)
        return True, chrome


def bundled_agent_browser_cli() -> str | None:
    """Return path to bundled or PATH-resolved agent-browser CLI."""
    import os
    import shutil

    override = str(os.environ.get("EVOFLOW_AGENT_BROWSER_CLI", "")).strip()
    if override and Path(override).is_file():
        return override

    exe = shutil.which("agent-browser")
    if exe:
        return exe

    names = _agent_browser_cli_names()
    for root in agent_browser_bundle_roots():
        for folder in (root / "node_modules" / ".bin", root / "bin"):
            if not folder.is_dir():
                continue
            for name in names:
                candidate = folder / name
                if candidate.is_file():
                    return str(candidate)
    return None


def apply_agent_browser_to_path() -> None:
    """Prepend bundled agent-browser CLI dir and Chromium path for subprocesses."""
    import os

    cli = bundled_agent_browser_cli()
    if not cli:
        return
    bin_dir = str(Path(cli).resolve().parent)
    existing = os.environ.get("PATH", "")
    parts = [p for p in existing.split(os.pathsep) if p]
    if bin_dir not in parts:
        os.environ["PATH"] = os.pathsep.join([bin_dir, *parts])

    if os.environ.get("AGENT_BROWSER_EXECUTABLE_PATH", "").strip():
        return
    chrome = find_chrome_executable()
    if chrome:
        os.environ.setdefault("AGENT_BROWSER_EXECUTABLE_PATH", chrome)
