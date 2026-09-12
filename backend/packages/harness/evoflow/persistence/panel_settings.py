"""EvoPanel UI preferences in ``evoflow_app_settings``.

Per-principal key: ``panel.ui:<principal_id>``.
Legacy global key ``panel.ui`` is used only when no principal is resolved
(local single-user), or as a one-time seed when a principal's key is empty.
"""

from __future__ import annotations

import copy
from typing import Any

from evoflow.persistence import config_repositories as cfg_repo

PANEL_SETTINGS_KEY = "panel.ui"

DEFAULT_PANEL_SETTINGS: dict[str, Any] = {
    "theme": "system",
    "useVirtualPaths": False,
    "memoryEnabledDefault": True,
    "knowledgeMapEnabled": True,
    "shellAsideCollapsed": False,
    "sidebarCollapsed": False,
    "hostedProposeAction": "ask",
    "locale": "",
    "lastSelectedModel": "",
    "email": {},
    "userWorkspaceRoot": "",
    "workspaceIndexWatchEnabled": False,
    "defaultVisionModel": "",
    "imageInputMode": "auto",
    "keyboardShortcuts": {},
    "writeStreamMode": "off",
    "accentPalette": "default",
    "accentCustom": "#6366f1",
    "backgroundImage": "",
    "backgroundOpacity": 0.35,
    "liquidGlassEnabled": False,
    "liquidGlassPreset": "aurora",
    "liquidGlassBlur": 14,
    "liquidGlassFlowSpeed": 0.55,
    "liquidGlassReadabilityDim": 36,
}


def _panel_key(principal_id: str | None) -> str:
    pid = str(principal_id or "").strip()
    if not pid:
        return PANEL_SETTINGS_KEY
    return f"{PANEL_SETTINGS_KEY}:{pid}"


def _deep_merge_defaults(raw: Any) -> dict[str, Any]:
    base = copy.deepcopy(DEFAULT_PANEL_SETTINGS)
    if not isinstance(raw, dict):
        return base
    for k, v in raw.items():
        if k not in base:
            base[k] = v
            continue
        if k == "email" and isinstance(v, dict):
            base["email"] = {**(base.get("email") or {}), **v}
        else:
            base[k] = v
    return base


def get_panel_settings(principal_id: str | None = None) -> dict[str, Any]:
    key = _panel_key(principal_id)
    raw = cfg_repo.get_app_setting(key)
    # One-time seed from legacy global for first login under a principal.
    if (not isinstance(raw, dict) or not raw) and principal_id:
        legacy = cfg_repo.get_app_setting(PANEL_SETTINGS_KEY)
        if isinstance(legacy, dict) and legacy:
            raw = legacy
    return _deep_merge_defaults(raw)


def patch_panel_settings(
    patch: dict[str, Any] | None,
    *,
    principal_id: str | None = None,
) -> dict[str, Any]:
    if not isinstance(patch, dict) or not patch:
        return get_panel_settings(principal_id)
    current = get_panel_settings(principal_id)
    for k, v in patch.items():
        if k == "email" and isinstance(v, dict):
            prev = current.get("email") if isinstance(current.get("email"), dict) else {}
            current["email"] = {**prev, **v}
        else:
            current[k] = v
    cfg_repo.set_app_setting(_panel_key(principal_id), current)
    return current


def replace_panel_settings(
    settings: dict[str, Any],
    *,
    principal_id: str | None = None,
) -> dict[str, Any]:
    merged = _deep_merge_defaults(settings)
    cfg_repo.set_app_setting(_panel_key(principal_id), merged)
    return merged
