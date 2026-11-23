"""Agent Plan speech endpoints must be OpenSpeech Plan, not Ark chat base."""

from __future__ import annotations

from evoflow.persistence.media_settings import vendor_has_usable_credentials
from evoflow.plans.adapters import get_adapter
from evoflow.plans.catalog import get_catalog_entry


def test_agent_plan_catalog_speech_uses_openspeech():
    entry = get_catalog_entry("volcengine.agent_plan")
    tts = entry["endpoints"]["tts"]["base_url"]
    asr = entry["endpoints"]["asr"]["base_url"]
    assert "openspeech.bytedance.com" in tts
    assert "/api/v3/plan/tts/" in tts
    assert "openspeech.bytedance.com" in asr
    assert "/api/v3/plan/sauc/" in asr
    assert "ark.cn-beijing.volces.com" not in tts
    assert "ark.cn-beijing.volces.com" not in asr


def test_adapter_build_route_speech_openspeech():
    adapter = get_adapter("volcengine", "agent_plan")
    catalog = get_catalog_entry("volcengine.agent_plan")
    binding = {
        "id": "b1",
        "api_key": "ark-test",
        "tier_id": "large",
        "bound_capabilities": ["tts", "asr"],
    }
    tts = adapter.build_route(binding, catalog, "tts")
    asr = adapter.build_route(binding, catalog, "asr")
    assert "openspeech.bytedance.com" in tts["base_url"]
    assert "openspeech.bytedance.com" in asr["base_url"]
    assert tts["base_url"].startswith("https://")
    assert asr["base_url"].startswith("wss://")


def test_volcengine_tts_usable_with_agent_plan_speech_key(monkeypatch):
    """Agent Plan 只写 ark- Speech Key 也应视为已配置（勿只认旧 AppId+Token）。"""

    monkeypatch.setattr(
        "evoflow.persistence.media_settings.get_enabled_vendors",
        lambda: {"volcengine-tts": True},
    )
    monkeypatch.setattr(
        "evoflow.persistence.media_settings.get_vendor_credentials",
        lambda vendor_id, require_enabled=True: {
            "speechApiKey": "ark-agent-plan-key",
        },
    )
    assert vendor_has_usable_credentials("volcengine-tts") is True
