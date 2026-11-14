"""关思考时 OpenAI 兼容层不得把 minimal 映射成 low（会重新开推理）。

用户症状（小V 语音）：设置/语音硬关思考后 SSE 仍有 reasoning 块；
gateway 反复警告 ``reasoning_effort=minimal … mapped to low``。
"""

from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

_BACKEND_ROOT = Path(__file__).resolve().parents[1]
for p in (str(_BACKEND_ROOT), str(_BACKEND_ROOT / "packages" / "harness")):
    if p not in sys.path:
        sys.path.insert(0, p)

from evoflow.config.app_config import AppConfig, reset_app_config, set_app_config  # noqa: E402
from evoflow.config.model_config import ModelConfig  # noqa: E402
from evoflow.models.factory import (  # noqa: E402
    _sanitize_openai_compat_reasoning_effort,
)
from evoflow.models.vendor_thinking_payload import (  # noqa: E402
    apply_vendor_thinking_request_payload,
)

# 非 dashscope/volc/zhipu 宿主，才会走到 openai-compat reasoning_effort 规整
GATEWAY = "https://openai-compat.example.com/v1"


@pytest.fixture(autouse=True)
def _reset_config():
    yield
    reset_app_config()


def _chat_openai_class():
    from langchain_openai import ChatOpenAI

    return ChatOpenAI


def _compat_model_cfg(**extra):
    base = dict(base_url=GATEWAY, vendor="openai", supports_reasoning_effort=True)
    base.update(extra)
    return SimpleNamespace(**base)


def test_sanitize_pops_minimal_instead_of_mapping_to_low():
    settings = {"reasoning_effort": "minimal"}
    _sanitize_openai_compat_reasoning_effort(
        _chat_openai_class(),
        _compat_model_cfg(),
        settings,
    )
    assert "reasoning_effort" not in settings


def test_sanitize_pops_when_thinking_type_disabled():
    settings = {
        "reasoning_effort": "low",
        "extra_body": {"thinking": {"type": "disabled"}},
    }
    _sanitize_openai_compat_reasoning_effort(
        _chat_openai_class(),
        _compat_model_cfg(),
        settings,
    )
    assert "reasoning_effort" not in settings


def test_sanitize_still_maps_xhigh_when_thinking_on():
    settings = {"reasoning_effort": "xhigh"}
    _sanitize_openai_compat_reasoning_effort(
        _chat_openai_class(),
        _compat_model_cfg(),
        settings,
    )
    assert settings["reasoning_effort"] == "high"


def test_force_off_payload_strips_effort_and_disables():
    class _M:
        _evoflow_thinking_enabled = False
        _evoflow_thinking_type = "disabled"
        _evoflow_supports_thinking = True

    out = apply_vendor_thinking_request_payload(
        {"model": "deepseek-v4.1-flash", "reasoning_effort": "low"},
        base_url=GATEWAY,
        model_instance=_M(),
    )
    assert "reasoning_effort" not in out
    extra = out.get("extra_body") or {}
    assert extra.get("enable_thinking") is False
    assert (extra.get("thinking") or {}).get("type") == "disabled"
    assert "reasoning" not in extra


def test_create_chat_model_voice_off_leaves_no_reasoning_effort():
    set_app_config(
        AppConfig.model_construct(
            models=[
                ModelConfig(
                    name="deepseek-v4.1-flash",
                    use="langchain_openai:ChatOpenAI",
                    model="deepseek-v4.1-flash",
                    base_url=GATEWAY,
                    api_key="sk-test",
                    vendor="openai",
                    supports_thinking=True,
                    supports_reasoning_effort=True,
                )
            ],
            primary_model="deepseek-v4.1-flash",
        )
    )
    from evoflow.models import create_chat_model

    model = create_chat_model(
        name="deepseek-v4.1-flash",
        thinking_enabled=False,
        thinking_type="disabled",
        invocation_kind="main",
    )
    assert getattr(model, "_evoflow_thinking_enabled") is False
    # LangChain may store reasoning_effort on the instance — must not be an "on" level
    effort = getattr(model, "reasoning_effort", None)
    assert effort in (None, "minimal", "none", "")