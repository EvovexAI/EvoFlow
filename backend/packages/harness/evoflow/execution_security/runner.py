"""Run a command under OS sandbox helpers (or host passthrough).

Helpers are EvoFlow-owned entrypoints (or thin wrappers built from Apache-2.0
sandbox crates). runtime CLI is not a product dependency.
"""

from __future__ import annotations

import logging
import os
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Mapping, Sequence

from evoflow.execution_security.config import (
    ExecutionSecurityConfig,
    get_execution_security_config,
    is_execution_security_active,
    resolved_profile_id,
)
from evoflow.execution_security.errors import HelperUnavailable, SandboxDenied
from evoflow.execution_security.helpers import HelperPaths, discover_helpers
from evoflow.execution_security.profiles import permission_profile_to_json_str
from evoflow.utils.subprocess_platform import (
    detect_shell,
    prepare_shell_command,
    prepare_shell_env,
    sanitize_child_process_env,
    subprocess_hide_window_kwargs,
    subprocess_text_io_kwargs,
)

logger = logging.getLogger(__name__)


@dataclass
class SandboxRunResult:
    stdout: str
    stderr: str
    exit_code: int
    mode: str  # "sandboxed" | "passthrough"
    argv: list[str] = field(default_factory=list)

    @property
    def success(self) -> bool:
        return self.exit_code == 0


def build_shell_argv(command: str) -> list[str]:
    """Turn a terminal command string into an explicit argv (no ``shell=True``)."""
    shell_cmd, shell_args, use_shell = detect_shell()
    prepared = prepare_shell_command(
        command,
        shell_cmd if not use_shell else (shell_cmd or "/bin/sh"),
    )
    if use_shell:
        exe = shell_cmd or "/bin/sh"
        return [exe, "-c", prepared]
    return [shell_cmd, *list(shell_args), prepared]


def _linux_wrapper_argv(
    *,
    helper: Path,
    command: Sequence[str],
    command_cwd: Path,
    policy_cwd: Path,
    profile_json: str,
) -> list[str]:
    return [
        str(helper),
        "--sandbox-policy-cwd",
        str(policy_cwd),
        "--command-cwd",
        str(command_cwd),
        "--permission-profile",
        profile_json,
        "--",
        *list(command),
    ]


def _windows_wrapper_argv(
    *,
    helper: Path,
    command: Sequence[str],
    command_cwd: Path,
    workspace_root: Path,
    profile_json: str,
    env: Mapping[str, str],
    windows_level: str,
    sandbox_home: Path,
) -> list[str]:
    """Windows restricted-token / elevated entry.

    Flag names match the open-source windows-sandbox crate CLI shape —
    not a product link to runtime CLI.
    """
    import json

    env_json = json.dumps(dict(env), separators=(",", ":"))
    return [
        str(helper),
        "--run-as-windows-sandbox",
        "--codex-home",
        str(sandbox_home),
        "--command-cwd",
        str(command_cwd),
        "--permission-profile",
        profile_json,
        "--env-json",
        env_json,
        "--windows-sandbox-level",
        windows_level,
        "--workspace-root",
        str(workspace_root),
        "--",
        *list(command),
    ]


