"""Wan 2.6 / 2.7 request-body routing (no live DashScope calls)."""

from __future__ import annotations

from unittest.mock import patch

import pytest


@pytest.fixture(autouse=True)
def _fake_dashscope_key(monkeypatch):
    from evoflow.community.media_generation.providers import dashscope_wan

    monkeypatch.setattr(dashscope_wan, "dashscope_api_key", lambda: "sk-test-fake")
    monkeypatch.setattr(
        dashscope_wan,
        "dashscope_base_url",
        lambda: "https://dashscope.aliyuncs.com/api/v1",
    )


def test_wan27_image_sync_multimodal_body():
    from evoflow.community.media_generation.providers import dashscope_wan

    captured: dict = {}

    def fake_request(method, path, body=None, *, async_enable=True, resolve_oss=False):
        captured["method"] = method
        captured["path"] = path
        captured["body"] = body
        captured["async_enable"] = async_enable
        return {
            "output": {
                "choices": [
                    {
                        "finish_reason": "stop",
                        "message": {
                            "role": "assistant",
                            "content": [{"type": "image", "image": "https://cdn.example/a.png"}],
                        },
                    }
                ],
                "finished": True,
            }
        }

    with patch.object(dashscope_wan, "_request", side_effect=fake_request):
        tid = dashscope_wan.submit_image(
            prompt="一只猫",
            mode="text2image",
            model="wan2.7-image",
            aspect_ratio="1:1",
        )

    assert tid == "immediate:https://cdn.example/a.png"
    assert captured["path"] == "/services/aigc/multimodal-generation/generation"
    assert captured["async_enable"] is False
    assert captured["body"]["model"] == "wan2.7-image"
    content = captured["body"]["input"]["messages"][0]["content"]
    assert any(c.get("text") == "一只猫" for c in content)


def test_wan26_image_legacy_async_body():
    from evoflow.community.media_generation.providers import dashscope_wan

    captured: dict = {}

    def fake_request(method, path, body=None, *, async_enable=True, resolve_oss=False):
        captured["path"] = path
        captured["body"] = body
        captured["async_enable"] = async_enable
        return {"output": {"task_id": "task-legacy-1"}}

    with patch.object(dashscope_wan, "_request", side_effect=fake_request):
        tid = dashscope_wan.submit_image(
            prompt="一只狗",
            mode="text2image",
            model="wan2.6-t2i",
        )

    assert tid == "task-legacy-1"
    assert captured["path"] == "/services/aigc/text2image/image-synthesis"
    assert captured["async_enable"] is True
    assert captured["body"]["input"]["prompt"] == "一只狗"


def test_wan27_video_media_array():
    from evoflow.community.media_generation.providers import dashscope_wan

    captured: dict = {}

    def fake_request(method, path, body=None, *, async_enable=True, resolve_oss=False):
        captured["path"] = path
        captured["body"] = body
        captured["async_enable"] = async_enable
        return {"output": {"task_id": "task-v27-1"}}

    with patch.object(dashscope_wan, "_request", side_effect=fake_request):
        tid = dashscope_wan.submit_video(
            prompt="镜头推进",
            mode="image2video",
            first_frame_url="https://cdn.example/frame.png",
            last_frame_url="https://cdn.example/last.png",
            audio_url="https://cdn.example/a.mp3",
            model="wan2.7-i2v",
            duration=8,
            resolution="720p",
        )

    assert tid == "task-v27-1"
    assert captured["async_enable"] is True
    media = captured["body"]["input"]["media"]
    types = [m["type"] for m in media]
    assert types == ["first_frame", "last_frame", "driving_audio"]
    assert "img_url" not in captured["body"]["input"]
    assert captured["body"]["parameters"]["resolution"] == "720P"


def test_wan26_video_img_url():
    from evoflow.community.media_generation.providers import dashscope_wan

    captured: dict = {}

    def fake_request(method, path, body=None, *, async_enable=True, resolve_oss=False):
        captured["body"] = body
        return {"output": {"task_id": "task-v26-1"}}

    with patch.object(dashscope_wan, "_request", side_effect=fake_request):
        tid = dashscope_wan.submit_video(
            prompt="镜头推进",
            mode="image2video",
            first_frame_url="https://cdn.example/frame.png",
            model="wan2.6-i2v",
        )

    assert tid == "task-v26-1"
    assert captured["body"]["input"]["img_url"] == "https://cdn.example/frame.png"
    assert "media" not in captured["body"]["input"]
