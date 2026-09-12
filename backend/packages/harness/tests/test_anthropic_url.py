"""Anthropic Messages base URL helpers (official SDK vs HTTP probe)."""

from __future__ import annotations

from evoflow.models.anthropic_url import anthropic_messages_http_url, normalize_anthropic_sdk_base_url


def test_normalize_strips_trailing_v1() -> None:
    assert normalize_anthropic_sdk_base_url("https://api.anthropic.com/v1") == "https://api.anthropic.com"
    assert normalize_anthropic_sdk_base_url("https://api.anthropic.com/v1/") == "https://api.anthropic.com"
    assert normalize_anthropic_sdk_base_url("https://api.anthropic.com") == "https://api.anthropic.com"


def test_normalize_proxy_without_v1_unchanged() -> None:
    assert normalize_anthropic_sdk_base_url("https://proxy.example.com") == "https://proxy.example.com"


def test_messages_http_url_official_base() -> None:
    assert (
        anthropic_messages_http_url("https://api.anthropic.com")
        == "https://api.anthropic.com/v1/messages"
    )


def test_messages_http_url_already_versioned() -> None:
    assert (
        anthropic_messages_http_url("https://api.anthropic.com/v1")
        == "https://api.anthropic.com/v1/messages"
    )
    assert (
        anthropic_messages_http_url("https://proxy.example.com/v1/")
        == "https://proxy.example.com/v1/messages"
    )
