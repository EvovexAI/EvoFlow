"""Unit tests for OpenAI-compatible platform model invoke helpers."""

from __future__ import annotations

import base64
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from evoflow.models.openai_compat_invoke import (
    OpenAICompatError,
    build_chat_completion_response,
    build_langchain_messages,
    content_has_image,
    extract_assistant_text,
    list_configured_models_openai,
    messages_have_image,
    normalize_content_for_langchain,
    normalize_image_url,
    vision_messages,
)


def test_content_has_image_detects_parts():
    assert content_has_image("hello") is False
    assert content_has_image([{"type": "text", "text": "x"}]) is False
    assert content_has_image([{"type": "image_url", "image_url": {"url": "https://a/b.png"}}]) is True
    assert messages_have_image(
        [{"role": "user", "content": [{"type": "image_url", "image_url": {"url": "data:image/png;base64,aa"}}]}]
    )


def test_normalize_content_rejects_image_when_not_allowed():
    with pytest.raises(OpenAICompatError) as ei:
        normalize_content_for_langchain(
            [{"type": "image_url", "image_url": {"url": "https://x/y.png"}}],
            allow_images=False,
        )
    assert ei.value.status_code == 400


def test_normalize_content_passes_https_image():
    out = normalize_content_for_langchain(
        [
            {"type": "text", "text": "what is this?"},
            {"type": "image_url", "image_url": {"url": "https://cdn.example/a.jpg"}},
        ],
        allow_images=True,
    )
    assert isinstance(out, list)
    assert out[0]["type"] == "text"
    assert out[1]["type"] == "image_url"
    assert out[1]["image_url"]["url"].startswith("https://")


def test_normalize_local_image_to_data_url(tmp_path: Path):
    img = tmp_path / "dot.png"
    # 1x1 PNG
    img.write_bytes(
        base64.standard_b64decode(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
        )
    )
    url = normalize_image_url(str(img))
    assert url.startswith("data:image/png;base64,")


def test_build_langchain_messages_vision_gate():
    msgs = [
        {
            "role": "user",
            "content": [
                {"type": "text", "text": "desc"},
                {"type": "image_url", "image_url": {"url": "https://x/a.png"}},
            ],
        }
    ]
    with pytest.raises(OpenAICompatError) as ei:
        build_langchain_messages(msgs, supports_vision=False)
    assert "supports_vision" in ei.value.message or "vision" in ei.value.message

    lc = build_langchain_messages(msgs, supports_vision=True)
    assert len(lc) == 1
    assert isinstance(lc[0].content, list)


def test_build_chat_completion_response_shape():
    resp = build_chat_completion_response(
        text="你好",
        model="demo-model",
        usage={"prompt_tokens": 3, "completion_tokens": 2, "total_tokens": 5},
        completion_id="chatcmpl-test",
    )
    assert resp["object"] == "chat.completion"
    assert resp["model"] == "demo-model"
    assert resp["choices"][0]["message"]["content"] == "你好"
    assert resp["usage"]["total_tokens"] == 5
    assert resp["id"] == "chatcmpl-test"


def test_extract_assistant_text_list():
    assert extract_assistant_text([{"type": "text", "text": "a"}, {"type": "text", "text": "b"}]) == "a\nb"
    assert extract_assistant_text("plain") == "plain"


def test_vision_messages_builds_multimodal(tmp_path: Path):
    img = tmp_path / "x.jpg"
    img.write_bytes(b"\xff\xd8\xff\xd9")  # minimal jpeg bytes
    msgs = vision_messages(prompt="描述", image=str(img), system="you are helpful")
    assert msgs[0]["role"] == "system"
    assert msgs[1]["role"] == "user"
    parts = msgs[1]["content"]
    assert parts[0]["type"] == "text"
    assert parts[1]["type"] == "image_url"
    assert parts[1]["image_url"]["url"].startswith("data:")


def test_list_configured_models_openai_shape():
    fake = MagicMock()
    fake.name = "my-glm"
    fake.vendor = "zhipu"
    fake.model = "glm-4.6v"
    fake.display_name = "GLM"
    fake.supports_vision = True
    fake.supports_thinking = False

    cfg = MagicMock()
    cfg.models = [fake]

    with patch("evoflow.models.openai_compat_invoke.get_app_config", return_value=cfg):
        out = list_configured_models_openai()
    assert out["object"] == "list"
    assert out["data"][0]["id"] == "my-glm"
    assert out["data"][0]["evoflow"]["supports_vision"] is True


def test_resolve_missing_model_404():
    from evoflow.models.openai_compat_invoke import resolve_model_name

    only = MagicMock()
    only.name = "only"
    only.model = "m1"
    cfg = MagicMock()
    cfg.models = [only]
    cfg.get_model_config.return_value = None

    with patch("evoflow.models.openai_compat_invoke.get_app_config", return_value=cfg):
        with pytest.raises(OpenAICompatError) as ei:
            resolve_model_name("nope")
    assert ei.value.status_code == 404