def wrap_argv_for_sandbox(
    command: Sequence[str],
    *,
    command_cwd: Path,
    policy_cwd: Path | None = None,
    profile: str | None = None,
    env: Mapping[str, str] | None = None,
    cfg: ExecutionSecurityConfig | None = None,
    helpers: HelperPaths | None = None,
) -> tuple[list[str], str]:
    """Return ``(argv, mode)`` where mode is ``sandboxed`` or ``passthrough``."""
    config = cfg or get_execution_security_config()
    argv = [str(x) for x in command]
    if not is_execution_security_active(config):
        return argv, "passthrough"

    paths = helpers or discover_helpers(helper_dir=config.helper_dir)
    if not paths.platform_ready:
        if config.allow_passthrough:
            logger.debug(
                "execution_security: helpers unavailable on %s — passthrough",
                sys.platform,
            )
            return argv, "passthrough"
        raise HelperUnavailable(
            f"OS sandbox helper not found for platform {sys.platform}. "
            "Set EVOFLOW_SANDBOX_HELPER_DIR or build evoflow-*-sandbox helpers "
            "(see evoflow.execution_security.helpers)."
        )

    policy_root = Path(policy_cwd or command_cwd).resolve()
    cmd_cwd = Path(command_cwd).resolve()
    profile_id = profile or resolved_profile_id(config)
    profile_json = permission_profile_to_json_str(profile_id)
    child_env = dict(env if env is not None else os.environ)

    if sys.platform.startswith("linux") and paths.linux_sandbox:
        return (
            _linux_wrapper_argv(
                helper=paths.linux_sandbox,
                command=argv,
                command_cwd=cmd_cwd,
                policy_cwd=policy_root,
                profile_json=profile_json,
            ),
            "sandboxed",
        )

    if sys.platform == "win32" and paths.windows_sandbox:
        home = Path(
            os.environ.get("EVOFLOW_SANDBOX_HOME")
            or os.environ.get("EVOFLOW_HOME")
            or (Path.home() / ".evoflow")
        )
        home.mkdir(parents=True, exist_ok=True)
        return (
            _windows_wrapper_argv(
                helper=paths.windows_sandbox,
                command=argv,
                command_cwd=cmd_cwd,
                workspace_root=policy_root,
                profile_json=profile_json,
                env=child_env,
                windows_level=config.windows_level,
                sandbox_home=home,
            ),
            "sandboxed",
        )

    if config.allow_passthrough:
        return argv, "passthrough"
    raise HelperUnavailable(f"No sandbox wrapper for platform {sys.platform}")


def run_sandboxed(
    command: str | Sequence[str],
    *,
    cwd: Path | str | None = None,
    timeout: float | None = None,
    env: Mapping[str, str] | None = None,
    profile: str | None = None,
    policy_cwd: Path | str | None = None,
    cfg: ExecutionSecurityConfig | None = None,
) -> SandboxRunResult:
    """Execute *command* under the sandbox when enabled."""
    config = cfg or get_execution_security_config()
    workdir = Path(cwd).resolve() if cwd else Path.cwd()
    policy = Path(policy_cwd).resolve() if policy_cwd else workdir

    if isinstance(command, str):
        base_argv = build_shell_argv(command)
    else:
        base_argv = [str(x) for x in command]

    child_env = sanitize_child_process_env(
        prepare_shell_env(dict(env) if env is not None else os.environ.copy())
    )

    argv, mode = wrap_argv_for_sandbox(
        base_argv,
        command_cwd=workdir,
        policy_cwd=policy,
        profile=profile,
        env=child_env,
        cfg=config,
    )

    run_kw = {**subprocess_hide_window_kwargs(), **subprocess_text_io_kwargs()}
    try:
        proc = subprocess.run(
            argv,
            capture_output=True,
            text=True,
            timeout=timeout,
            cwd=str(workdir),
            env=child_env,
            **run_kw,
        )
    except FileNotFoundError as e:
        raise HelperUnavailable(str(e)) from e
    except subprocess.TimeoutExpired:
        return SandboxRunResult(
            stdout="",
            stderr=f"Error: Command timed out after {timeout} seconds",
            exit_code=-1,
            mode=mode,
            argv=argv,
        )

    stdout = proc.stdout or ""
    stderr = proc.stderr or ""
    code = int(proc.returncode if proc.returncode is not None else 0)

    if mode == "sandboxed" and code != 0 and _looks_like_helper_failure(stderr, stdout):
        raise SandboxDenied(stderr.strip() or stdout.strip() or f"sandbox exit {code}")

    return SandboxRunResult(
        stdout=stdout,
        stderr=stderr,
        exit_code=code,
        mode=mode,
        argv=argv,
    )


def _looks_like_helper_failure(stderr: str, stdout: str) -> bool:
    blob = f"{stderr}\n{stdout}".lower()
    if "windows sandbox failed:" in blob or "invalid windows sandbox level" in blob:
        return True
    if "failed to parse permission profile" in blob:
        return True
    if "sandbox-exec: sandbox_apply" in blob or "landlock" in blob or "seatbelt" in blob:
        return True
    if "linux-sandbox" in blob and "missing" in blob:
        return True
    return False
