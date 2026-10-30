"""IM stream cards must not wipe when a new assistant message-id starts."""

from __future__ import annotations

from app.channels.manager import _join_im_stream_buffers, _should_skip_im_stream_regression


def test_join_keeps_prior_segments() -> None:
    buffers = {
        "m1": "这是一幅很长的画面描述……",
        "m2": "图",
    }
    joined = _join_im_stream_buffers(buffers)
    assert joined.startswith("这是一幅很长的画面描述")
    assert joined.endswith("图")
    assert "\n\n" in joined


def test_skip_regression_on_new_short_message() -> None:
    prev = "这是一幅充满东方古典意境的唯美摄影作品，画面整体笼罩在黄昏时分。"
    assert _should_skip_im_stream_regression(prev, "![")
    # Shares a prefix with ``prev`` but is still a wipe — must skip.
    assert _should_skip_im_stream_regression(prev, "这是一")
    assert not _should_skip_im_stream_regression(prev, prev + "继续写")
    # Tiny shrink / correction — allow.
    assert not _should_skip_im_stream_regression(prev, prev[:-1])
    assert not _should_skip_im_stream_regression("", "hello")
