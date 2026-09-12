"""Regression tests for Claude OAuth billing system prompt handling."""

from __future__ import annotations

from evoflow.models.claude_provider import OAUTH_BILLING_HEADER, ClaudeChatModel


def _apply(system) -> list[dict]:
    payload = {"system": system}
    model = ClaudeChatModel.__new__(ClaudeChatModel)
    model._apply_oauth_billing(payload)
    return payload["system"]


def test_string_system_with_billing_header_keeps_remaining_text() -> None:
    system = f"{OAUTH_BILLING_HEADER}\nYou are a helpful assistant."
    result = _apply(system)
    assert result[0]["text"] == OAUTH_BILLING_HEADER
    assert result[1]["text"] == "You are a helpful assistant."


def test_string_system_without_billing_header_preserves_text() -> None:
    system = "You are a helpful assistant."
    result = _apply(system)
    assert result[0]["text"] == OAUTH_BILLING_HEADER
    assert result[1]["text"] == system


def test_string_system_only_billing_header() -> None:
    result = _apply(OAUTH_BILLING_HEADER)
    assert len(result) == 1
    assert result[0]["text"] == OAUTH_BILLING_HEADER


def test_list_system_deduplicates_billing_block() -> None:
    billing_block = {"type": "text", "text": OAUTH_BILLING_HEADER}
    system = [
        billing_block,
        {"type": "text", "text": "Keep this instruction."},
    ]
    result = _apply(system)
    assert result[0]["text"] == OAUTH_BILLING_HEADER
    assert result[1]["text"] == "Keep this instruction."
    assert sum(OAUTH_BILLING_HEADER in b.get("text", "") for b in result) == 1
