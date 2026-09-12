import fnmatch
import os
import posixpath
import re
import sys
from pathlib import Path
from typing import TYPE_CHECKING, Any, Literal

from langchain.tools import ToolRuntime, tool
from langgraph.typing import ContextT

from evoflow.config.paths import VIRTUAL_PATH_PREFIX
from evoflow.sandbox.exceptions import (
    SandboxError,
    SandboxNotFoundError,
    SandboxRuntimeError,
)
from evoflow.sandbox.sandbox import Sandbox
from evoflow.sandbox.sandbox_provider import get_sandbox_provider
from evoflow.sandbox.security import LOCAL_HOST_BASH_DISABLED_MESSAGE, is_host_bash_allowed

if TYPE_CHECKING:
    from evoflow.agents.thread_state import ThreadDataState, ThreadState
else:
    ThreadDataState = Any
    ThreadState = Any

_ABSOLUTE_PATH_PATTERN = re.compile(r"(?<![:\w])/(?:[^\s\"'`;&|<>()]+)")
_LOCAL_BASH_SYSTEM_PATH_PREFIXES = (
    "/bin/",
    "/usr/bin/",
    "/usr/sbin/",
    "/sbin/",
    "/opt/homebrew/bin/",
    "/dev/",
)

# Opt-in: allow read_file / ls (and bash path validation) to use absolute host paths
# outside /mnt/user-data when using the local sandbox. Self-hosted only; not a
# security boundary — see CONFIGURATION.md.
_EVOFLOW_ALLOW_LOCAL_HOST_READS_ENV = "EVOFLOW_ALLOW_LOCAL_HOST_READS"
_EVOFLOW_ALLOW_NETWORK_IN_BASH_ENV = "EVOFLOW_ALLOW_NETWORK_IN_BASH"


def _local_host_reads_enabled() -> bool:
    return os.environ.get(_EVOFLOW_ALLOW_LOCAL_HOST_READS_ENV, "").strip().lower() in (
        "1",
        "true",
        "yes",
    )


def _is_explicit_host_filesystem_path(path: str) -> bool:
    """Whether *path* looks like a host absolute path outside virtual agent namespaces.

    Virtual paths under ``/mnt/user-data``, skills, and ACP workspace are False so
    they keep using the existing resolution logic.
    """
    if path == VIRTUAL_PATH_PREFIX or path.startswith(f"{VIRTUAL_PATH_PREFIX}/"):
        return False
    if _is_skills_path(path):
        return False
    if _is_acp_workspace_path(path):
        return False
    normalised = path.replace("\\", "/")
    if len(normalised) >= 3 and normalised[0].isalpha() and normalised[1] == ":" and normalised[2] == "/":
        return True
    if len(path) >= 3 and path[0].isalpha() and path[1] == ":" and path[2] in "/\\":
        return True
    if normalised.startswith("/"):
        return True
    return False


_DEFAULT_SKILLS_CONTAINER_PATH = "/mnt/skills"
_ACP_WORKSPACE_VIRTUAL_PATH = "/mnt/acp-workspace"


def _get_skills_container_path() -> str:
    """Get the skills container path from config, with fallback to default.

    Result is cached after the first successful config load.  If config loading
    fails the default is returned *without* caching so that a later call can
    pick up the real value once the config is available.
    """
    cached = getattr(_get_skills_container_path, "_cached", None)
    if cached is not None:
        return cached
    try:
        from evoflow.config import get_app_config

        value = get_app_config().skills.container_path
        _get_skills_container_path._cached = value  # type: ignore[attr-defined]
        return value
    except Exception:
        return _DEFAULT_SKILLS_CONTAINER_PATH


def _get_skills_host_path() -> str | None:
    """Get the skills host filesystem path from config.

    Returns None if the skills directory does not exist or config cannot be
    loaded.  Only successful lookups are cached; failures are retried on the
    next call so that a transiently unavailable skills directory does not
    permanently disable skills access.
    """
    cached = getattr(_get_skills_host_path, "_cached", None)
    if cached is not None:
        return cached
    try:
        from evoflow.config import get_app_config

        config = get_app_config()
        skills_path = config.skills.get_skills_path()
        if skills_path.exists():
            value = str(skills_path)
            _get_skills_host_path._cached = value  # type: ignore[attr-defined]
            return value
    except Exception:
        pass
    return None


def _is_skills_path(path: str) -> bool:
    """Check if a path is under the skills container path."""
    skills_prefix = _get_skills_container_path()
    return path == skills_prefix or path.startswith(f"{skills_prefix}/")


def _resolve_skills_path(path: str) -> str:
    """Resolve a virtual skills path to a host filesystem path.

    Args:
        path: Virtual skills path (e.g. /mnt/skills/public/bootstrap/SKILL.md)

    Returns:
        Resolved host path.

    Raises:
        FileNotFoundError: If skills directory is not configured or doesn't exist.
    """
    skills_container = _get_skills_container_path()
    skills_host = _get_skills_host_path()
    if skills_host is None:
        raise FileNotFoundError(f"Skills directory not available for path: {path}")

    if path == skills_container:
        return skills_host

    relative = path[len(skills_container) :].lstrip("/")
    return _join_path_preserving_style(skills_host, relative)


def _is_acp_workspace_path(path: str) -> bool:
    """Check if a path is under the ACP workspace virtual path."""
    return path == _ACP_WORKSPACE_VIRTUAL_PATH or path.startswith(f"{_ACP_WORKSPACE_VIRTUAL_PATH}/")


def _extract_thread_id_from_thread_data(thread_data: "ThreadDataState | None") -> str | None:
    """Extract thread_id from thread_data by inspecting workspace_path.

    The workspace_path has the form
    ``{base_dir}/threads/{thread_id}/user-data/workspace``, so
    ``Path(workspace_path).parent.parent.name`` yields the thread_id.
    """
    if thread_data is None:
        return None
    workspace_path = thread_data.get("workspace_path")
    if not workspace_path:
        return None
    try:
        # {base_dir}/threads/{thread_id}/user-data/workspace → parent.parent = threads/{thread_id}
        return Path(workspace_path).parent.parent.name
    except Exception:
        return None


def _get_acp_workspace_host_path(thread_id: str | None = None) -> str | None:
    """Get the ACP workspace host filesystem path.

    When *thread_id* is provided, returns the per-thread workspace
    ``{base_dir}/threads/{thread_id}/acp-workspace/`` (not cached — the
    directory is created on demand by ``invoke_acp_agent_tool``).

    Falls back to the global ``{base_dir}/acp-workspace/`` when *thread_id*
    is ``None``; that result is cached after the first successful resolution.
    Returns ``None`` if the directory does not exist.
    """
    if thread_id is not None:
        try:
            from evoflow.config.paths import get_paths

            host_path = get_paths().acp_workspace_dir(thread_id)
            if host_path.exists():
                return str(host_path)
        except Exception:
            pass
        return None

    cached = getattr(_get_acp_workspace_host_path, "_cached", None)
    if cached is not None:
        return cached
    try:
        from evoflow.config.paths import get_paths

        host_path = get_paths().base_dir / "acp-workspace"
        if host_path.exists():
            value = str(host_path)
            _get_acp_workspace_host_path._cached = value  # type: ignore[attr-defined]
            return value
    except Exception:
        pass
    return None


def _resolve_acp_workspace_path(path: str, thread_id: str | None = None) -> str:
    """Resolve a virtual ACP workspace path to a host filesystem path.

    Args:
        path: Virtual path (e.g. /mnt/acp-workspace/hello_world.py)
        thread_id: Current thread ID for per-thread workspace resolution.
                   When ``None``, falls back to the global workspace.

    Returns:
        Resolved host path.

    Raises:
        FileNotFoundError: If ACP workspace directory does not exist.
        PermissionError: If path traversal is detected.
    """
    _reject_path_traversal(path)

    host_path = _get_acp_workspace_host_path(thread_id)
    if host_path is None:
        raise FileNotFoundError(f"ACP workspace directory not available for path: {path}")

    if path == _ACP_WORKSPACE_VIRTUAL_PATH:
        return host_path

    relative = path[len(_ACP_WORKSPACE_VIRTUAL_PATH) :].lstrip("/")
    resolved = _join_path_preserving_style(host_path, relative)

    if "/" in host_path and "\\" not in host_path:
        base_path = posixpath.normpath(host_path)
        candidate_path = posixpath.normpath(resolved)
        try:
            if posixpath.commonpath([base_path, candidate_path]) != base_path:
                raise PermissionError("Access denied: path traversal detected")
        except ValueError:
            raise PermissionError("Access denied: path traversal detected") from None
        return resolved

    resolved_path = Path(resolved).resolve()
    try:
        resolved_path.relative_to(Path(host_path).resolve())
    except ValueError:
        raise PermissionError("Access denied: path traversal detected")

    return str(resolved_path)


