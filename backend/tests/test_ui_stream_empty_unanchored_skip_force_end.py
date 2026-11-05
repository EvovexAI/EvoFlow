"""Empty unanchored run_end must not mark the session idle (false「未产生」)."""

from __future__ import annotations

from unittest.mock import patch

from app.gateway.sse_ui_normalize import UiStreamNormalizer


def test_empty_unanchored_run_end_skips_force_end() -> None:
    norm = UiStreamNormalizer(thread_id="thread-empty-unanchored", anchored=False)
    assert norm.anchored is False
    assert not str(norm.final_text or "").strip()
    with patch("evoflow.session_execution.force_end_session_turn") as force_end:
        norm._touch_run_ended_from_stream()
        force_end.assert_not_called()


def test_anchored_or_text_run_end_still_force_ends() -> None:
    norm = UiStreamNormalizer(thread_id="thread-anchored", anchored=True)
    norm.final_text = "hello"
    with patch("evoflow.session_execution.force_end_session_turn") as force_end:
        norm._touch_run_ended_from_stream()
        force_end.assert_called_once()
