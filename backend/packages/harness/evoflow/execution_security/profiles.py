"""PermissionProfile JSON builders for OS sandbox helpers.

Serializes managed/disabled profile shapes consumed by the Linux/Windows
sandbox helper binaries (no Python↔Rust bridge).
"""

from __future__ import annotations

import json
from typing import Any, Literal

PermissionProfileId = Literal["read-only", "workspace", "danger-full-access"]

PROFILE_READ_ONLY = "read-only"
PROFILE_WORKSPACE = "workspace"
PROFILE_DANGER_FULL_ACCESS = "danger-full-access"

# Wire id strings (colon prefix).
_WIRE_PROFILE_ID = {
    PROFILE_READ_ONLY: ":read-only",
    PROFILE_WORKSPACE: ":workspace",
    PROFILE_DANGER_FULL_ACCESS: ":danger-full-access",
}

_ALIASES = {
    "read_only": PROFILE_READ_ONLY,
    "readonly": PROFILE_READ_ONLY,
    ":read-only": PROFILE_READ_ONLY,
    "workspace_write": PROFILE_WORKSPACE,
    "workspace-write": PROFILE_WORKSPACE,
    ":workspace": PROFILE_WORKSPACE,
    "full_access": PROFILE_DANGER_FULL_ACCESS,
    "danger-full-access": PROFILE_DANGER_FULL_ACCESS,
    "danger_full_access": PROFILE_DANGER_FULL_ACCESS,
    ":danger-full-access": PROFILE_DANGER_FULL_ACCESS,
}


def normalize_profile_id(raw: str | None) -> PermissionProfileId:
    s = str(raw or "").strip().lower()
    if not s:
        return PROFILE_WORKSPACE
    s = _ALIASES.get(s, s)
    if s in (PROFILE_READ_ONLY, PROFILE_WORKSPACE, PROFILE_DANGER_FULL_ACCESS):
        return s  # type: ignore[return-value]
    return PROFILE_WORKSPACE


def wire_profile_id(profile: PermissionProfileId | str) -> str:
    pid = normalize_profile_id(profile)
    return _WIRE_PROFILE_ID[pid]


def codex_profile_id(profile: PermissionProfileId | str) -> str:
    """Deprecated alias for ``wire_profile_id``."""
    return wire_profile_id(profile)


def _special(kind: str, *, subpath: str | None = None) -> dict[str, Any]:
    value: dict[str, Any] = {"kind": kind}
    if subpath is not None:
        value["subpath"] = subpath
    return {"type": "special", "value": value}


def _entry(path: dict[str, Any], access: str) -> dict[str, Any]:
    return {"path": path, "access": access}


def _read_only_profile() -> dict[str, Any]:
    return {
        "type": "managed",
        "file_system": {
            "type": "restricted",
            "entries": [_entry(_special("root"), "read")],
        },
        "network": "restricted",
    }


def _workspace_profile() -> dict[str, Any]:
    """Workspace-write special-path defaults for the sandbox helper."""
    entries = [
        _entry(_special("root"), "read"),
        _entry(_special("project_roots"), "write"),
        _entry(_special("slash_tmp"), "write"),
        _entry(_special("tmpdir"), "write"),
        _entry(_special("project_roots", subpath=".git"), "read"),
        _entry(_special("project_roots", subpath=".agents"), "read"),
        _entry(_special("project_roots", subpath=".codex"), "read"),
    ]
    return {
        "type": "managed",
        "file_system": {
            "type": "restricted",
            "entries": entries,
        },
        "network": "restricted",
    }


def _danger_full_access_profile() -> dict[str, Any]:
    return {"type": "disabled"}


def build_permission_profile_json(
    profile: PermissionProfileId | str = PROFILE_WORKSPACE,
) -> dict[str, Any]:
    pid = normalize_profile_id(profile)
    if pid == PROFILE_READ_ONLY:
        return _read_only_profile()
    if pid == PROFILE_DANGER_FULL_ACCESS:
        return _danger_full_access_profile()
    return _workspace_profile()


def permission_profile_to_json_str(
    profile: PermissionProfileId | str = PROFILE_WORKSPACE,
) -> str:
    return json.dumps(build_permission_profile_json(profile), separators=(",", ":"))
