"""Unified media generation (Jimeng, Kling, DashScope Wan).

Tool callables live in ``evoflow.community.media_generation.tools`` — not re-exported here
to avoid import cycles when skill scripts load ``config_helpers`` only.
"""

from __future__ import annotations

from typing import Any

__all__ = [
    "media_image_generate_tool",
    "media_video_generate_tool",
    "media_task_wait_tool",
    "media_voiceover_synthesize_tool",
    "media_subtitle_build_tool",
    "media_subtitle_burn_tool",
    "media_subtitle_extract_tool",
]

_LAZY_TOOL_EXPORTS = {
    "media_image_generate_tool",
    "media_video_generate_tool",
    "media_task_wait_tool",
    "media_voiceover_synthesize_tool",
    "media_subtitle_build_tool",
    "media_subtitle_burn_tool",
    "media_subtitle_extract_tool",
}


def __getattr__(name: str) -> Any:
    if name in _LAZY_TOOL_EXPORTS:
        from evoflow.community.media_generation import tools as _tools

        return getattr(_tools, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
