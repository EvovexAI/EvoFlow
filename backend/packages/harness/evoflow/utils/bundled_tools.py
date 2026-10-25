"""Resolve bundled CLI tools shipped next to the frozen gateway or under packaging/."""

from __future__ import annotations

import os
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


def _env_binary(keys: tuple[str, ...]) -> str | None:
    for key in keys:
        raw_s = os.environ.get(key)
        if not raw_s:
            continue
        raw = Path(raw_s).expanduser()
        if raw.is_file():
            return str(raw.resolve())
    return None


def _frozen_tool_binary(tool_dir: str, names: tuple[str, ...]) -> str | None:
    if not getattr(sys, "frozen", False):
        return None
    exe_dir = Path(sys.executable).resolve().parent
    for name in names:
        candidate = exe_dir / "tools" / tool_dir / name
        if candidate.is_file():
            return str(candidate)
    return None


def _packaging_tool_binary(bundle_name: str, names: tuple[str, ...]) -> str | None:
    backend_dir = _backend_dir_from_harness()
    if backend_dir is None:
        return None
    subdir = backend_dir / "packaging" / bundle_name / _platform_rg_subdir()
    for name in names:
        candidate = subdir / name
        if candidate.is_file():
            return str(candidate)
    return None


def bundled_ripgrep_binary() -> str | None:
    """Return path to bundled ``rg`` when present (frozen install or dev packaging bundle)."""
    names = _rg_candidate_names()
    return (
        _env_binary(("EVOFLOW_RG_BINARY", "ZCODE_RG_BINARY"))
        or _frozen_tool_binary("ripgrep", names)
        or _packaging_tool_binary("ripgrep-bundle", names)
    )


def bundled_bfs_binary() -> str | None:
    """ZCode runtime tool ``bfs`` (find replacement). Windows often has none — callers skip wrap."""
    names = ("bfs.exe", "bfs") if sys.platform == "win32" else ("bfs",)
    return (
        _env_binary(("EVOFLOW_BFS_BINARY", "ZCODE_BFS_BINARY"))
        or _frozen_tool_binary("bfs", names)
        or _packaging_tool_binary("bfs-bundle", names)
    )


def bundled_ugrep_binary() -> str | None:
    """ZCode runtime tool ``ugrep`` (grep replacement)."""
    names = ("ugrep.exe", "ugrep") if sys.platform == "win32" else ("ugrep",)
    return (
        _env_binary(("EVOFLOW_UGREP_BINARY", "ZCODE_UGREP_BINARY"))
        or _frozen_tool_binary("ugrep", names)
        or _packaging_tool_binary("ugrep-bundle", names)
    )


def to_bash_posix_path(path: str) -> str:
    """Convert a Windows path to a Git-Bash-style POSIX path for `-lc` scripts."""
    posix = str(path or "").replace("\\", "/")
    if len(posix) > 1 and posix[1] == ":":
        return f"/{posix[0].lower()}{posix[2:]}"
    return posix


def from_bash_posix_path(path: str) -> str:
    """Convert Git Bash ``/d/foo`` or WSL ``/mnt/d/foo`` to ``D:/foo`` on Windows.

    Leaves non-Windows paths, virtual mounts (``/mnt/user-data``, ``/mnt/skills``, …),
    and ordinary POSIX paths (``/dev/...``, ``/usr/...``) unchanged.

    Without this, ``Path("/d/dev/...").resolve()`` on win32 becomes ``D:\\d\\dev\\...``
    (ghost tree) and file tools report OK while writing outside the real workspace.
    """
    raw = str(path or "")
    if sys.platform != "win32" or not raw:
        return raw
    norm = raw.replace("\\", "/")
    # WSL: /mnt/<drive>/...  (single-letter drive only; not /mnt/user-data)
    if len(norm) >= 6 and norm.startswith("/mnt/"):
        drive = norm[5]
        if drive.isalpha() and (len(norm) == 6 or norm[6] == "/"):
            rest = norm[6:] or "/"
            return f"{drive.upper()}:{rest}"
    # Git Bash: /<drive>/...  (single-letter drive; /dev/... must not match)
    if len(norm) >= 2 and norm[0] == "/" and norm[1].isalpha() and (len(norm) == 2 or norm[2] == "/"):
        drive = norm[1]
        rest = norm[2:] or "/"
        return f"{drive.upper()}:{rest}"
    return raw


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
