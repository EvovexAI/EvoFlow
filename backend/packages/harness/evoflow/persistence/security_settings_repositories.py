"""Security center configuration stored in ``evoflow_app_settings`` (key ``security.center``).

Host path today mainly uses:
  - command_security allow/prompt prefixes (terminal approval)
  - system_tools blocked prefixes
File/network lists are kept for API compat but are not enforced on host_direct.
"""

from __future__ import annotations

import copy
import time
from typing import Any

from evoflow.persistence import config_repositories as cfg_repo

SECURITY_SETTINGS_KEY = "security.center"

# ── TTL cache (avoids DB read on every tool call) ────────────
_CACHE_TTL = 5.0  # seconds
_cache_data: dict[str, Any] | None = None
_cache_ts: float = 0.0

DEFAULT_SECURITY_SETTINGS: dict[str, Any] = {
    "sandbox": {
        "enabled": True,
        # Path allow/deny lists are not enforced on host_direct; kept for API compat only.
        "file_security": {
            "whitelist": [],
            "blacklist": [],
        },
        "command_security": {
            "allow_prefixes": [
                "ls",
                "dir",
                "cat",
                "pwd",
                "head",
                "tail",
                "wc",
                "git status",
                "git diff",
                "git log",
                "git branch",
            ],
            "prompt_prefixes": [
                "echo",
                "rm",
                "rmdir",
                "remove-item",
                "del",
                "curl",
                "wget",
                "npm install",
                "pip install",
                "docker",
                "chmod",
                "chown",
                "kill",
                "shutdown",
                "reboot",
                "format",
            ],
        },
        # Domain lists are not enforced on host_direct; kept for API compat only.
        "network_security": {
            "allowed_domains": [],
            "blocked_domains": [],
        },
    },
    "data_security": {
        "security_gateway": True,
        "transport_encryption": True,
    },
    "system_tools": {
        "enabled": False,
        "blocked_tools": [
            "wsl",
            "wmic",
            "sc",
            "reg",
            "schtasks",
            "netsh",
            "diskpart",
            "format",
        ],
    },
    "builtin_runtime": {
        "python": {"enabled": True, "path": "", "version": ""},
        "node": {"enabled": True, "path": "", "version": ""},
        "git_bash": {"enabled": True, "path": "", "version": ""},
    },
}


def _deep_merge_defaults(raw: Any) -> dict[str, Any]:
    """Merge user-stored settings over defaults, preserving new keys."""
    base = copy.deepcopy(DEFAULT_SECURITY_SETTINGS)
    if not isinstance(raw, dict):
        return base
    for k, v in raw.items():
        if k not in base:
            base[k] = v
            continue
        if isinstance(base[k], dict) and isinstance(v, dict):
            for sk, sv in v.items():
                if isinstance(base[k].get(sk), dict) and isinstance(sv, dict):
                    base[k][sk] = {**(base[k].get(sk) or {}), **sv}
                else:
                    base[k][sk] = sv
        else:
            base[k] = v
    return base


def _invalidate_cache() -> None:
    """Invalidate the TTL cache — called after any write."""
    global _cache_data, _cache_ts
    _cache_data = None
    _cache_ts = 0.0


def get_security_settings() -> dict[str, Any]:
    """Return the full security-center config (merged with defaults).

    Uses a short TTL cache to avoid DB reads on every tool call.
    """
    global _cache_data, _cache_ts
    now = time.monotonic()
    if _cache_data is not None and (now - _cache_ts) < _CACHE_TTL:
        return _cache_data
    raw = cfg_repo.get_app_setting(SECURITY_SETTINGS_KEY)
    _cache_data = _deep_merge_defaults(raw)
    _cache_ts = now
    return _cache_data


def patch_security_settings(patch: dict[str, Any] | None) -> dict[str, Any]:
    """Deep-merge a partial patch into the stored security config."""
    if not isinstance(patch, dict) or not patch:
        return get_security_settings()
    current = get_security_settings()

    def _deep_merge(base: dict[str, Any], updates: dict[str, Any]) -> dict[str, Any]:
        for k, v in updates.items():
            if isinstance(v, dict) and isinstance(base.get(k), dict):
                _deep_merge(base[k], v)
            else:
                base[k] = v
        return base

    _deep_merge(current, patch)
    cfg_repo.set_app_setting(SECURITY_SETTINGS_KEY, current)
    _invalidate_cache()
    return current


def replace_security_settings(settings: dict[str, Any]) -> dict[str, Any]:
    """Replace the entire security-center config (still merged with defaults)."""
    merged = _deep_merge_defaults(settings)
    cfg_repo.set_app_setting(SECURITY_SETTINGS_KEY, merged)
    _invalidate_cache()
    return merged
