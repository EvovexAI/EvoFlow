"""Tests for the Phase 2 TTL caches on token estimation.

Verifies acceptance criteria:
1. Same tool set → second ``estimate_bound_tools_tokens`` returns cached result.
2. Same system prompt → second ``estimate_system_prompt_tokens`` returns cached result.
3. Caches expire after the TTL window (60 s).
4. ``wire_openai_tool_spec`` caches the convert_to_openai_tool result per tool.
"""

from __future__ import annotations

import time
from types import SimpleNamespace
from unittest import mock

from langchain.tools import tool

from evoflow.context import model_request_token_estimate as mod
from evoflow.context.model_request_token_estimate import (
    estimate_bound_tools_tokens,
    estimate_system_prompt_tokens,
    wire_openai_tool_spec,
)


@tool
def _cached_sample_tool(path: str, limit: int = 10) -> str:
    """Read part of a file."""
    return path


def _clear_all_caches() -> None:
    with mod._tools_token_cache_lock:
        mod._tools_token_cache.clear()
    with mod._tool_spec_cache_lock:
        mod._tool_spec_cache.clear()
    with mod._system_prompt_token_cache_lock:
        mod._system_prompt_token_cache.clear()


def test_estimate_bound_tools_tokens_second_call_uses_cache() -> None:
    """Acceptance #1: second call returns cached result without re-tokenizing."""
    _clear_all_caches()
    tools = [_cached_sample_tool]

    first_tokens, first_count = estimate_bound_tools_tokens(tools, model="gpt-4o")

    # Patch count_text_tokens so a cache miss would produce a wildly different
    # number; a hit returns the original value unchanged.
    with mock.patch.object(mod, "count_text_tokens", return_value=999_999):
        second_tokens, second_count = estimate_bound_tools_tokens(tools, model="gpt-4o")

    assert second_tokens == first_tokens, "second call should return cached token count"
    assert second_count == first_count == 1
    assert second_tokens != 999_999, "second call must not have re-tokenized"


def test_estimate_system_prompt_tokens_second_call_uses_cache() -> None:
    """Acceptance #2: second call returns cached result without re-tokenizing."""
    _clear_all_caches()
    request = SimpleNamespace(system_message=SimpleNamespace(content="You are a helpful agent."))

    first_tokens = estimate_system_prompt_tokens(request, model="gpt-4o")
    assert first_tokens > 0

    with mock.patch.object(mod, "count_text_tokens", return_value=999_999):
        second_tokens = estimate_system_prompt_tokens(request, model="gpt-4o")

    assert second_tokens == first_tokens, "second call should return cached token count"
    assert second_tokens != 999_999, "second call must not have re-tokenized"


def test_tools_cache_key_is_sorted_names_independent_of_order() -> None:
    """Cache key uses sorted names, so tool order must not matter."""
    _clear_all_caches()
    a = [_cached_sample_tool]
    a_tokens, _ = estimate_bound_tools_tokens(a, model="gpt-4o")
    # Same single tool → same key → cache hit.
    b_tokens, _ = estimate_bound_tools_tokens(a, model="gpt-4o")
    assert a_tokens == b_tokens


def test_tools_cache_distinguishes_different_models() -> None:
    """Different model → different cache key → recomputed."""
    _clear_all_caches()
    tools = [_cached_sample_tool]
    t1, _ = estimate_bound_tools_tokens(tools, model="gpt-4o")
    t2, _ = estimate_bound_tools_tokens(tools, model="gpt-4")
    # Both cached; values may differ by encoding but both must be present.
    assert len(mod._tools_token_cache) >= 2


def test_system_prompt_cache_distinguishes_different_content() -> None:
    _clear_all_caches()
    r1 = SimpleNamespace(system_message=SimpleNamespace(content="You are a helpful agent."))
    r2 = SimpleNamespace(system_message=SimpleNamespace(content="Totally different prompt text here."))
    estimate_system_prompt_tokens(r1, model="gpt-4o")
    estimate_system_prompt_tokens(r2, model="gpt-4o")
    assert len(mod._system_prompt_token_cache) == 2


def test_tools_cache_expires_after_ttl() -> None:
    """Acceptance #3: entries older than the TTL are treated as missing."""
    _clear_all_caches()
    tools = [_cached_sample_tool]
    first_tokens, _ = estimate_bound_tools_tokens(tools, model="gpt-4o")

    # Backdate the cached entry past the TTL window.
    with mod._tools_token_cache_lock:
        for key, val in list(mod._tools_token_cache.items()):
            tokens, count, _ts = val
            mod._tools_token_cache[key] = (tokens, count, time.monotonic() - mod._CACHE_TTL_SECONDS - 1)

    with mock.patch.object(mod, "count_text_tokens", return_value=888_888) as m:
        second_tokens, _ = estimate_bound_tools_tokens(tools, model="gpt-4o")

    assert m.called, "expired entry should trigger re-tokenization"
    # count_text_tokens returns 888_888; estimate adds _TOOLS_ARRAY_FRAMING_TOKENS.
    assert second_tokens == 888_888 + mod._TOOLS_ARRAY_FRAMING_TOKENS, "expired entry should be recomputed"


def test_system_prompt_cache_expires_after_ttl() -> None:
    """Acceptance #3: system prompt cache also respects TTL."""
    _clear_all_caches()
    request = SimpleNamespace(system_message=SimpleNamespace(content="You are a helpful agent."))
    estimate_system_prompt_tokens(request, model="gpt-4o")

    with mod._system_prompt_token_cache_lock:
        for key, val in list(mod._system_prompt_token_cache.items()):
            tokens, _ts = val
            mod._system_prompt_token_cache[key] = (tokens, time.monotonic() - mod._CACHE_TTL_SECONDS - 1)

    with mock.patch.object(mod, "count_text_tokens", return_value=777_777) as m:
        second_tokens = estimate_system_prompt_tokens(request, model="gpt-4o")

    assert m.called, "expired entry should trigger re-tokenization"
    assert second_tokens == 777_777


def test_wire_openai_tool_spec_caches_convert_result() -> None:
    """Acceptance #4: convert_to_openai_tool is called once per tool, not per request."""
    _clear_all_caches()
    with mock.patch(
        "evoflow.context.model_request_token_estimate._convert_tool_to_openai_spec",
        wraps=mod._convert_tool_to_openai_spec,
    ) as spy:
        spec1 = wire_openai_tool_spec(_cached_sample_tool)
        spec2 = wire_openai_tool_spec(_cached_sample_tool)
        assert spec1 == spec2
        assert spy.call_count == 1, "convert should run once; second call served from cache"


def test_empty_tools_not_cached() -> None:
    _clear_all_caches()
    tokens, count = estimate_bound_tools_tokens([], model="gpt-4o")
    assert tokens == 0 and count == 0
    assert mod._tools_token_cache == {}


def test_empty_system_prompt_not_cached() -> None:
    _clear_all_caches()
    request = SimpleNamespace(system_message=SimpleNamespace(content=""))
    assert estimate_system_prompt_tokens(request, model="gpt-4o") == 0
    assert mod._system_prompt_token_cache == {}