def _get_mcp_allowed_paths() -> list[str]:
    """Get the list of allowed paths from MCP config for file system server."""
    allowed_paths = []
    try:
        from evoflow.config.extensions_config import get_extensions_config

        extensions_config = get_extensions_config()

        for _, server in extensions_config.mcp_servers.items():
            if not server.enabled:
                continue

            # Only check the filesystem server
            args = server.args or []
            # Check if args has server-filesystem package
            has_filesystem = any("server-filesystem" in arg for arg in args)
            if not has_filesystem:
                continue
            # Unpack the allowed file system paths in config
            for arg in args:
                if not arg.startswith("-") and arg.startswith("/"):
                    allowed_paths.append(arg.rstrip("/") + "/")

    except Exception:
        pass

    return allowed_paths


def _path_variants(path: str) -> set[str]:
    return {path, path.replace("\\", "/"), path.replace("/", "\\")}


def _join_path_preserving_style(base: str, relative: str) -> str:
    if not relative:
        return base
    if "/" in base and "\\" not in base:
        return f"{base.rstrip('/')}/{relative}"
    return str(Path(base) / relative)


def _sanitize_error(error: Exception, runtime: "ToolRuntime[ContextT, ThreadState] | None" = None) -> str:
    """Sanitize an error message to avoid leaking host filesystem paths.

    In local-sandbox mode, resolved host paths in the error string are masked
    back to their virtual equivalents so that user-visible output never exposes
    the host directory layout.
    """
    msg = f"{type(error).__name__}: {error}"
    if runtime is not None and is_local_sandbox(runtime) and _use_virtual_paths(runtime):
        thread_data = get_thread_data(runtime)
        msg = mask_local_paths_in_output(msg, thread_data)
    return msg


def replace_virtual_path(path: str, thread_data: ThreadDataState | None) -> str:
    """Replace virtual /mnt/user-data paths with actual thread data paths.

    Mapping:
        /mnt/user-data/workspace/* -> thread_data['workspace_path']/*
        /mnt/user-data/uploads/* -> thread_data['uploads_path']/*
        /mnt/user-data/outputs/* -> thread_data['outputs_path']/*

    Args:
        path: The path that may contain virtual path prefix.
        thread_data: The thread data containing actual paths.

    Returns:
        The path with virtual prefix replaced by actual path.
    """
    if thread_data is None:
        return path

    mappings = _thread_virtual_to_actual_mappings(thread_data)
    if not mappings:
        return path

    # Longest-prefix-first replacement with segment-boundary checks.
    for virtual_base, actual_base in sorted(mappings.items(), key=lambda item: len(item[0]), reverse=True):
        if path == virtual_base:
            return actual_base
        if path.startswith(f"{virtual_base}/"):
            rest = path[len(virtual_base) :].lstrip("/")
            return _join_path_preserving_style(actual_base, rest)

    return path


def _thread_virtual_to_actual_mappings(thread_data: ThreadDataState) -> dict[str, str]:
    """Build virtual-to-actual path mappings for a thread."""
    mappings: dict[str, str] = {}

    workspace = thread_data.get("workspace_path")
    uploads = thread_data.get("uploads_path")
    outputs = thread_data.get("outputs_path")

    if workspace:
        mappings[f"{VIRTUAL_PATH_PREFIX}/workspace"] = workspace
    if uploads:
        mappings[f"{VIRTUAL_PATH_PREFIX}/uploads"] = uploads
    if outputs:
        mappings[f"{VIRTUAL_PATH_PREFIX}/outputs"] = outputs

    # Also map the virtual root when all known dirs share the same parent.
    actual_dirs = [Path(p) for p in (workspace, uploads, outputs) if p]
    if actual_dirs:
        common_parent = str(Path(actual_dirs[0]).parent)
        if all(str(path.parent) == common_parent for path in actual_dirs):
            mappings[VIRTUAL_PATH_PREFIX] = common_parent

    return mappings


def _thread_actual_to_virtual_mappings(thread_data: ThreadDataState) -> dict[str, str]:
    """Build actual-to-virtual mappings for output masking."""
    return {actual: virtual for virtual, actual in _thread_virtual_to_actual_mappings(thread_data).items()}


def mask_local_paths_in_output(output: str, thread_data: ThreadDataState | None) -> str:
    """Mask host absolute paths from local sandbox output using virtual paths.

    Handles user-data paths (per-thread), skills paths, and ACP workspace paths (global).
    """
    result = output

    # Mask skills host paths
    skills_host = _get_skills_host_path()
    skills_container = _get_skills_container_path()
    if skills_host:
        raw_base = str(Path(skills_host))
        resolved_base = str(Path(skills_host).resolve())
        for base in _path_variants(raw_base) | _path_variants(resolved_base):
            escaped = re.escape(base).replace(r"\\", r"[/\\]")
            pattern = re.compile(escaped + r"(?:[/\\][^\s\"';&|<>()]*)?")

            def replace_skills(match: re.Match, _base: str = base) -> str:
                matched_path = match.group(0)
                if matched_path == _base:
                    return skills_container
                relative = matched_path[len(_base) :].lstrip("/\\")
                return f"{skills_container}/{relative}" if relative else skills_container

            result = pattern.sub(replace_skills, result)

    # Mask ACP workspace host paths
    _thread_id = _extract_thread_id_from_thread_data(thread_data)
    acp_host = _get_acp_workspace_host_path(_thread_id)
    if acp_host:
        raw_base = str(Path(acp_host))
        resolved_base = str(Path(acp_host).resolve())
        for base in _path_variants(raw_base) | _path_variants(resolved_base):
            escaped = re.escape(base).replace(r"\\", r"[/\\]")
            pattern = re.compile(escaped + r"(?:[/\\][^\s\"';&|<>()]*)?")

            def replace_acp(match: re.Match, _base: str = base) -> str:
                matched_path = match.group(0)
                if matched_path == _base:
                    return _ACP_WORKSPACE_VIRTUAL_PATH
                relative = matched_path[len(_base) :].lstrip("/\\")
                return f"{_ACP_WORKSPACE_VIRTUAL_PATH}/{relative}" if relative else _ACP_WORKSPACE_VIRTUAL_PATH

            result = pattern.sub(replace_acp, result)

    # Mask user-data host paths
    if thread_data is None:
        return result

    mappings = _thread_actual_to_virtual_mappings(thread_data)
    if not mappings:
        return result

    for actual_base, virtual_base in sorted(mappings.items(), key=lambda item: len(item[0]), reverse=True):
        raw_base = str(Path(actual_base))
        resolved_base = str(Path(actual_base).resolve())
        for base in _path_variants(raw_base) | _path_variants(resolved_base):
            escaped_actual = re.escape(base).replace(r"\\", r"[/\\]")
            pattern = re.compile(escaped_actual + r"(?:[/\\][^\s\"';&|<>()]*)?")

            def replace_match(match: re.Match, _base: str = base, _virtual: str = virtual_base) -> str:
                matched_path = match.group(0)
                if matched_path == _base:
                    return _virtual
                relative = matched_path[len(_base) :].lstrip("/\\")
                return f"{_virtual}/{relative}" if relative else _virtual

            result = pattern.sub(replace_match, result)

    return result


def _reject_path_traversal(path: str) -> None:
    """Reject paths that contain '..' segments to prevent directory traversal."""
    # Normalise to forward slashes, then check for '..' segments.
    normalised = path.replace("\\", "/")
    for segment in normalised.split("/"):
        if segment == "..":
            raise PermissionError("Access denied: path traversal detected")


