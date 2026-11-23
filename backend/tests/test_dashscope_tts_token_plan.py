"""Token Plan DashScope TTS must use qwen-audio model + token-plan base."""

from __future__ import annotations

from evoflow.community.media_generation.providers import dashscope_tts as ds


def test_token_plan_key_forces_token_plan_base(monkeypatch):
    monkeypatch.setattr(ds, "dashscope_base_url", lambda: "https://dashscope.aliyuncs.com/api/v1")
    assert ds._base_url(api_key="sk-sp-abc") == ds.TOKEN_PLAN_MEDIA_BASE
    assert ds._base_url(api_key="sk-plain") == "https://dashscope.aliyuncs.com/api/v1"


def test_resolve_model_and_voice_for_token_plan():
    assert ds._resolve_model(None, token_plan=True) == "qwen-audio-3.0-tts-plus"
    assert ds._resolve_model("cosyvoice-v3-flash", token_plan=True) == "qwen-audio-3.0-tts-plus"
    assert ds._resolve_voice("longanyang", model="qwen-audio-3.0-tts-plus", token_plan=True) == "longanlufeng"
    assert ds._resolve_voice(None, model="qwen-audio-3.0-tts-plus", token_plan=True) == "longanlingxin"
    assert ds._resolve_model(None, token_plan=False) == "cosyvoice-v3-flash"
    assert ds._resolve_voice(None, model="cosyvoice-v3-flash", token_plan=False) == "longanyang"


def test_invalid_api_key_message_mentions_token_plan():
    msg = ds._format_http_error(
        401,
        '{"code":"InvalidApiKey","message":"Invalid API-key provided."}',
        token_plan=True,
        base="https://dashscope.aliyuncs.com/api/v1",
        model="cosyvoice-v3-flash",
    )
    assert "token-plan" in msg.lower() or "Token Plan" in msg
    assert "qwen-audio-3.0-tts-plus" in msg
