"""Platform openai.* / settings.invoke_model registry + handler wiring (no live LLM)."""

from __future__ import annotations

from unittest.mock import patch

from evoflow.admin.platform_actions import PLATFORM_DOMAINS, dispatch_platform_action, get_registry, reset_registry_cache


def test_openai_domain_registered():
    reset_registry_cache()
    assert "openai" in PLATFORM_DOMAINS
    reg = get_registry()
    for name in ("openai.models", "openai.chat", "openai.vision", "settings.invoke_model"):
        assert name in reg
    assert reg["openai.models"].risk == "read"
    assert reg["openai.chat"].risk == "write"
    assert reg["openai.vision"].risk == "write"
    assert reg["settings.invoke_model"].risk == "write"


def test_openai_chat_requires_confirm():
    reset_registry_cache()
    out = dispatch_platform_action(
        "openai.chat",
        args_json='{"message":"hi"}',
        confirm=False,
    )
    assert out.get("pending_confirm") is True or out.get("ok") is False or "confirm" in str(out).lower()


def test_openai_vision_handler_builds_messages():
    reset_registry_cache()
    fake = {
        "id": "chatcmpl-test",
        "choices": [{"message": {"role": "assistant", "content": "一只猫"}}],
    }
    with patch(
        "evoflow.models.openai_compat_invoke.invoke_chat_completion",
        return_value=fake,
    ) as inv:
        with patch(
            "evoflow.models.openai_compat_invoke.normalize_image_url",
            return_value="data:image/png;base64,xxx",
        ):
            out = dispatch_platform_action(
                "openai.vision",
                args_json='{"image":"C:/tmp/a.png","message":"图里有什么","model":"vision-x"}',
                confirm=True,
            )
    assert out.get("ok") is True
    assert out.get("content") == "一只猫"
    assert inv.called
    kwargs = inv.call_args.kwargs
    assert kwargs.get("model") == "vision-x"
    msgs = kwargs.get("messages") or []
    assert any(m.get("role") == "user" for m in msgs)


def test_settings_invoke_model_handler():
    reset_registry_cache()
    with patch(
        "evoflow.admin.models.invoke_model",
        return_value={"content": "ok", "openai": {}},
    ) as inv:
        out = dispatch_platform_action(
            "settings.invoke_model",
            args_json='{"message":"hi","model_name":"primary"}',
            confirm=True,
        )
    assert out.get("ok") is True
    assert out.get("content") == "ok"
    inv.assert_called_once()
