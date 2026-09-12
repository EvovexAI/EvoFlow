"""EvoPanel 界面外观：panel.ui 子集（主题 / 色卡 / 背景 / 液态玻璃）。"""

from __future__ import annotations

import re
from typing import Any

from evoflow.admin.errors import ValidationError

_APPEARANCE_KEYS = (
    "theme",
    "fontSize",
    "fontScale",
    "accentPalette",
    "accentCustom",
    "backgroundImage",
    "backgroundOpacity",
    "liquidGlassEnabled",
    "liquidGlassPreset",
    "liquidGlassBlur",
    "liquidGlassFlowSpeed",
    "liquidGlassReadabilityDim",
)

_THEMES = frozenset({"light", "dark", "system"})
_ACCENT_PALETTES = frozenset(
    {"default", "blue", "violet", "cyan", "emerald", "amber", "rose", "slate", "custom"}
)
_LG_PRESETS = frozenset({"aurora", "deep-sea", "ember", "minimal", "aquarium"})
_FONT_SIZES = frozenset({"small", "medium", "large", "extra-large"})
_HEX_RE = re.compile(r"^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$")


def appearance_options_catalog() -> dict[str, Any]:
    return {
        "themes": ["light", "dark", "system"],
        "accentPalettes": sorted(_ACCENT_PALETTES),
        "liquidGlassPresets": sorted(_LG_PRESETS),
        "fontSizes": sorted(_FONT_SIZES),
        "backgroundImage": (
            "本地绝对路径、相对路径、http(s) URL，或空字符串清除；"
            "桌面端本地图片/视频路径会由客户端解析显示"
        ),
        "backgroundOpacity": "0.05–1",
        "liquidGlassBlur": "0–40",
        "liquidGlassFlowSpeed": "0.1–3",
        "liquidGlassReadabilityDim": "0–90",
    }


def _clamp(value: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, value))


def _normalize_hex(value: str) -> str:
    raw = str(value or "").strip()
    if not _HEX_RE.match(raw):
        raise ValidationError(f"accentCustom must be a hex color, got: {raw!r}")
    if len(raw) == 4:
        r, g, b = raw[1], raw[2], raw[3]
        return f"#{r}{r}{g}{g}{b}{b}".lower()
    return raw.lower()


def _validate_patch(patch: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for key, value in patch.items():
        if key not in _APPEARANCE_KEYS:
            continue
        if key == "theme":
            v = str(value or "").strip().lower()
            if v not in _THEMES:
                raise ValidationError(f"theme must be one of {sorted(_THEMES)}")
            out[key] = v
        elif key == "accentPalette":
            v = str(value or "").strip().lower()
            if v not in _ACCENT_PALETTES:
                raise ValidationError(f"accentPalette must be one of {sorted(_ACCENT_PALETTES)}")
            out[key] = v
        elif key == "accentCustom":
            out[key] = _normalize_hex(str(value))
        elif key == "fontSize":
            v = str(value or "").strip().lower()
            if v not in _FONT_SIZES:
                raise ValidationError(f"fontSize must be one of {sorted(_FONT_SIZES)}")
            out[key] = v
        elif key == "fontScale":
            out[key] = _clamp(float(value), 0.75, 1.5)
        elif key == "backgroundImage":
            out[key] = str(value or "").strip()
        elif key == "backgroundOpacity":
            out[key] = _clamp(float(value), 0.05, 1.0)
        elif key == "liquidGlassEnabled":
            out[key] = bool(value) if isinstance(value, bool) else str(value).strip().lower() not in {
                "0",
                "false",
                "no",
                "off",
                "",
            }
        elif key == "liquidGlassPreset":
            v = str(value or "").strip().lower()
            if v not in _LG_PRESETS:
                raise ValidationError(f"liquidGlassPreset must be one of {sorted(_LG_PRESETS)}")
            out[key] = v
        elif key == "liquidGlassBlur":
            out[key] = int(_clamp(float(value), 0, 40))
        elif key == "liquidGlassFlowSpeed":
            out[key] = round(_clamp(float(value), 0.1, 3.0), 2)
        elif key == "liquidGlassReadabilityDim":
            out[key] = int(_clamp(float(value), 0, 90))
        else:
            out[key] = value
    return out


def build_appearance_patch_from_args(args: dict[str, Any]) -> dict[str, Any]:
    raw: dict[str, Any] = {}
    for key in _APPEARANCE_KEYS:
        if key in args and args[key] is not None:
            raw[key] = args[key]

    # 别名 / 嵌套
    if args.get("settings") and isinstance(args["settings"], dict):
        for key in _APPEARANCE_KEYS:
            if key in args["settings"] and args["settings"][key] is not None:
                raw[key] = args["settings"][key]

    for alias, target in (
        ("background_path", "backgroundImage"),
        ("backgroundMediaPath", "backgroundImage"),
        ("background_image", "backgroundImage"),
        ("media_path", "backgroundImage"),
        ("liquid_glass_enabled", "liquidGlassEnabled"),
        ("liquid_glass_preset", "liquidGlassPreset"),
        ("liquid_glass_blur", "liquidGlassBlur"),
        ("liquid_glass_flow_speed", "liquidGlassFlowSpeed"),
        ("liquid_glass_readability_dim", "liquidGlassReadabilityDim"),
        ("accent_palette", "accentPalette"),
        ("accent_custom", "accentCustom"),
        ("background_opacity", "backgroundOpacity"),
    ):
        if alias in args and args[alias] is not None and target not in raw:
            raw[target] = args[alias]

    clear_bg = args.get("clearBackground") or args.get("clear_background")
    if clear_bg is True or str(clear_bg or "").strip().lower() in {"1", "true", "yes"}:
        raw["backgroundImage"] = ""

    return _validate_patch(raw)


def get_appearance_snapshot() -> dict[str, Any]:
    from evoflow.persistence.panel_settings import get_panel_settings

    settings = get_panel_settings()
    return {k: settings.get(k) for k in _APPEARANCE_KEYS if k in settings}


def get_appearance_state() -> dict[str, Any]:
    return {
        "ok": True,
        "settings": get_appearance_snapshot(),
        "options": appearance_options_catalog(),
    }


def patch_appearance(args: dict[str, Any]) -> dict[str, Any]:
    patch = build_appearance_patch_from_args(args)
    if not patch:
        raise ValidationError(
            "no appearance fields provided; use theme, accentPalette, backgroundImage, "
            "liquidGlassEnabled, liquidGlassPreset, backgroundOpacity, etc."
        )
    from evoflow.persistence.panel_settings import patch_panel_settings

    merged = patch_panel_settings(patch)
    applied = {k: merged[k] for k in patch}
    return {
        "ok": True,
        "settings": applied,
        "client_effect": "panel_settings",
        "hint": "客户端将自动应用外观变更，无需用户手动打开设置页。",
    }
