"""Tests for prompt-cache token normalization."""

from evoflow.agents.middlewares.message_usage_helpers import (
    extract_cache_tokens,
    infer_usage_metadata_from_checkpoint_ai_dict,
    normalize_usage_counts,
)
from evoflow.observability.queries import cache_tokens_from_usage_payload, token_triplet_from_usage_payload


def test_anthropic_native_cache_fields():
    raw = {
        "input_tokens": 200,
        "output_tokens": 350,
        "cache_read_input_tokens": 2000,
        "cache_creation_input_tokens": 0,
    }
    out = normalize_usage_counts(raw)
    assert out is not None
    assert out["input_tokens"] == 2200
    assert out["output_tokens"] == 350
    assert out["total_tokens"] == 2550
    assert out["cache_read_tokens"] == 2000
    assert out["cache_miss_tokens"] == 200


def test_anthropic_with_cache_creation():
    raw = {
        "input_tokens": 82,
        "output_tokens": 14,
        "cache_read_input_tokens": 1536,
        "cache_creation_input_tokens": 0,
    }
    out = normalize_usage_counts(raw)
    assert out is not None
    assert out["input_tokens"] == 1618
    assert out["cache_read_tokens"] == 1536
    assert out["cache_miss_tokens"] == 82


def test_openai_cached_tokens_details():
    raw = {
        "prompt_tokens": 2200,
        "completion_tokens": 350,
        "total_tokens": 2550,
        "prompt_tokens_details": {"cached_tokens": 2000},
    }
    out = normalize_usage_counts(raw)
    assert out is not None
    assert out["input_tokens"] == 2200
    assert out["cache_read_tokens"] == 2000
    assert out["cache_miss_tokens"] == 200


def test_openai_responses_api_input_tokens_details():
    raw = {
        "input_tokens": 2200,
        "output_tokens": 350,
        "total_tokens": 2550,
        "input_tokens_details": {"cached_tokens": 2000},
    }
    out = normalize_usage_counts(raw)
    assert out is not None
    assert out["input_tokens"] == 2200
    assert out["cache_read_tokens"] == 2000
    assert out["cache_miss_tokens"] == 200


def test_bailian_openai_explicit_cache_creation():
    raw = {
        "prompt_tokens": 2200,
        "completion_tokens": 350,
        "total_tokens": 2550,
        "prompt_tokens_details": {
            "cached_tokens": 0,
            "cache_creation_input_tokens": 2000,
        },
    }
    out = normalize_usage_counts(raw)
    assert out is not None
    assert out["input_tokens"] == 2200
    assert out["cache_creation_tokens"] == 2000
    assert out["cache_miss_tokens"] == 200


def test_bailian_openai_implicit_cache_hit():
    raw = {
        "prompt_tokens": 3019,
        "completion_tokens": 104,
        "total_tokens": 3123,
        "prompt_tokens_details": {"cached_tokens": 2048},
    }
    out = normalize_usage_counts(raw)
    assert out is not None
    assert out["input_tokens"] == 3019
    assert out["cache_read_tokens"] == 2048
    assert out["cache_miss_tokens"] == 971


def test_already_normalized_openai_shape():
    raw = {
        "input_tokens": 2200,
        "output_tokens": 350,
        "total_tokens": 2550,
        "cache_read_tokens": 2000,
        "cache_miss_tokens": 200,
    }
    out = normalize_usage_counts(raw)
    assert out is not None
    assert out["input_tokens"] == 2200
    assert out["cache_read_tokens"] == 2000
    assert out["cache_miss_tokens"] == 200


def test_cache_tokens_from_obs_usage_blob():
    blob = {
        "usage_metadata": {
            "input_tokens": 200,
            "output_tokens": 10,
            "cache_read_input_tokens": 150,
        }
    }
    cache = cache_tokens_from_usage_payload(blob)
    assert cache["cache_read_tokens"] == 150
    assert cache["cache_miss_tokens"] == 200


def test_token_triplet_from_obs_anthropic_blob():
    blob = {
        "response_metadata": {
            "usage": {
                "input_tokens": 200,
                "output_tokens": 350,
                "cache_read_input_tokens": 2000,
            }
        }
    }
    inp, out, tot = token_triplet_from_usage_payload(blob)
    assert inp == 2200
    assert out == 350
    assert tot == 2550


def test_infer_checkpoint_ai_dict_merges_response_usage():
    msg = {
        "type": "ai",
        "response_metadata": {
            "usage": {
                "input_tokens": 100,
                "output_tokens": 5,
                "cache_read_input_tokens": 60,
            }
        },
    }
    out = infer_usage_metadata_from_checkpoint_ai_dict(msg)
    assert out is not None
    assert out["input_tokens"] == 160
    assert out["cache_read_tokens"] == 60
    assert out["cache_miss_tokens"] == 100


def test_langchain_usage_metadata_cache_read_details():
    raw = {
        "input_tokens": 2200,
        "output_tokens": 350,
        "total_tokens": 2550,
        "input_token_details": {"cache_read": 2000},
    }
    out = normalize_usage_counts(raw)
    assert out is not None
    assert out["input_tokens"] == 2200
    assert out["cache_read_tokens"] == 2000
    assert out["cache_miss_tokens"] == 200


def test_volcengine_openai_compatible_usage():
    raw = {
        "prompt_tokens": 2200,
        "completion_tokens": 350,
        "total_tokens": 2550,
        "prompt_tokens_details": {"cached_tokens": 2000},
    }
    out = normalize_usage_counts(raw)
    assert out is not None
    assert out["cache_read_tokens"] == 2000
    assert out["cache_miss_tokens"] == 200


def test_infer_checkpoint_from_langchain_usage_metadata():
    msg = {
        "type": "ai",
        "usage_metadata": {
            "input_tokens": 3019,
            "output_tokens": 104,
            "total_tokens": 3123,
            "input_token_details": {"cache_read": 2048},
        },
    }
    out = infer_usage_metadata_from_checkpoint_ai_dict(msg)
    assert out is not None
    assert out["cache_read_tokens"] == 2048
    assert out["cache_miss_tokens"] == 971


def test_resolve_token_fields_prefers_vendor_usage_over_flat_columns():
    src = {
        "type": "ai",
        "inputTokens": 200,
        "response_metadata": {
            "usage": {
                "input_tokens": 200,
                "output_tokens": 350,
                "cache_read_input_tokens": 2000,
            }
        },
    }
    from evoflow.agents.middlewares.message_usage_helpers import resolve_token_fields_for_persist

    inp, out, tot, cread, ccreate, cmiss = resolve_token_fields_for_persist(
        src,
        input_tokens=200,
        output_tokens=350,
    )
    assert inp == 2200
    assert out == 350
    assert tot == 2550
    assert cread == 2000
    assert cmiss == 200


def test_token_fields_for_session_rollup():
    from evoflow.agents.middlewares.message_usage_helpers import token_fields_for_session_rollup

    rollup = token_fields_for_session_rollup(
        input_tokens=2200,
        output_tokens=350,
        total_tokens=2550,
        cache_read_tokens=2000,
        cache_miss_tokens=200,
    )
    assert rollup == {
        "input_tokens": 2200,
        "output_tokens": 350,
        "total_tokens": 2550,
        "cache_read_tokens": 2000,
        "cache_creation_tokens": 0,
        "cache_miss_tokens": 200,
    }


def test_extract_cache_tokens_empty():
    assert extract_cache_tokens({"input_tokens": 10}) == {}