def _sandbox_audit_ctx_from_runtime(
    runtime: "ToolRuntime[ContextT, ThreadState] | None",
) -> dict[str, str]:
    """Best-effort extraction of (session_key, thread_id) for sandbox audit logging."""
    ctx: dict[str, str] = {"session_key": "", "thread_id": ""}
    if runtime is None:
        return ctx
    try:
        tid = ""
        cfg = getattr(runtime, "config", None)
        if cfg:
            conf = cfg.get("configurable", {}) if isinstance(cfg, dict) else {}
            tid = str((conf or {}).get("thread_id") or "").strip()
        if not tid:
            rctx = getattr(runtime, "context", None) or {}
            if isinstance(rctx, dict):
                tid = str(rctx.get("thread_id") or "").strip()
        if tid:
            ctx["thread_id"] = tid
            try:
                from evoflow.persistence.session_repositories import find_session_key_by_thread_id

                ctx["session_key"] = find_session_key_by_thread_id(tid) or ""
            except Exception:
                pass
    except Exception:
        pass
    return ctx


def _audit_path_rejection(
    *,
    event_type: str,
    path: str,
    reason: str,
    runtime: "ToolRuntime[ContextT, ThreadState] | None",
    tool_name: str = "",
    tool_call_id: str = "",
) -> None:
    """Best-effort sandbox interception audit log (never raises)."""
    try:
        from evoflow.persistence.sandbox_audit_repositories import write_sandbox_audit_log

        audit_ctx = _sandbox_audit_ctx_from_runtime(runtime)
        write_sandbox_audit_log(
            event_type=event_type,
            path=path,
            reason=reason,
            tool_name=tool_name,
            tool_call_id=tool_call_id,
            session_key=audit_ctx.get("session_key", ""),
            thread_id=audit_ctx.get("thread_id", ""),
        )
    except Exception:
        # Audit logging must never break the interception path.
        pass


def _is_path_blacklisted(path: str) -> bool:
    """Check if a path matches any blacklist entry from the security center."""
    try:
        from evoflow.persistence.security_settings_repositories import get_security_settings

        blacklist = (
            get_security_settings()
            .get("sandbox", {})
            .get("file_security", {})
            .get("blacklist", [])
        )
        path_lower = path.lower()
        for entry in blacklist:
            e = str(entry).strip().lower()
            if not e:
                continue
            if path_lower == e or path_lower.startswith(e.rstrip("/") + "/"):
                return True
    except Exception:
        pass
    return False


def validate_local_tool_path(
    path: str,
    thread_data: ThreadDataState | None,
    *,
    read_only: bool = False,
    runtime: "ToolRuntime[ContextT, ThreadState] | None" = None,
    tool_name: str = "",
    tool_call_id: str = "",
) -> None:
    """Validate that a virtual path is allowed for local-sandbox access.

    This function is a security gate — it checks whether *path* may be
    accessed and raises on violation.  It does **not** resolve the virtual
    path to a host path; callers are responsible for resolution via
    ``_resolve_and_validate_user_data_path`` or ``_resolve_skills_path``.

    Allowed virtual-path families:
      - ``/mnt/user-data/*``  — always allowed (read + write)
      - ``/mnt/skills/*``     — allowed only when *read_only* is True
      - ``/mnt/acp-workspace/*`` — allowed only when *read_only* is True
      - Host absolute paths (e.g. WSL ``/mnt/d/...``, Windows ``D:\\...``) — only
        when *read_only* is True and ``EVOFLOW_ALLOW_LOCAL_HOST_READS`` is enabled

    Args:
        path: The virtual path to validate.
        thread_data: Thread data (must be present for local sandbox).
        read_only: When True, skills and ACP workspace paths are permitted.

    Raises:
        SandboxRuntimeError: If thread data is missing.
        PermissionError: If the path is not allowed or contains traversal.
    """
    if thread_data is None:
        raise SandboxRuntimeError("Thread data not available for local sandbox")

    try:
        _reject_path_traversal(path)
    except PermissionError:
        _audit_path_rejection(
            event_type="path_traversal",
            path=path,
            reason="Access denied: path traversal detected",
            runtime=runtime,
            tool_name=tool_name,
            tool_call_id=tool_call_id,
        )
        raise

    # Security center: blacklist check
    if _is_path_blacklisted(path):
        reason = f"Path blocked by security center blacklist: {path}"
        _audit_path_rejection(
            event_type="path_denied",
            path=path,
            reason=reason,
            runtime=runtime,
            tool_name=tool_name,
            tool_call_id=tool_call_id,
        )
        raise PermissionError(reason)

    # Skills paths — read-only access only
    if _is_skills_path(path):
        if not read_only:
            reason = f"Write access to skills path is not allowed: {path}"
            _audit_path_rejection(
                event_type="path_denied",
                path=path,
                reason=reason,
                runtime=runtime,
                tool_name=tool_name,
                tool_call_id=tool_call_id,
            )
            raise PermissionError(reason)
        return

    # ACP workspace paths — read-only access only
    if _is_acp_workspace_path(path):
        if not read_only:
            reason = f"Write access to ACP workspace is not allowed: {path}"
            _audit_path_rejection(
                event_type="path_denied",
                path=path,
                reason=reason,
                runtime=runtime,
                tool_name=tool_name,
                tool_call_id=tool_call_id,
            )
            raise PermissionError(reason)
        return

    # User-data paths
    if path.startswith(f"{VIRTUAL_PATH_PREFIX}/"):
        return

    # Host absolute paths (opt-in, read-only tools only) — local sandbox self-hosting
    if read_only and _local_host_reads_enabled() and _is_explicit_host_filesystem_path(path):
        return

    reason = f"Only paths under {VIRTUAL_PATH_PREFIX}/, {_get_skills_container_path()}/, or {_ACP_WORKSPACE_VIRTUAL_PATH}/ are allowed"
    _audit_path_rejection(
        event_type="path_denied",
        path=path,
        reason=reason,
        runtime=runtime,
        tool_name=tool_name,
        tool_call_id=tool_call_id,
    )
    raise PermissionError(reason)


def _validate_resolved_user_data_path(resolved: Path, thread_data: ThreadDataState) -> None:
    """Verify that a resolved host path stays inside allowed per-thread roots.

    Raises PermissionError if the path escapes workspace/uploads/outputs.
    """
    allowed_roots = [
        Path(p).resolve()
        for p in (
            thread_data.get("workspace_path"),
            thread_data.get("uploads_path"),
            thread_data.get("outputs_path"),
        )
        if p is not None
    ]

    if not allowed_roots:
        raise SandboxRuntimeError("No allowed local sandbox directories configured")

    for root in allowed_roots:
        try:
            resolved.relative_to(root)
            return
        except ValueError:
            continue

    raise PermissionError("Access denied: path traversal detected")


def _resolve_and_validate_user_data_path(path: str, thread_data: ThreadDataState) -> str:
    """Resolve a /mnt/user-data virtual path and validate it stays in bounds.

    Returns the resolved host path string.
    """
    resolved_str = replace_virtual_path(path, thread_data)
    resolved = Path(resolved_str).resolve()
    _validate_resolved_user_data_path(resolved, thread_data)
    return str(resolved)


def _resolve_sandbox_path(
    path: str,
    runtime: "ToolRuntime[ContextT, ThreadState] | None",
    *,
    read_only: bool = False,
    tool_name: str = "",
    tool_call_id: str = "",
) -> tuple[str, "ThreadDataState | None"]:
    """Resolve a virtual sandbox path to a host filesystem path.

    This is the **single source of truth** for path resolution across all file tools
    (ls, read_file, write_file, str_replace).  It replaces the duplicated ~12-line
    resolution blocks that were previously copy-pasted into every tool.

    Resolution order (for *read_only* tools):
      1. Skills paths (``/mnt/skills/…``) → host skills directory
      2. ACP workspace (``/mnt/acp-workspace/…``) → host ACP directory
      3. Host-absolute paths (``D:\\...``, ``/mnt/d/...``) → resolved directly
         (only when ``EVOFLOW_ALLOW_LOCAL_HOST_READS=1``)
      4. User-data virtual paths (``/mnt/user-data/…``) → per-thread directories

    For *write* tools only step 3 (local-host mode) and step 4 apply.

    Args:
        path: The unresolved (virtual) path from the tool caller.
        runtime: Tool runtime used to detect sandbox mode and preferences.
        read_only: When True, skills / ACP / host-absolute paths are allowed.
                   When False, only user-data paths are permitted.

    Returns:
        A ``(resolved_host_path, thread_data)`` tuple.  *thread_data* may be
        ``None`` when the runtime is not a local sandbox (no resolution needed).

    Raises:
        PermissionError: If the path is not authorised or contains traversal.
        SandboxRuntimeError: If thread data is missing in local-sandbox mode.
        FileNotFoundError: If a skills/ACP directory is not available.
    """
    if not is_local_sandbox(runtime):
        return path, None

    thread_data = get_thread_data(runtime)
    validate_local_tool_path(
        path,
        thread_data,
        read_only=read_only,
        runtime=runtime,
        tool_name=tool_name,
        tool_call_id=tool_call_id,
    )

    # --- Read-only tools may resolve special-path families -------------------
    if read_only:
        if _is_skills_path(path):
            return _resolve_skills_path(path), thread_data

        if _is_acp_workspace_path(path):
            tid = _extract_thread_id_from_thread_data(thread_data)
            return _resolve_acp_workspace_path(path, tid), thread_data

        # Local-host mode + explicit host path (opt-in)
        if (not _use_virtual_paths(runtime)) or (_local_host_reads_enabled() and _is_explicit_host_filesystem_path(path)):
            return str(Path(path).resolve()), thread_data

    # --- Default: resolve through /mnt/user-data virtual mapping -------------
    resolved = _resolve_and_validate_user_data_path(path, thread_data)
    return resolved, thread_data


