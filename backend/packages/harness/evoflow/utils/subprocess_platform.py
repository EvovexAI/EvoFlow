"""Cross-platform subprocess helpers (Windows console flash mitigation)."""

from __future__ import annotations

import locale
import os
import shutil
import subprocess
from pathlib import Path
from typing import Any

# subprocess.CREATE_NO_WINDOW (Python 3.7+); 0x08000000 on older builds
_CREATE_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)

_POWERSHELL_ARGS = ("-NoProfile", "-WindowStyle", "Hidden", "-NonInteractive", "-Command")

# Force UTF-8 on redirected stdout/stderr (Chinese Windows defaults to cp936 for Write-Output/echo).
_POWERSHELL_UTF8_BOOTSTRAP = (
    "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); "
    "$OutputEncoding = [Console]::OutputEncoding; "
)


def subprocess_text_encoding() -> str:
    """Decode child stdout/stderr.

    On Windows we bootstrap shells to UTF-8 (see ``prepare_shell_command``); override via
    ``EVOFLOW_SUBPROCESS_ENCODING`` when needed.
    """
    override = (os.environ.get("EVOFLOW_SUBPROCESS_ENCODING") or "").strip()
    if override:
        return override
    if os.name == "nt":
        return "utf-8"
    pref = (locale.getpreferredencoding(False) or "").strip()
    return pref or "utf-8"


def subprocess_text_io_kwargs() -> dict[str, Any]:
    """Use with ``text=True`` so ``_readerthread`` never raises ``UnicodeDecodeError``."""
    return {"encoding": subprocess_text_encoding(), "errors": "replace"}


def _shell_basename(shell_executable: str) -> str:
    return os.path.basename(str(shell_executable or "")).lower()


def is_powershell_executable(shell_executable: str) -> bool:
    base = _shell_basename(shell_executable)
    return "powershell" in base or base == "pwsh.exe"


def is_cmd_executable(shell_executable: str) -> bool:
    return _shell_basename(shell_executable) == "cmd.exe"


def prepare_shell_command(command: str, shell_executable: str | None = None) -> str:
    """Prefix Windows shell commands so stdout/stderr are UTF-8 (fixes Chinese mojibake)."""
    cmd = str(command or "").strip()
    if os.name != "nt" or not cmd:
        return cmd
    shell = str(shell_executable or "").strip()
    if is_powershell_executable(shell):
        if "[Console]::OutputEncoding" in cmd:
            return cmd
        return _POWERSHELL_UTF8_BOOTSTRAP + cmd
    if is_cmd_executable(shell):
        if cmd.lower().startswith("chcp "):
            return cmd
        return f"chcp 65001 >nul & {cmd}"
    return cmd


def prepare_shell_env(env: dict[str, str] | None = None) -> dict[str, str]:
    """Child-process env tweaks for consistent text IO."""
    out = dict(env if env is not None else os.environ)
    if os.name == "nt":
        out.setdefault("PYTHONIOENCODING", "utf-8")
    try:
        from evoflow.persistence.runtime_env import apply_runtime_env_to_mapping

        apply_runtime_env_to_mapping(out)
    except Exception:
        pass
    try:
        from evoflow.skills.loader import get_skills_root_path

        out.setdefault("EVOFLOW_SKILLS_PATH", str(get_skills_root_path()))
    except Exception:
        pass
    return out


# Media / skill subprocesses need vendor keys; strip only generic LLM provider keys.
_PRESERVED_API_KEY_PREFIXES = (
    "VOLCENGINE_",
    "ARK_",
    "JIMENG_",
    "SEEDANCE_",
    "DASHSCOPE_",
    "KLING_",
    "AGNES_",
    "ALIYUN_",
    "BYTEPLUS_",
)


def sanitize_child_process_env(env: dict[str, str]) -> dict[str, str]:
    """Drop LLM API keys from child env; re-inject persisted media credentials for skills."""
    for key in list(env.keys()):
        low = key.lower()
        if not any(kw in low for kw in ("key", "token", "secret", "password", "credential", "auth")):
            continue
        if "API_KEY" not in key.upper() and "AUTH_TOKEN" not in key.upper():
            continue
        if any(key.upper().startswith(p) for p in _PRESERVED_API_KEY_PREFIXES):
            continue
        if key in ("HERMES_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_AUTH_TOKEN"):
            env.pop(key, None)
            continue
        if "API_KEY" in key.upper():
            env.pop(key, None)
    try:
        from evoflow.persistence.runtime_env import apply_runtime_env_to_mapping

        apply_runtime_env_to_mapping(env)
    except Exception:
        pass
    return env


def subprocess_hide_window_kwargs() -> dict[str, Any]:
    """Extra kwargs for ``Popen`` / ``run`` / ``asyncio.create_subprocess_exec`` so child shells do not flash a console on Windows."""
    if os.name != "nt":
        return {}
    if _CREATE_NO_WINDOW:
        return {"creationflags": _CREATE_NO_WINDOW}
    si = subprocess.STARTUPINFO()
    si.dwFlags |= subprocess.STARTF_USESHOWWINDOW
    si.wShowWindow = 0  # SW_HIDE
    return {"startupinfo": si}


def resolve_npm_argv(node_path: str | None = None) -> list[str]:
    """Argv prefix to run npm without flashing ``cmd.exe`` on Windows when possible.

    Prefer ``node …/npm-cli.js`` over ``npm.cmd`` (batch files often show a console).
    Falls back to ``npm.exe`` / ``npm.cmd`` / ``npm``; callers must pass
    ``subprocess_hide_window_kwargs()`` to hide the console on Windows.
    """
    node = str(node_path or "").strip()
    if not node:
        node = shutil.which("node") or ""
    if node:
        node_dir = Path(node).resolve().parent
        for candidate in (
            node_dir / "node_modules" / "npm" / "bin" / "npm-cli.js",
            node_dir.parent / "lib" / "node_modules" / "npm" / "bin" / "npm-cli.js",
        ):
            try:
                if candidate.is_file():
                    return [node, str(candidate)]
            except OSError:
                continue
    if os.name == "nt":
        npm = shutil.which("npm.exe") or shutil.which("npm.cmd") or shutil.which("npm") or ""
    else:
        npm = shutil.which("npm") or ""
    return [npm] if npm else []


def detect_shell() -> tuple[str, list[str], bool]:
    """Pick host shell. Returns ``(executable, prefix_args, use_shell_bool)``."""
    if os.name == "nt":
        for candidate in ("pwsh.exe", "powershell.exe", "cmd.exe"):
            full = shutil.which(candidate)
            if full:
                if "powershell" in candidate.lower():
                    return full, list(_POWERSHELL_ARGS), False
                if candidate == "cmd.exe":
                    return full, ["/c"], False
        raise RuntimeError("No shell found on Windows")
    for candidate in ("/bin/bash", "/bin/zsh", "/bin/sh"):
        if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate, [], True
    raise RuntimeError("No shell found")
