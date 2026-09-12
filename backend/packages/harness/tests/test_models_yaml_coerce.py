"""Regression: bare string / bad model_dump must not blow up model loading."""

from evoflow.config.model_config import ModelConfig
from evoflow.config.models_yaml import _coerce_model_entry, _normalize_models_input


def test_coerce_skips_bare_string_model_entry():
    assert _coerce_model_entry("gpt-5.6-sol") is None
    assert _coerce_model_entry("  ") is None


def test_normalize_models_skips_bare_strings_keeps_dicts():
    out = _normalize_models_input(
        [
            "gpt-5.6-sol",
            {
                "name": "ok",
                "model": "ok",
                "use": "langchain_openai.ChatOpenAI",
                "base_url": "https://example.com/v1",
            },
        ]
    )
    assert len(out) == 1
    assert out[0]["name"] == "ok"
    assert out[0].get("vendor")


def test_coerce_rejects_model_dump_returning_non_dict():
    class BadDump:
        def model_dump(self, *args, **kwargs):
            return "not-a-dict"

    assert _coerce_model_entry(BadDump()) is None


def test_model_config_strips_reserved_model_config_key():
    mc = ModelConfig.model_validate(
        {
            "name": "m1",
            "model": "m1",
            "use": "langchain_openai.ChatOpenAI",
            "model_config": {"extra": "forbid"},
        }
    )
    dumped = mc.model_dump()
    assert "model_config" not in dumped or dumped.get("model_config") is None
    assert mc.name == "m1"