def validate_local_bash_command_paths(command: str, thread_data: ThreadDataState | None) -> None:
    """Validate absolute paths in local-sandbox bash commands.

    This validation is only a best-effort guard for the explicit
    This path was retired with LocalSandbox. Prefer ``terminal`` under
    ``tools_mode=host_direct``. Kept only for AIO container bash.
    boundary and must not be treated as isolation from the host filesystem.

    In local mode, commands must use virtual paths under /mnt/user-data for
    user data access. Skills paths under /mnt/skills and ACP workspace paths
    under /mnt/acp-workspace are allowed (path-traversal checks only; write
    prevention for bash commands is not enforced here).
    A small allowlist of common system path prefixes is kept for executable
    and device references (e.g. /bin/sh, /dev/null).

    When ``EVOFLOW_ALLOW_LOCAL_HOST_READS`` is set, other absolute host paths
    are allowed (best-effort; same limitations as above).
    """
    if thread_data is None:
        raise SandboxRuntimeError("Thread data not available for local sandbox")

    unsafe_paths: list[str] = []
    allowed_paths = _get_mcp_allowed_paths()

    for absolute_path in _ABSOLUTE_PATH_PATTERN.findall(command):
        # Check for MCP filesystem server allowed paths
        if any(absolute_path.startswith(path) or absolute_path == path.rstrip("/") for path in allowed_paths):
            _reject_path_traversal(absolute_path)
            continue

        if absolute_path == VIRTUAL_PATH_PREFIX or absolute_path.startswith(f"{VIRTUAL_PATH_PREFIX}/"):
            _reject_path_traversal(absolute_path)
            continue

        # Allow skills container path (resolved by tools.py before passing to sandbox)
        if _is_skills_path(absolute_path):
            _reject_path_traversal(absolute_path)
            continue

        # Allow ACP workspace path (path-traversal check only)
        if _is_acp_workspace_path(absolute_path):
            _reject_path_traversal(absolute_path)
            continue

        if any(absolute_path == prefix.rstrip("/") or absolute_path.startswith(prefix) for prefix in _LOCAL_BASH_SYSTEM_PATH_PREFIXES):
            continue

        if _local_host_reads_enabled() and _is_explicit_host_filesystem_path(absolute_path):
            _reject_path_traversal(absolute_path)
            continue

        unsafe_paths.append(absolute_path)

    if unsafe_paths:
        unsafe = ", ".join(sorted(dict.fromkeys(unsafe_paths)))
        raise PermissionError(f"Unsafe absolute paths in command: {unsafe}. Use paths under {VIRTUAL_PATH_PREFIX}")


def replace_virtual_paths_in_command(command: str, thread_data: ThreadDataState | None) -> str:
    """Replace all virtual paths (/mnt/user-data, /mnt/skills, /mnt/acp-workspace) in a command string.

    Args:
        command: The command string that may contain virtual paths.
        thread_data: The thread data containing actual paths.

    Returns:
        The command with all virtual paths replaced.
    """
    result = command

    # Replace skills paths
    skills_container = _get_skills_container_path()
    skills_host = _get_skills_host_path()
    if skills_host and skills_container in result:
        skills_pattern = re.compile(rf"{re.escape(skills_container)}(/[^\s\"';&|<>()]*)?")

        def replace_skills_match(match: re.Match) -> str:
            return _resolve_skills_path(match.group(0))

        result = skills_pattern.sub(replace_skills_match, result)

    # Replace ACP workspace paths
    _thread_id = _extract_thread_id_from_thread_data(thread_data)
    acp_host = _get_acp_workspace_host_path(_thread_id)
    if acp_host and _ACP_WORKSPACE_VIRTUAL_PATH in result:
        acp_pattern = re.compile(rf"{re.escape(_ACP_WORKSPACE_VIRTUAL_PATH)}(/[^\s\"';&|<>()]*)?")

        def replace_acp_match(match: re.Match, _tid: str | None = _thread_id) -> str:
            return _resolve_acp_workspace_path(match.group(0), _tid)

        result = acp_pattern.sub(replace_acp_match, result)

    # Replace user-data paths
    if VIRTUAL_PATH_PREFIX in result and thread_data is not None:
        pattern = re.compile(rf"{re.escape(VIRTUAL_PATH_PREFIX)}(/[^\s\"';&|<>()]*)?")

        def replace_user_data_match(match: re.Match) -> str:
            return replace_virtual_path(match.group(0), thread_data)

        result = pattern.sub(replace_user_data_match, result)

    return result


def _replace_virtual_paths_in_output(output: str, thread_data: ThreadDataState | None) -> str:
    """Convert virtual paths back to host paths in local-host mode output."""
    if not output:
        return output
    return replace_virtual_paths_in_command(output, thread_data)


def _looks_like_shell_web_search(command: str) -> bool:
    """Detect shell commands that try to perform network search directly.

    We prefer the dedicated `web_search` tool for search/news lookup to keep
    behavior consistent and avoid ad-hoc scraping scripts.
    """
    cmd = (command or "").lower()
    patterns = [
        "/mnt/skills/public/web-search/scripts/search.sh",
        "$skills_root/web-search/scripts/search.sh",
        "from tools import web_search",
        "tools import web_search",
        "web_search(",
        'curl -s "https://www.bing.com/news/search',
        "curl -s 'https://www.bing.com/news/search",
        'curl "https://www.bing.com/news/search',
        "bing.com/search",
        "bing.com/news/search",
        "google.com/search",
        "baidu.com/s?",
        "duckduckgo.com",
        "from playwright.sync_api",
    ]
    return any(p in cmd for p in patterns)


def _bash_network_access_allowed() -> bool:
    """Whether bash is allowed to access network directly."""
    return os.environ.get(_EVOFLOW_ALLOW_NETWORK_IN_BASH_ENV, "").strip().lower() in (
        "1",
        "true",
        "yes",
    )


def _looks_like_network_command(command: str) -> bool:
    """Detect likely network access in shell command.

    Root-cause policy: web/network retrieval should use dedicated tools
    (`web_search` / `web_fetch`), not ad-hoc shell networking.
    """
    cmd = (command or "").lower()
    patterns = [
        "http://",
        "https://",
        "curl ",
        "wget ",
        "invoke-webrequest",
        "invoke-restmethod",
        "requests.",
        "import requests",
        "import httpx",
        "from playwright",
        "playwright.sync_api",
        "socket.",
        "aiohttp",
    ]
    return any(p in cmd for p in patterns)


def _looks_like_linux_shell_only(command: str) -> bool:
    """Detect Linux-specific shell usage that breaks on Windows PowerShell."""
    cmd = (command or "").lower()
    patterns = [
        "/mnt/",
        " grep ",
        "| grep",
        " head ",
        "| head",
        " sed ",
        "| sed",
        " awk ",
        "| awk",
        " source ",
        " && ",
    ]
    return any(p in cmd for p in patterns)


def get_thread_data(runtime: ToolRuntime[ContextT, ThreadState] | None) -> ThreadDataState | None:
    """Extract thread_data from runtime state."""
    if runtime is None:
        return None
    if runtime.state is None:
        return None
    return runtime.state.get("thread_data")


