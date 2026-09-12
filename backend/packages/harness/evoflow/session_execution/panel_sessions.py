"""Heuristics for EvoPanel-attached chat sessions vs IM channel sessions."""

from __future__ import annotations

# Keep in sync with app.channels.manager.IM_CHANNEL_NAMES
IM_CHANNEL_SEGMENT_NAMES = frozenset({"feishu", "slack", "telegram", "weixin"})


def is_panel_attached_session_key(session_key: str | None) -> bool:
    """True when session belongs to EvoPanel (not an IM channel thread)."""
    sk = str(session_key or "").strip()
    if not sk:
        return False
    parts = sk.split(":")
    if len(parts) >= 3 and parts[0] == "agent":
        channel_segment = str(parts[2] or "").strip().lower()
        if channel_segment in IM_CHANNEL_SEGMENT_NAMES:
            return False
    return True
