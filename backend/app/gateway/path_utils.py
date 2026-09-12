"""Shared path resolution for thread virtual paths (e.g. mnt/user-data/outputs/...)."""

from pathlib import Path

from fastapi import HTTPException

from evoflow.config.paths import get_paths


def resolve_thread_virtual_path(thread_id: str, virtual_path: str) -> Path:
    """Resolve a virtual path to the actual filesystem path under thread user-data.

    Args:
        thread_id: The thread ID.
        virtual_path: The virtual path as seen inside the sandbox
                      (e.g., /mnt/user-data/outputs/file.txt).

    Returns:
        The resolved filesystem path.

    Raises:
        HTTPException: If the path is invalid or outside allowed directories.
    """
    try:
        raw = str(virtual_path or "")
        stripped = raw.lstrip("/")
        # Accept short forms produced by UI/tools: "outputs/..." or "workspace/..."
        if stripped == "outputs" or stripped.startswith("outputs/") or stripped == "workspace" or stripped.startswith("workspace/"):
            raw = f"/mnt/user-data/{stripped}"
        # Also accept "mnt/user-data/..." without leading slash (common in URL paths)
        elif stripped == "mnt/user-data" or stripped.startswith("mnt/user-data/"):
            raw = f"/{stripped}"
        return get_paths().resolve_virtual_path(thread_id, raw)
    except ValueError as e:
        status = 403 if "traversal" in str(e) else 400
        raise HTTPException(status_code=status, detail=str(e))