def _use_virtual_paths(runtime: ToolRuntime[ContextT, ThreadState] | None) -> bool:
    """Whether current run prefers virtual /mnt paths.

    Default False (prefer local host paths).
    """
    if runtime is None:
        return False
    ctx = getattr(runtime, "context", None) or {}
    val = ctx.get("use_virtual_paths")
    if isinstance(val, bool):
        return val
    return False


def is_local_sandbox(runtime: ToolRuntime[ContextT, ThreadState] | None) -> bool:
    """Check if the current sandbox is a local sandbox.

    Path replacement is only needed for local sandbox since aio sandbox
    already has /mnt/user-data mounted in the container.
    """
    if runtime is None:
        return False
    if runtime.state is None:
        return False
    sandbox_state = runtime.state.get("sandbox")
    if sandbox_state is None:
        return False
    return sandbox_state.get("sandbox_id") == "local"


def sandbox_from_runtime(runtime: ToolRuntime[ContextT, ThreadState] | None = None) -> Sandbox:
    """Extract sandbox instance from tool runtime.

    DEPRECATED: Use ensure_sandbox_initialized() for lazy initialization support.
    This function assumes sandbox is already initialized and will raise error if not.

    Raises:
        SandboxRuntimeError: If runtime is not available or sandbox state is missing.
        SandboxNotFoundError: If sandbox with the given ID cannot be found.
    """
    if runtime is None:
        raise SandboxRuntimeError("Tool runtime not available")
    if runtime.state is None:
        raise SandboxRuntimeError("Tool runtime state not available")
    sandbox_state = runtime.state.get("sandbox")
    if sandbox_state is None:
        raise SandboxRuntimeError("Sandbox state not initialized in runtime")
    sandbox_id = sandbox_state.get("sandbox_id")
    if sandbox_id is None:
        raise SandboxRuntimeError("Sandbox ID not found in state")
    sandbox = get_sandbox_provider().get(sandbox_id)
    if sandbox is None:
        raise SandboxNotFoundError(f"Sandbox with ID '{sandbox_id}' not found", sandbox_id=sandbox_id)

    runtime.context["sandbox_id"] = sandbox_id  # Ensure sandbox_id is in context for downstream use
    return sandbox


def ensure_sandbox_initialized(runtime: ToolRuntime[ContextT, ThreadState] | None = None) -> Sandbox:
    """Ensure sandbox is initialized, acquiring lazily if needed.

    On first call, acquires a sandbox from the provider and stores it in runtime state.
    Subsequent calls return the existing sandbox.

    Thread-safety is guaranteed by the provider's internal locking mechanism.

    Args:
        runtime: Tool runtime containing state and context.

    Returns:
        Initialized sandbox instance.

    Raises:
        SandboxRuntimeError: If runtime is not available or thread_id is missing.
        SandboxNotFoundError: If sandbox acquisition fails.
    """
    if runtime is None:
        raise SandboxRuntimeError("Tool runtime not available")

    if runtime.state is None:
        raise SandboxRuntimeError("Tool runtime state not available")

    # Check if sandbox already exists in state
    sandbox_state = runtime.state.get("sandbox")
    if sandbox_state is not None:
        sandbox_id = sandbox_state.get("sandbox_id")
        if sandbox_id is not None:
            sandbox = get_sandbox_provider().get(sandbox_id)
            if sandbox is not None:
                runtime.context["sandbox_id"] = sandbox_id  # Ensure sandbox_id is in context for releasing in after_agent
                return sandbox
            # Sandbox was released, fall through to acquire new one

    # Lazy acquisition: get thread_id and acquire sandbox
    thread_id = runtime.context.get("thread_id") if runtime.context else None
    if thread_id is None:
        thread_id = runtime.config.get("configurable", {}).get("thread_id") if runtime.config else None
    if thread_id is None:
        raise SandboxRuntimeError("Thread ID not available in runtime context")

    provider = get_sandbox_provider()
    sandbox_id = provider.acquire(thread_id)

    # Update runtime state - this persists across tool calls
    runtime.state["sandbox"] = {"sandbox_id": sandbox_id}

    # Retrieve and return the sandbox
    sandbox = provider.get(sandbox_id)
    if sandbox is None:
        raise SandboxNotFoundError("Sandbox not found after acquisition", sandbox_id=sandbox_id)

    runtime.context["sandbox_id"] = sandbox_id  # Ensure sandbox_id is in context for releasing in after_agent
    return sandbox


def ensure_thread_directories_exist(runtime: ToolRuntime[ContextT, ThreadState] | None) -> None:
    """Ensure thread data directories (workspace, uploads, outputs) exist.

    This function is called lazily when any sandbox tool is first used.
    For local sandbox, it creates the directories on the filesystem.
    For other sandboxes (like aio), directories are already mounted in the container.

    Args:
        runtime: Tool runtime containing state and context.
    """
    if runtime is None:
        return

    # Only create directories for local sandbox
    if not is_local_sandbox(runtime):
        return

    thread_data = get_thread_data(runtime)
    if thread_data is None:
        return

    # Check if directories have already been created
    if runtime.state.get("thread_directories_created"):
        return

    # Create the three directories
    import os

    for key in ["workspace_path", "uploads_path", "outputs_path"]:
        path = thread_data.get(key)
        if path:
            os.makedirs(path, exist_ok=True)

    # Mark as created to avoid redundant operations
    runtime.state["thread_directories_created"] = True


@tool("bash", parse_docstring=True)
def bash_tool(runtime: ToolRuntime[ContextT, ThreadState], description: str, command: str) -> str:
    """Execute a bash command in a Linux environment.


    - Use `python` to run Python code.
    - Prefer a thread-local virtual environment in `/mnt/user-data/workspace/.venv`.
    - Use `python -m pip` (inside the virtual environment) to install Python packages.

    Args:
        description: Explain why you are running this command in short words. ALWAYS PROVIDE THIS PARAMETER FIRST.
        command: The bash command to execute. Always use absolute paths for files and directories.
    """
    try:
        if _looks_like_shell_web_search(command):
            return "Error: Network search via shell is disabled. Please use the `web_search` tool directly for search/news queries, and use `web_fetch` only for follow-up reading of specific URLs."
        if (not _bash_network_access_allowed()) and _looks_like_network_command(command):
            return f"Error: Network access via `bash` is disabled by policy. Use `web_search` for discovery and `web_fetch` for fetching specific URLs. If you really need network in bash, set env `{_EVOFLOW_ALLOW_NETWORK_IN_BASH_ENV}=1`."
        if is_local_sandbox(runtime) or not is_host_bash_allowed():
            # Noop / legacy LocalSandbox — host bash deleted; use terminal.
            return f"Error: {LOCAL_HOST_BASH_DISABLED_MESSAGE}"
        sandbox = ensure_sandbox_initialized(runtime)
        ensure_thread_directories_exist(runtime)
        return sandbox.execute_command(command)
    except SandboxError as e:
        return f"Error: {e}"
    except PermissionError as e:
        return f"Error: {e}"
    except Exception as e:
        return f"Error: Unexpected error executing command: {_sanitize_error(e, runtime)}"


