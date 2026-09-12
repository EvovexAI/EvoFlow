"""Image input routing for user uploads and ``view_image`` (Hermes-style auto / native-style native)."""

from __future__ import annotations

from typing import Literal

from evoflow.tools.builtins.vision_analysis_core import main_model_supports_vision

ImageInputMode = Literal["auto", "native", "text"]
ViewImageRoute = Literal["native", "text"]


def get_image_input_mode() -> ImageInputMode:
    """Panel setting ``imageInputMode``: auto (default) | native | text."""
    from evoflow.persistence.panel_settings import get_panel_settings

    raw = str(get_panel_settings().get("imageInputMode") or "auto").strip().lower()
    if raw in ("native", "text"):
        return raw  # type: ignore[return-value]
    return "auto"


def decide_view_image_route(*, runtime: object | None) -> ViewImageRoute:
    """Pick native pixel staging vs auxiliary vision text summary."""
    mode = get_image_input_mode()
    supports = main_model_supports_vision(runtime)

    if mode == "text":
        return "text"
    if mode == "native":
        return "native" if supports else "text"
    # auto — Hermes default: native when main model supports vision
    return "native" if supports else "text"
