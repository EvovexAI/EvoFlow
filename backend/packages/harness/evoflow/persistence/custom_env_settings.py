"""User-defined environment variables in ``evoflow_app_settings`` (key ``runtime.customEnv``)."""

from __future__ import annotations

import copy
import os
import re
from typing import Any

from evoflow.persistence import config_repositories as cfg_repo

CUSTOM_ENV_KEY = "runtime.customEnv"
_ENV_KEY_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")

DEFAULT_CUSTOM_ENV: dict[str, Any] = {"vars": []}


def _normalize_vars(raw: Any) -> list[dict[str, str]]:
    if not isinstance(raw, list):
        return []
    out: list[dict[str, str]] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        key = str(item.get("key") or "").strip()
        if not key or not _ENV_KEY_RE.match(key):
            continue
        out.append({"key": key, "value": str(item.get("value") or "")})
    return out


def get_custom_env_settings() -> dict[str, Any]:
    raw = cfg_repo.get_app_setting(CUSTOM_ENV_KEY)
    base = copy.deepcopy(DEFAULT_CUSTOM_ENV)
    if isinstance(raw, dict):
        base["vars"] = _normalize_vars(raw.get("vars"))
    return base


def get_custom_env_dict() -> dict[str, str]:
    return {v["key"]: v["value"] for v in get_custom_env_settings().get("vars", []) if v.get("key")}


def _mask_value(value: str) -> str:
    s = str(value or "")
    if not s:
        return ""
    if len(s) <= 4:
        return "****"
    return "*" * min(len(s) - 4, 12) + s[-4:]


def get_custom_env_settings_masked() -> dict[str, Any]:
    settings = get_custom_env_settings()
    masked_vars: list[dict[str, str]] = []
    for item in settings.get("vars", []):
        val = str(item.get("value") or "")
        masked_vars.append(
            {
                "key": item["key"],
                "value": _mask_value(val) if val else "",
                "configured": bool(val),
            }
        )
    return {"vars": masked_vars}


def replace_custom_env_vars(vars_list: list[dict[str, Any]] | None) -> dict[str, Any]:
    normalized = _normalize_vars(vars_list or [])
    payload = {"vars": normalized}
    cfg_repo.set_app_setting(CUSTOM_ENV_KEY, payload)
    return payload


def apply_custom_env_to_mapping(env: dict[str, str]) -> None:
    """Overlay user custom env vars onto a child-process env dict."""
    for key, value in get_custom_env_dict().items():
        env[key] = value


def apply_custom_env_to_environ() -> None:
    apply_custom_env_to_mapping(os.environ)
