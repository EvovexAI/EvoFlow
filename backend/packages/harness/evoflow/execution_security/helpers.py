"""Discover OS sandbox helper binaries for the current platform.

EvoFlow does **not** depend on runtime CLI as a product upstream.

We optionally reuse Apache-2.0 sandbox *crates* (linux-sandbox / windows-sandbox)
as a build source for thin helpers. Preferred runtime names:

  - ``evoflow-linux-sandbox``
  - ``evoflow-windows-sandbox.exe``

Legacy helper filenames from older local builds are still recognized
for local/dev testing only.

macOS: system ``sandbox-exec`` + Seatbelt policy (crate embed TBD) — passthrough until then.
"""

from __future__ import annotations

import os
import shutil
import sys
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class HelperPaths:
    """Resolved helper locations (any field may be None)."""

    linux_sandbox: Path | None = None
    # Windows jail entrypoint (prefer evoflow-windows-sandbox.exe).
    windows_sandbox: Path | None = None
    seatbelt_exec: Path | None = None
    helper_dir: Path | None = None

    @property
    def windows_helper(self) -> Path | None:
        return self.windows_sandbox

    @property
    def codex_exe(self) -> Path | None:
        """Deprecated alias — use :attr:`windows_sandbox`."""
        return self.windows_sandbox

    @property
    def platform_ready(self) -> bool:
        if sys.platform.startswith("linux"):
            return self.linux_sandbox is not None and self.linux_sandbox.is_file()
        if sys.platform == "darwin":
            return False
        if sys.platform == "win32":
            return self.windows_sandbox is not None and self.windows_sandbox.is_file()
        return False


def _is_exe(path: Path | None) -> bool:
    if path is None:
        return False
    try:
        return path.is_file() and (os.access(path, os.X_OK) or sys.platform == "win32")
    except OSError:
        return False


def _candidate_dirs(helper_dir: str | Path | None) -> list[Path]:
    out: list[Path] = []
    seen: set[str] = set()

    def add(p: Path | None) -> None:
        if p is None:
            return
        try:
            key = str(p.resolve())
        except OSError:
            key = str(p)
        if key in seen:
            return
        seen.add(key)
        out.append(p)

    env_dir = (os.environ.get("EVOFLOW_SANDBOX_HELPER_DIR") or "").strip()
    if env_dir:
        add(Path(env_dir))
    if helper_dir:
        add(Path(helper_dir))

    add(Path.home() / ".evoflow" / "sandbox-helpers")

    try:
        from evoflow.config.paths import get_paths

        base = get_paths().base_dir
        add(base / "sandbox-helpers")
        add(base / "binaries" / "sandbox-helpers")
    except Exception:
        pass

    try:
        import sys as _sys

        if getattr(_sys, "frozen", False):
            add(Path(_sys.executable).resolve().parent / "sandbox-helpers")
            add(Path(_sys.executable).resolve().parent / "binaries" / "sandbox-helpers")
    except Exception:
        pass

    # Dev: optional crate checkout next to the repo (build source only).
    here = Path(__file__).resolve()
    for up in range(3, 9):
        root = here.parents[up] if up < len(here.parents) else None
        if root is None:
            break
        add(root / "codex" / "codex-rs" / "target" / "release")
        add(root.parent / "codex" / "codex-rs" / "target" / "release")
        add(root / "evopanel" / "src-tauri" / "binaries" / "sandbox-helpers")

    return out


def _which_named(names: list[str]) -> Path | None:
    for name in names:
        found = shutil.which(name)
        if found:
            p = Path(found)
            if _is_exe(p):
                return p
    return None


def discover_helpers(*, helper_dir: str | Path | None = None) -> HelperPaths:
    """Locate platform helpers; never raises."""
    linux: Path | None = None
    windows: Path | None = None
    seatbelt: Path | None = None

    env_linux = (
        os.environ.get("EVOFLOW_LINUX_SANDBOX") or os.environ.get("EVOFLOW_CODEX_LINUX_SANDBOX") or ""
    ).strip()
    if env_linux and _is_exe(Path(env_linux)):
        linux = Path(env_linux)

    env_win = (
        os.environ.get("EVOFLOW_WINDOWS_SANDBOX") or os.environ.get("EVOFLOW_CODEX_EXE") or ""
    ).strip()
    if env_win and _is_exe(Path(env_win)):
        windows = Path(env_win)

    dirs = _candidate_dirs(helper_dir)
    resolved_dir: Path | None = Path(helper_dir) if helper_dir else None
    if resolved_dir is None and dirs:
        resolved_dir = dirs[0]

    linux_names = (
        "evoflow-linux-sandbox",
        "codex-linux-sandbox",
        "codex-linux-sandbox.exe",
    )
    windows_names = (
        "evoflow-windows-sandbox.exe",
        "evoflow-windows-sandbox",
        "codex.exe",
        "codex",
    )

    for d in dirs:
        if linux is None:
            for name in linux_names:
                cand = d / name
                if _is_exe(cand):
                    linux = cand
                    break
        if windows is None:
            for name in windows_names:
                cand = d / name
                if _is_exe(cand):
                    windows = cand
                    break

    if linux is None:
        linux = _which_named(["evoflow-linux-sandbox", "codex-linux-sandbox"])
    if windows is None:
        windows = _which_named(
            ["evoflow-windows-sandbox", "evoflow-windows-sandbox.exe", "codex", "codex.exe"]
        )

    if sys.platform == "darwin":
        seatbelt_path = Path("/usr/bin/sandbox-exec")
        if _is_exe(seatbelt_path):
            seatbelt = seatbelt_path

    return HelperPaths(
        linux_sandbox=linux,
        windows_sandbox=windows,
        seatbelt_exec=seatbelt,
        helper_dir=resolved_dir,
    )