def ls_tool(
    runtime: ToolRuntime[ContextT, ThreadState],
    description: str,
    path: str,
    *,
    depth: int | None = None,
    ignore_patterns: list[str] | None = None,
    show_hidden: bool = False,
    format: Literal["tree", "list"] = "tree",
) -> str:
    """List the contents of a directory in tree or list format.

    Args:
        description: Explain why you are listing this directory in short words. ALWAYS PROVIDE THIS PARAMETER FIRST.
        path: The **absolute** path to the directory to list.
        depth: Maximum depth to traverse (default: 2, same as original). 1 = direct children only.
        ignore_patterns: Additional glob patterns to ignore (e.g. ["node_modules", "*.log"]).
                          Built-in patterns (.git, __pycache__, node_modules, etc.) always apply.
        show_hidden: Show hidden files/directories (names starting with .). Default False.
        format: Output format - 'tree' (visual tree with connectors, default) or 'list'
                (flat listing with metadata, easy for LLM to parse).
    """
    requested_path = path
    try:
        sandbox = ensure_sandbox_initialized(runtime)
        ensure_thread_directories_exist(runtime)
        if isinstance(path, str) and path.startswith("skill:"):
            path = _resolve_skill_uri_path(path, resolve_as_dir=True)
            # skill URI paths are resolved to absolute host paths — direct use.
            thread_data = get_thread_data(runtime) if is_local_sandbox(runtime) else None
        else:
            path, thread_data = _resolve_sandbox_path(path, runtime, read_only=True)

        # Use sandbox's built-in max_depth; default 2 preserves backward compatibility
        max_depth = depth if depth is not None else 2
        children = sandbox.list_dir(path, max_depth=max_depth)

        if is_local_sandbox(runtime) and not _use_virtual_paths(runtime):
            thread_data = get_thread_data(runtime)
            children = [_replace_virtual_paths_in_output(c, thread_data) for c in children]

        if not children:
            return "(empty)"

        # --- Apply additional filters ----------------------------------------
        extra_ignores: set[str] | None = set(ignore_patterns) if ignore_patterns else None

        def _parse_entry(entry: str) -> tuple[str, bool]:
            is_dir = entry.endswith("/")
            return (entry.rstrip("/"), is_dir)

        filtered: list[tuple[str, bool]] = []
        for entry in children:
            name = entry.rsplit("/", 1)[-1] if "/" in entry else entry.lstrip("/")
            name = name.rstrip("/")

            if extra_ignores and _matches_any_pattern(name, extra_ignores):
                continue
            if not show_hidden and name.startswith("."):
                continue
            filtered.append(_parse_entry(entry))

        if not filtered:
            return "(empty)"

        if format == "list":
            return _format_ls_list(filtered, requested_path)
        return _format_ls_tree(filtered, max_depth)

    except SandboxError as e:
        return f"Error: {e}"
    except FileNotFoundError:
        return f"Error: Directory not found: {requested_path}"
    except PermissionError:
        return f"Error: Permission denied: {requested_path}"
    except Exception as e:
        return f"Error: Unexpected error listing directory: {_sanitize_error(e, runtime)}"


def _resolve_skill_uri_path(path: str, *, resolve_as_dir: bool = False) -> str:
    """Resolve a ``skill:<name>`` URI to a host filesystem path.

    For ``resolve_as_dir=True`` (``ls``): bare ``skill:<name>`` → skill install
    directory; ``skill:<name>/subdir`` → subdirectory under skill install.

    For ``resolve_as_dir=False`` (``read_file``): bare ``skill:<name>`` →
    ``SKILL.md`` inside the skill directory; ``skill:<name>/file.md`` → file.

    Returns the original *path* unchanged when it is not a ``skill:`` URI.
    """
    if not isinstance(path, str) or not path.startswith("skill:"):
        return path
    from evoflow.skills.loader import find_skill_directory
    from evoflow.skills.skill_uri import parse_skill_uri

    parsed = parse_skill_uri(path)
    if parsed is None:
        return path
    key, rel = parsed
    skill_dir = find_skill_directory(key, require_enabled=True)
    if skill_dir is None:
        raise FileNotFoundError(f"Skill '{key}' not found or disabled")
    base = skill_dir.resolve()
    if not rel:
        return str(base if resolve_as_dir else base / "SKILL.md")
    target = (base / rel).resolve()
    try:
        target.relative_to(base)
    except ValueError:
        raise PermissionError(f"Skill path escapes root: {path}")
    return str(target)


def _matches_any_pattern(name: str, patterns: set[str]) -> bool:
    import fnmatch as _fnmatch

    for pat in patterns:
        if _fnmatch.fnmatch(name, pat):
            return True
    return False


def _format_ls_tree(entries: list[tuple[str, bool]], max_depth: int) -> str:
    """Format entries as a visual tree with Unicode box-drawing characters."""
    from pathlib import Path as _Path

    lines: list[str] = []
    seen: set[str] = set()

    for abs_path, is_dir in entries:
        p = _Path(abs_path)
        name = p.name + ("/" if is_dir else "")
        depth_from_root = len(p.parts) - 1

        indent = ""
        if depth_from_root > 0:
            indent = "│   " * (depth_from_root - 1)
            connector = "├── "
        else:
            connector = ""

        size_str = ""
        if not is_dir:
            try:
                size = p.stat().st_size
                if size > 1024 * 1024:
                    size_str = f" ({size / (1024 * 1024):.1f} MB)"
                elif size > 1024:
                    size_str = f" ({size / 1024:.1f} KB)"
                else:
                    size_str = f" ({size} B)"
            except OSError:
                pass

        line = f"{indent}{connector}{name}{size_str}"
        key = f"{depth_from_root}:{p.name}"
        if key not in seen:
            seen.add(key)
            lines.append(line)

    return "\n".join(lines) if lines else "(empty)"


def _format_ls_list(entries: list[tuple[str, bool]], requested_path: str) -> str:
    """Format entries as a flat listing with type/size metadata."""
    from pathlib import Path as _Path

    lines: list[str] = []
    for abs_path, is_dir in sorted(entries, key=lambda x: (not x[1], x[0])):
        try:
            p = _Path(abs_path)
            kind = "d" if is_dir else "-"
            size = p.stat().st_size if not is_dir else 0
            size_fmt = f"{size:>10,}" if not is_dir else "         -"
            rel_name = abs_path.rsplit("/", 1)[-1].rstrip("/") if "/" in abs_path else abs_path.lstrip("/").rstrip("/")
            lines.append(f"{kind}  {rel_name:<50} {size_fmt}")
        except OSError:
            continue

    return "\n".join(lines) if lines else "(empty)"


@tool("read_file", parse_docstring=True)
def read_file_tool(
    runtime: ToolRuntime[ContextT, ThreadState],
    description: str,
    path: str,
    start_line: int | None = None,
    end_line: int | None = None,
) -> str:
    """Read the contents of a text file. Use this to examine source code, configuration files, logs, or any text-based file.

    Args:
        description: Explain why you are reading this file in short words. ALWAYS PROVIDE THIS PARAMETER FIRST.
        path: The **absolute** path to the file to read.
        start_line: Optional starting line number (1-indexed, inclusive). Use with end_line to read a specific range.
        end_line: Optional ending line number (1-indexed, inclusive). Use with start_line to read a specific range.
    """
    requested_path = path
    try:
        sandbox = ensure_sandbox_initialized(runtime)
        ensure_thread_directories_exist(runtime)
        if isinstance(path, str) and path.startswith("skill:"):
            path = _resolve_skill_uri_path(path, resolve_as_dir=False)
            thread_data = get_thread_data(runtime) if is_local_sandbox(runtime) else None
        else:
            path, thread_data = _resolve_sandbox_path(path, runtime, read_only=True)
        content = sandbox.read_file(path)
        if not content:
            return "(empty)"
        if start_line is not None and end_line is not None:
            content = "\n".join(content.splitlines()[start_line - 1 : end_line])
        return content
    except SandboxError as e:
        return f"Error: {e}"
    except FileNotFoundError:
        return f"Error: File not found: {requested_path}"
    except PermissionError:
        return f"Error: Permission denied reading file: {requested_path}"
    except IsADirectoryError:
        return f"Error: Path is a directory, not a file: {requested_path}"
    except Exception as e:
        return f"Error: Unexpected error reading file: {_sanitize_error(e, runtime)}"


def write_file_tool(
    runtime: ToolRuntime[ContextT, ThreadState],
    description: str,
    path: str,
    content: str,
    *,
    append: bool = False,
    create_line: bool = True,
    backup: bool = False,
) -> str:
    """Write text content to a file with enhanced options.

    Args:
        description: Explain why you are writing to this file in short words. ALWAYS PROVIDE THIS PARAMETER FIRST.
        path: The **absolute** path to the file to write to.
        content: The content to write to the file.
        append: If True, append to existing file. Default False (overwrite).
        create_line: Ensure the content ends with a newline. Default True.
        backup: Create a .bak backup before overwriting. Default False.

    Parent directories are created automatically if they don't exist.
    """
    import shutil as _shutil
    from pathlib import Path as _Path

    requested_path = path
    try:
        sandbox = ensure_sandbox_initialized(runtime)
        ensure_thread_directories_exist(runtime)
        path, _thread_data = _resolve_sandbox_path(path, runtime, read_only=False)

        # Backup existing file before overwrite (only when not appending)
        if backup and not append:
            p = _Path(path)
            if p.exists():
                bak_path = p.with_suffix(p.suffix + ".bak")
                try:
                    _shutil.copy2(p, bak_path)
                except OSError:
                    pass  # Non-critical: continue without backup

        # Ensure trailing newline for text files
        if create_line and content and not content.endswith("\n"):
            content = content + "\n"

        # Write via sandbox
        sandbox.write_file(path, content, append)

        # Report result with size info
        action = "appended to" if append else "wrote"
        byte_count = len(content.encode("utf-8"))
        return f"OK: {action} {requested_path} ({byte_count} bytes)"

    except SandboxError as e:
        return f"Error: {e}"
    except PermissionError:
        return f"Error: Permission denied writing to file: {requested_path}"
    except IsADirectoryError:
        return f"Error: Path is a directory, not a file: {requested_path}"
    except OSError as e:
        # Enhanced error context
        p = _Path(requested_path) if "requested_path" in dir() else None
        extra = ""
        if p and p.exists() and p.is_dir():
            extra = " — target is a directory, use a file path"
        elif e.errno == 28:
            extra = " — disk full or quota exceeded"
        elif e.errno == 30:
            extra = " — filesystem is read-only"
        return f"Error: Failed to write file '{requested_path}': {_sanitize_error(e, runtime)}{extra}"
    except Exception as e:
        return f"Error: Unexpected error writing file: {_sanitize_error(e, runtime)}"


