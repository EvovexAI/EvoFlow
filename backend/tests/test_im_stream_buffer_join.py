"""IM stream cards must not wipe when a new assistant message-id starts."""

from __future__ import annotations

from app.channels.manager import (
    _join_im_stream_buffers,
    _latest_im_stream_buffer,
    _should_skip_im_stream_regression,
)


def test_join_keeps_prior_segments() -> None:
    buffers = {
        "m1": "这是一幅很长的画面描述……",
        "m2": "图",
    }
    joined = _join_im_stream_buffers(buffers)
    assert joined.startswith("这是一幅很长的画面描述")
    assert joined.endswith("图")
    assert "\n\n" in joined


def test_latest_buffer_is_final_reply_only() -> None:
    # Real Feishu turn: many mid-tool status bubbles + one final answer.
    buffers = {
        "m1": "已提交，正在下载并分析。",
        "m2": "下载完成（11 MB），正在抽帧和转写。",
        "m3": "等视觉理解跑完。",
        "m4": "分析仍在视觉理解阶段……\n\n分析完成后我会直接汇报。",
    }
    assert _latest_im_stream_buffer(buffers) == buffers["m4"]
    assert "已提交" not in _latest_im_stream_buffer(buffers)
    assert _latest_im_stream_buffer({"a": "", "b": "  ", "c": "ok"}) == "ok"
    assert _latest_im_stream_buffer({}) == ""


def test_skip_regression_on_new_short_message() -> None:
    prev = "这是一幅充满东方古典意境的唯美摄影作品，画面整体笼罩在黄昏时分。"
    assert _should_skip_im_stream_regression(prev, "![")
    # Shares a prefix with ``prev`` but is still a wipe — must skip.
    assert _should_skip_im_stream_regression(prev, "这是一")
    assert not _should_skip_im_stream_regression(prev, prev + "继续写")
    # Tiny shrink / correction — allow.
    assert not _should_skip_im_stream_regression(prev, prev[:-1])
    assert not _should_skip_im_stream_regression("", "hello")
