"""Runtime media tool schemas hide disabled providers from the LLM."""

import pytest
from langchain_core.utils.function_calling import convert_to_openai_tool

from evoflow.community.media_generation import config_helpers as ch
from evoflow.community.media_generation.media_tool_runtime import (
    apply_runtime_media_tool_schemas,
    media_providers_runtime_hint,
)
from evoflow.community.media_generation.tools import media_image_generate_tool


@pytest.fixture(autouse=True)
def _clear_media_env(monkeypatch):
    for key in (
        "VOLCENGINE_API_KEY",
        "ARK_API_KEY",
        "DASHSCOPE_API_KEY",
        "KLING_ACCESS_KEY_ID",
        "KLING_ACCESS_KEY_SECRET",
        "KLING_API_KEY",
    ):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setattr(ch, "ensure_media_credentials", lambda: None)


def test_image_tool_schema_omits_provider_when_only_jimeng(monkeypatch):
    monkeypatch.setenv("VOLCENGINE_API_KEY", "test-key")
    monkeypatch.setattr(
        "evoflow.persistence.media_settings.cfg_repo.get_app_setting",
        lambda key: {
            "media.credentials": {
                "volcengineApiKey": "test-key",
                "enabledVendors": {"volcengine": True, "dashscope": False, "kling": False},
            }
        }.get(key),
    )
    [tool] = apply_runtime_media_tool_schemas([media_image_generate_tool])
    schema = convert_to_openai_tool(tool)
    props = schema["function"]["parameters"]["properties"]
    assert "provider" not in props
    assert "runtime" not in props
    assert "Only `jimeng` is available" in tool.description


def test_image_tool_schema_lists_only_enabled_providers(monkeypatch):
    monkeypatch.setenv("VOLCENGINE_API_KEY", "vk")
    monkeypatch.setenv("DASHSCOPE_API_KEY", "dk")
    monkeypatch.setattr(
        "evoflow.persistence.media_settings.cfg_repo.get_app_setting",
        lambda key: {
            "media.credentials": {
                "volcengineApiKey": "vk",
                "dashscopeApiKey": "dk",
                "enabledVendors": {"volcengine": True, "dashscope": True, "kling": False},
            }
        }.get(key),
    )
    [tool] = apply_runtime_media_tool_schemas([media_image_generate_tool])
    schema = convert_to_openai_tool(tool)
    prop = schema["function"]["parameters"]["properties"]["provider"]
    enum = prop.get("enum")
    if enum is None and "anyOf" in prop:
        for branch in prop["anyOf"]:
            if isinstance(branch, dict) and branch.get("enum"):
                enum = branch["enum"]
                break
    assert enum == ["jimeng", "wan"]
    assert "kling" not in enum


def test_patched_tool_invoke_accepts_runtime(monkeypatch):
    import json

    from langgraph.prebuilt.tool_node import ToolRuntime

    import evoflow.community.media_generation.tools as mod

    monkeypatch.setenv("VOLCENGINE_API_KEY", "test-key")
    monkeypatch.setattr(
        "evoflow.persistence.media_settings.cfg_repo.get_app_setting",
        lambda key: {
            "media.credentials": {
                "volcengineApiKey": "test-key",
                "enabledVendors": {"volcengine": True, "dashscope": False, "kling": False},
            }
        }.get(key),
    )
    monkeypatch.setattr(mod, "_submit_image", lambda *a, **k: "immediate:http://cdn/x.png")
    monkeypatch.setattr(mod, "_poll_image", lambda *a, **k: ("succeeded", "http://cdn/x.png", ["http://cdn/x.png"]))
    monkeypatch.setattr(mod, "save_media_from_urls", lambda *a, **k: [])
    monkeypatch.setattr(mod, "resolve_image_provider", lambda explicit, **k: ("jimeng", None))

    [tool] = apply_runtime_media_tool_schemas([media_image_generate_tool])
    assert "runtime" not in convert_to_openai_tool(tool)["function"]["parameters"]["properties"]

    rt = ToolRuntime(
        state={"messages": []},
        context={},
        config={"configurable": {}},
        store=None,
        stream_writer=lambda x: None,
        tool_call_id="tc-1",
    )
    raw = tool.invoke(
        {
            "prompt": "cat poster",
            "mode": "text2image",
            "aspect_ratio": "16:9",
            "runtime": rt,
        }
    )
    data = json.loads(raw)
    assert data["ok"] is True


def test_runtime_hint_lists_only_configured(monkeypatch):
    monkeypatch.setenv("VOLCENGINE_API_KEY", "vk")
    monkeypatch.setattr(
        "evoflow.persistence.media_settings.cfg_repo.get_app_setting",
        lambda key: {
            "media.credentials": {
                "volcengineApiKey": "vk",
                "enabledVendors": {"volcengine": True, "dashscope": False, "kling": False},
            }
        }.get(key),
    )
    hint = media_providers_runtime_hint(lang="zh")
    assert "`jimeng`" in hint
    assert "仅可用 provider：`jimeng`" in hint
    assert "禁止" in hint
