"""``supports_thinking=false`` 的模型，请求体里不得出现任何 thinking 参数。

报障（员工 wrap-up 环节，EvoFlow frozen_exe_tree）：

  TypeError: AsyncCompletions.create() got an unexpected keyword argument 'confirm'
  → 修好后：
  Error code: 400 - claude-sonnet-5-5 requires adaptive thinking or
  thinking.type=between_tools; omit thinking or use one of those modes

模型行写的是 ``supports_thinking: false``、vendor=anthropic、走 OpenAI 兼容
代理（base_url=https://vip.ai-api.cc/v1，use=langchain_openai:ChatOpenAI）。
平台无视这个声明，两处硬塞 ``thinking``：

1. 构造期：``create_chat_model(thinking_enabled=False)`` 的显式关闭分支
   无条件写 ``extra_body.thinking.type=disabled``；
2. 请求期：``apply_vendor_thinking_request_payload`` 的 ``force_off`` 分支
   再写一次。

该代理对 thinking 是严格模式，普通写法直接 400。修法：声明不支持时一律 omit。
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

_BACKEND_ROOT = Path(__file__).resolve().parents[1]
for p in (str(_BACKEND_ROOT), str(_BACKEND_ROOT / "packages" / "harness")):
    if p not in sys.path:
        sys.path.insert(0, p)

from evoflow.config.app_config import AppConfig, reset_app_config, set_app_config  # noqa: E402
from evoflow.config.model_config import ModelConfig  # noqa: E402
from evoflow.models.vendor_thinking_payload import (  # noqa: E402
    apply_vendor_thinking_request_payload,
)

CLAUDE_PROXY = "https://vip.ai-api.cc/v1"

_THINKING_KEYS = ("thinking", "reasoning", "reasoning_effort", "enable_thinking", "thinking_budget")


def _model(**overrides) -> ModelConfig:
    data = {
        "name": "claude-sonnet-5-5",
        "use": "langchain_openai:ChatOpenAI",
        "model": "claude-sonnet-5-5",
        "base_url": CLAUDE_PROXY,
        "api_key": "sk-test",
        "vendor": "anthropic",
        "supports_thinking": False,
        "supports_reasoning_effort": False,
    }
    data.update(overrides)
    return ModelConfig(**data)


def _install(model_config: ModelConfig) -> None:
    set_app_config(
        AppConfig.model_construct(models=[model_config], primary_model=model_config.name)
    )


def _assert_no_thinking(payload: dict) -> None:
    for key in _THINKING_KEYS:
        assert key not in payload, f"顶层不应出现 {key}: {payload.get(key)!r}"
    extra = payload.get("extra_body")
    if isinstance(extra, dict):
        for key in _THINKING_KEYS:
            assert key not in extra, f"extra_body 不应出现 {key}: {extra.get(key)!r}"


@pytest.fixture(autouse=True)
def _reset_config():
    yield
    reset_app_config()


def test_ctor_does_not_inject_thinking_when_unsupported():
    """wrap-up 走的正是 thinking_enabled=False，这里过去会硬写 disabled。"""
    _install(_model())
    from evoflow.models import create_chat_model

    model = create_chat_model(
        name="claude-sonnet-5-5",
        thinking_enabled=False,
        invocation_kind="person_wrap_up",
    )
    assert model.__dict__.get("extra_body") in (None, {})
    assert getattr(model, "_evoflow_supports_thinking") is False


def test_request_payload_has_no_thinking_when_unsupported():
    """即使模型行配了 when_thinking_enabled，声明不支持时也不得发出去。"""
    _install(
        _model(
            when_thinking_enabled={
                "extra_body": {"thinking": {"type": "enabled", "budget_tokens": 4096}}
            }
        )
    )
    from langchain_core.messages import HumanMessage, SystemMessage

    from evoflow.models import create_chat_model

    model = create_chat_model(
        name="claude-sonnet-5-5",
        thinking_enabled=False,
        invocation_kind="person_wrap_up",
    )
    payload = model._get_request_payload(
        [SystemMessage(content="sys"), HumanMessage(content="hi")]
    )
    _assert_no_thinking(payload)


def test_payload_layer_omits_thinking_when_unsupported():
    """请求期 force_off 分支也直接对 payload 生效。"""

    class _Inst:
        _evoflow_thinking_enabled = False
        _evoflow_supports_thinking = False

    payload = {"model": "claude-sonnet-5-5", "extra_body": {"thinking": {"type": "disabled"}}}
    out = apply_vendor_thinking_request_payload(
        payload, base_url=CLAUDE_PROXY, model_instance=_Inst()
    )
    _assert_no_thinking(out)


def test_supported_model_still_gets_explicit_disable():
    """反向守护：支持 thinking 的模型显式关闭仍要发 disabled，别被这次改动放宽。"""
    _install(_model(supports_thinking=True))
    from evoflow.models import create_chat_model

    model = create_chat_model(
        name="claude-sonnet-5-5", thinking_enabled=False, invocation_kind="main"
    )
    assert model.__dict__.get("extra_body", {}).get("thinking") == {"type": "disabled"}


def test_supported_model_untouched_when_unspecified():
    """thinking_enabled=None（未指定）→ 照旧 omit，不注入任何开关。"""
    _install(_model(supports_thinking=True))
    from evoflow.models import create_chat_model

    model = create_chat_model(
        name="claude-sonnet-5-5", thinking_enabled=None, invocation_kind="main"
    )
    assert model.__dict__.get("extra_body") in (None, {})
