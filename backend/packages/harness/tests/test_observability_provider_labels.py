"""Tests for observability provider label resolution."""

from evoflow.observability.provider_labels import normalize_stored_provider, resolve_observability_provider


class _FakeModel:
    def __init__(self, **kwargs):
        for k, v in kwargs.items():
            setattr(self, k, v)


def test_resolve_from_configured_vendor_on_instance() -> None:
    inst = _FakeModel(_evoflow_vendor="aliyun", model_name="qwen-max")
    assert resolve_observability_provider(fallback="patched_openai", model_instance=inst) == "aliyun"


def test_resolve_gemini_via_model_prefix() -> None:
    assert (
        normalize_stored_provider("patched_openai", model="google/gemini-2.5-pro-preview")
        == "google"
    )


def test_resolve_deepseek_alias() -> None:
    assert normalize_stored_provider("patched_deepseek", model="deepseek-chat") == "deepseek"


def test_passthrough_real_provider() -> None:
    assert normalize_stored_provider("openai", model="gpt-4o") == "openai"