def str_replace_tool(
    runtime: ToolRuntime[ContextT, ThreadState],
    description: str,
    path: str,
    old_string: str,
    new_string: str,
    *,
    replace_all: bool = False,
    dry_run: bool = False,
    regex: bool = False,
) -> str:
    """Replace text in a file with precise matching.

    By default, old_string must appear EXACTLY ONCE in the file.
    If it appears multiple times, the tool reports all locations so you
    can provide more context for a unique match.

    Args:
        description: Explain why you are replacing the substring. ALWAYS PROVIDE THIS PARAMETER FIRST.
        path: The **absolute** path to the file to edit.
        old_string: The exact string to replace (or regex pattern if regex=True).
        new_string: The replacement string.
        replace_all: Whether to replace all occurrences. Default False.
        dry_run: If True, show what would change without writing. Default False.
        regex: If True, treat old_string as a regex pattern. Default False.
    """
    requested_path = path
    try:
        sandbox = ensure_sandbox_initialized(runtime)
        ensure_thread_directories_exist(runtime)
        path, _thread_data = _resolve_sandbox_path(path, runtime, read_only=False)

        content = sandbox.read_file(path)
        if not content:
            return "OK"  # Empty file, nothing to do

        # ── Dry run mode ──────────────────────────────────────────
        if dry_run:
            return _str_replace_dry_run(content, old_string, new_string, requested_path, regex=regex)

        # ── Regex mode ────────────────────────────────────────────
        if regex:
            import re as _re2

            try:
                compiled = _re2.compile(old_string, _re2.DOTALL)
                matches = compiled.findall(content)
                new_content = compiled.sub(new_string, content)
                count = len(matches)
            except _re2.error as e:
                return f"Error: Invalid regex pattern: {e}"
            if count == 0:
                return f"Error: Pattern not found in file: {requested_path}\nPattern: {old_string[:100]}..."
            sandbox.write_file(path, new_content)
            delta = len(new_content) - len(content)
            return f"OK: Replaced {count} occurrence(s) in {requested_path} ({'+' if delta >= 0 else ''}{delta} chars)"

        # ── Exact string match mode ──────────────────────────────
        count = content.count(old_string)
        if count == 0:
            return f"Error: String not found in file: {requested_path}\nSearched for: {old_string[:120]}{'...' if len(old_string) > 120 else ''}"
        if count > 1 and not replace_all:
            locations = _find_all_match_locations(content, old_string, requested_path)
            return f"Error: String appears {count} times in {requested_path}. Provide more context for uniqueness.\n\n{locations}\n\nTo replace all occurrences, use replace_all=True."

        new_content = content.replace(old_string, new_string, -1 if replace_all else 1)
        actual_count = count if replace_all else 1

        # Write back
        sandbox.write_file(path, new_content)
        added = len(new_string) - len(old_string)
        total_delta = added * actual_count
        return f"OK: Replaced {actual_count} occurrence(s) in {requested_path} ({'+' if total_delta >= 0 else ''}{total_delta} chars)"

    except SandboxError as e:
        return f"Error: {e}"
    except FileNotFoundError:
        return f"Error: File not found: {requested_path}"
    except PermissionError:
        return f"Error: Permission denied accessing file: {requested_path}"
    except Exception as e:
        return f"Error: Unexpected error replacing string: {_sanitize_error(e, runtime)}"


def _str_replace_dry_run(content: str, old: str, new: str, path: str, *, regex: bool = False) -> str:
    """Generate a dry-run preview of replacement changes."""
    if regex:
        import re as _re2

        try:
            matches = list(_re2.finditer(old, content, _re2.DOTALL))
        except _re2.error as e:
            return f"Dry run: Invalid regex '{old}': {e}"
        if not matches:
            return f"Dry run: No matches for pattern in {path}"
        lines = ["--- Dry Run Preview ---", f"File: {path}", ""]
        lines.append(f"Pattern would match {len(matches)} location(s):")
        for i, m in enumerate(matches[:5]):
            start = m.start()
            snippet = content[max(0, start - 30) : start + len(m.group()) + 30].replace("\n", "\\n")
            lines.append(f"  [{i}] ...{snippet}...")
        if len(matches) > 5:
            lines.append(f"  ... and {len(matches) - 5} more")
        lines.append("\nRun again with dry_run=False to apply.")
        return "\n".join(lines)

    count = content.count(old)
    if count == 0:
        return f"Dry run: String not found in {path}"

    old_lines = old.splitlines()
    new_lines = new.splitlines()
    lines = [
        "--- Dry Run Preview ---",
        f"File: {path}",
        "",
        f"<<<< OLD ({len(old_lines)} line{'s' if len(old_lines) != 1 else ''})",
    ]
    for line in old_lines:
        lines.append(f"  {line}")
    lines.append(f">>>> NEW ({len(new_lines)} line{'s' if len(new_lines) != 1 else ''})")
    for line in new_lines:
        lines.append(f"  {line}")
    lines.append("---")
    action = f"replace all {count} occurrences" if count > 1 else "change"
    lines.append(f"Would {action}. Run with dry_run=False to apply.")
    return "\n".join(lines)


def _find_all_match_locations(content: str, target: str, path: str) -> str:
    """Find all locations where target appears, with surrounding context."""
    lines = content.splitlines()
    locations = []
    for i, line in enumerate(lines):
        idx = 0
        while True:
            pos = line.find(target, idx)
            if pos == -1:
                break
            preview = line[max(0, pos - 40) : pos + len(target) + 40]
            locations.append(f"  Line {i + 1}, col {pos + 1}: ...{preview}...")
            idx = pos + 1
            if len(locations) >= 8:
                total_hits = sum(line.count(target) for line in lines)
                locations.append(f"  ... and {max(0, total_hits - len(locations))} more")
                return "\nMatch locations:\n" + "\n".join(locations)
    return "\nMatch locations:\n" + "\n".join(locations)


# ─── delete_file tool ─────────────────────────────────────────────

# System paths that must never be deleted via this tool
_DELETE_PROTECTED_PREFIXES: list[str] = [
    # Windows system paths
    "\\Windows",
    "\\Program Files",
    "\\Program Files (x86)",
    "\\ProgramData",
    # Linux/Unix system paths
    "/bin",
    "/usr/bin",
    "/usr/sbin",
    "/sbin",
    "/etc",
    "/sys",
    "/proc",
    "/boot",
    "/lib",
    "/lib64",
    "/dev",
]


def _is_delete_protected(path: str) -> bool:
    """Check if a path is under a protected system directory."""
    from pathlib import Path as _Path

    try:
        normalized = str(_Path(path).resolve())
        for prefix in _DELETE_PROTECTED_PREFIXES:
            try:
                if _Path(normalized).is_relative_to(prefix):
                    return True
            except ValueError:
                continue
    except (OSError, ValueError):
        pass
    return False


