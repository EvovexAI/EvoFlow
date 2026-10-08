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
