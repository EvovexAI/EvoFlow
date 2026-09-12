"""Delete file — direct filesystem access with safety guards."""

from pathlib import Path

from langchain.tools import ToolRuntime, tool

from evoflow.tools.host_direct.workspace_path_guard import resolve_tool_path
from evoflow.tools.minimal_schema import DELETE_TOOL_DESCRIPTION

# Paths that should never be deleted via this tool (normalized lowercase)
_PROTECTED_PREFIXES = {
    "/windows",
    "/program files",
    "/program files (x86)",
    "/programdata",
    "/users/all users",
    "/users/default",
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
}


def _is_protected(path: str) -> bool:
    """Check if path is under a protected system directory."""
    try:
        normalized = str(Path(path).resolve()).lower()
        for prefix in _PROTECTED_PREFIXES:
            if normalized.startswith(prefix.lower()):
                return True
    except (OSError, ValueError):
        pass
    return False


@tool("delete", description=DELETE_TOOL_DESCRIPTION, parse_docstring=False)
def delete_file_hd(
    path: str,
    *,
    reason: str = "",
    runtime: ToolRuntime,
) -> str:
    """Delete a file from the local filesystem."""
    resolved = resolve_tool_path(path, runtime=runtime, must_exist=True, must_be_file=True)
    if isinstance(resolved, str):
        return resolved
    try:
        p = resolved

        if not p.exists():
            return f"Error: File not found: {path}"

        if not p.is_file():
            return f"Error: Not a file (directory?): {path}. Use terminal 'rm -rf' for directories."

        if _is_protected(path):
            return f"Error: Protected system path, deletion blocked: {path}"

        size = p.stat().st_size
        p.unlink()

        result = f"OK: Deleted {path} ({size} bytes)"
        from evoflow.code_index.hooks import notify_tool_result

        notify_tool_result(path, result, runtime=runtime, deleted=True)
        return result

    except PermissionError:
        return f"Error: Permission denied: {path}"
    except Exception as e:
        return f"Error: Failed to delete '{path}': {e}"