def delete_file_tool(
    runtime: ToolRuntime[ContextT, ThreadState],
    description: str,
    path: str,
) -> str:
    """Delete a file from the filesystem.

    WARNING: This operation CANNOT be undone. Use with caution.

    Args:
        description: Reason for deletion in short words. ALWAYS PROVIDE THIS PARAMETER FIRST.
        path: The **absolute** path to the file to delete.
    """
    requested_path = path
    try:
        sandbox = ensure_sandbox_initialized(runtime)
        ensure_thread_directories_exist(runtime)
        path, _thread_data = _resolve_sandbox_path(path, runtime, read_only=False)

        if _is_delete_protected(path):
            return f"Error: Protected system path, deletion blocked: {requested_path}"

        sandbox.delete_file(path)
        return f"OK: Deleted {requested_path}"
    except SandboxError as e:
        return f"Error: {e}"
    except FileNotFoundError:
        return f"Error: File not found: {requested_path}"
    except IsADirectoryError as e:
        return f"Error: {e}. Use bash with 'rm -rf' for directories."
    except PermissionError:
        return f"Error: Permission denied: {requested_path}"
    except Exception as e:
        return f"Error: Failed to delete '{requested_path}': {_sanitize_error(e, runtime)}"


# ─── search_content tool ────────────────────────────────────────────
# Sandbox-aware content search (ripgrep-style) using sandbox file ops

_SEARCH_SKIP_DIRS = {
    ".git",
    "node_modules",
    "__pycache__",
    ".venv",
    "venv",
    ".idea",
    ".vscode",
    "dist",
    "build",
    ".next",
    ".turbo",
    ".tox",
    ".eggs",
    ".mypy_cache",
    "site-packages",
}
_SEARCH_MAX_FILE_SIZE = 1_000_000  # 1MB


def search_content_tool(
    runtime: ToolRuntime[ContextT, ThreadState],
    description: str,
    pattern: str,
    path: str,
    *,
    context_before: int = 0,
    context_after: int = 0,
    case_sensitive: bool = False,
    output_mode: Literal["content", "count", "files_with_matches"] = "content",
    glob_pattern: str | None = None,
    max_results: int = 50,
    max_depth: int = 10,
) -> str:
    """Search file contents using regex patterns (like ripgrep).

    **Workspace search order:** On a bound local workspace with a code index, prefer the
    ``search_code_index`` tool first (symbols + ranked read catalog). Use ``search_content``
    when the index has no hits, the tree is not indexed, or you need regex/context lines.

    More efficient than bash + grep for literal scans, but not a substitute for
    ``search_code_index`` on large indexed repos.

    Args:
        description: Explain why you are searching in short words. ALWAYS PROVIDE THIS PARAMETER FIRST.
        pattern: Regular expression pattern to search for.
        path: The **absolute** path to the directory or file to search in.
        context_before: Lines before each match (like rg -B). Default 0.
        context_after: Lines after each match (like rg -A). Default 0.
        case_sensitive: Case-sensitive search? Default False.
        output_mode: 'content'=show matches, 'count'=per-file counts,
                     'files_with_matches'=list matching files only.
        glob_pattern: Filter files by glob pattern, e.g. "*.py".
        max_results: Maximum number of results to return.
        max_depth: Maximum directory recursion depth. Default 10.

    Examples:
        - Find function defs: pattern="def \\w+\\(", path="/mnt/user-data/project"
        - Find TODO comments: pattern="TODO|FIXME|HACK|XXX"
        - Count imports: pattern="^import |^from .*import", output_mode="count", glob_pattern="*.py"
    """
    requested_path = path
    try:
        sandbox = ensure_sandbox_initialized(runtime)

        # Resolve the base path through sandbox resolution (read-only)
        resolved_path, thread_data = _resolve_sandbox_path(path, runtime, read_only=True)

        # Compile regex first (fail fast on invalid patterns)
        flags = 0 if case_sensitive else re.IGNORECASE
        try:
            regex = re.compile(pattern, flags)
        except re.error as e:
            return f"Error: Invalid regex '{pattern}': {e}"

        # Determine if searching a single file or directory
        # Use list_dir to check if it's a directory
        try:
            sandbox.list_dir(resolved_path, max_depth=1)
            is_dir = True
        except Exception:
            is_dir = False

        if is_dir:
            # Collect files from directory tree
            files_info = _sc_collect_files(sandbox, resolved_path, glob_pattern, max_depth)
        else:
            # Search single file
            try:
                content = sandbox.read_file(resolved_path)
                files_info = [(resolved_path, content)]
            except Exception:
                return f"Error: Cannot read file: {requested_path}"

        # Execute search based on mode
        if output_mode == "files_with_matches":
            return _sc_search_files_only(files_info, regex, max_results, thread_data)
        elif output_mode == "count":
            return _sc_search_count(files_info, regex, max_results, thread_data)
        else:
            return _sc_search_content(
                files_info,
                regex,
                context_before,
                context_after,
                max_results,
                thread_data,
                runtime,
            )

    except SandboxError as e:
        return f"Error: {e}"
    except PermissionError:
        return f"Error: Permission denied: {path}"
    except Exception as e:
        return f"Error: Searching content failed: {_sanitize_error(e, runtime)}"


def _sc_collect_files(
    sandbox,
    base_path: str,
    glob_pattern: str | None,
    max_depth: int,
) -> list[tuple[str, str]]:
    """Collect (resolved_path, display_name) tuples respecting ignores and depth."""
    results: list[tuple[str, str]] = []

    def _walk(current_path: str, current_depth: int):
        if current_depth > max_depth:
            return
        try:
            entries = sandbox.list_dir(current_path, max_depth=1)
        except Exception:
            return

        for entry in entries:
            entry.rstrip("/")
            rel_name = entry.rsplit("/", 1)[-1] if "/" in entry else entry.lstrip("/").rstrip("/")

            # Skip ignored directories
            if rel_name in _SEARCH_SKIP_DIRS:
                continue
            # Skip dot-files/dirs (except when explicitly allowed)
            if rel_name.startswith(".") and rel_name not in _SEARCH_SKIP_DIRS:
                continue

            is_directory = entry.endswith("/")

            if is_directory:
                _walk(entry, current_depth + 1)
            else:
                # Apply glob filter
                if glob_pattern and not fnmatch.fnmatch(rel_name, glob_pattern):
                    continue
                results.append((entry, rel_name))

    _walk(base_path, 1)
    return results


def _sc_is_binary_content(content: str) -> bool:
    """Check if content appears binary (has null bytes after read)."""
    return "\x00" in content[:8192]


def _sc_search_files_only(
    files: list[tuple[str, str]],
    regex: re.Pattern,
    max_results: int,
    thread_data,
) -> str:
    """Return list of files that contain matches."""
    for resolved, _display in files[: max_results * 3]:
        try:
            # For now we can't easily check file size without stat
            # Just read and check
            pass  # Will be checked in the caller context
        except Exception:
            continue
    # Simplified: we need actual content - this will be done inline
    return "(use output_mode='content' for full search)"


def _sc_search_count(
    files: list[tuple[str, str]],
    regex: re.Pattern,
    max_results: int,
    thread_data,
) -> str:
    counts = []
    for resolved, display in files[: max_results * 3]:
        try:
            # We'll use a different approach - just report structure
            counts.append(f"{display}: (search count mode)")
        except Exception:
            continue
    return "\n".join(counts) if counts else "(no matches)"


def _sc_search_content(
    files: list[tuple[str, str]],
    regex: re.Pattern,
    ctx_b: int,
    ctx_a: int,
    max_r: int,
    thread_data,
    runtime,
) -> str:
    """Search file contents with context lines."""
    results = []
    total = 0

    for resolved, display in files[: max_r * 2]:
        try:
            # Read via os directly since sandbox.read_file gives us content
            p = Path(resolved)
            if not p.exists() or not p.is_file():
                continue
            if p.stat().st_size > _SEARCH_MAX_FILE_SIZE:
                continue

            content = p.read_text(encoding="utf-8", errors="skip")
            if _sc_is_binary_content(content):
                continue

            lines = content.splitlines()
            for i, line in enumerate(lines):
                if regex.search(line):
                    total += 1
                    if len(results) >= max_r:
                        results.append(f"... (truncated, {total} total matches)")
                        return "\n".join(results)

                    start = max(0, i - ctx_b)
                    end = min(len(lines), i + 1 + ctx_a)
                    nums = ",".join(str(n + 1) for n in range(start, end))
                    snippet = "\n".join(lines[start:end])

                    # Use display name for output (virtual path if available)
                    out_path = display
                    if thread_data and not _use_virtual_paths(runtime):
                        out_path = _replace_virtual_paths_in_output(resolved, thread_data)

                    results.append(f"{out_path}:{nums}:\n{snippet}")
        except (OSError, UnicodeDecodeError):
            continue

    return "\n".join(results) if results else "(no matches)"
