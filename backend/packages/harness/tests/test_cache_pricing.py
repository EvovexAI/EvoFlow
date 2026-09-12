"""Tests for cache pricing (Aliyun + Volcengine)."""

from evoflow.observability.cache_pricing import (
    detect_platform,
    estimate_row_cache_savings_cny,
    estimate_row_request_cost_cny,
    resolve_cache_price,
    savings_cny_per_mtok,
)


def test_volcengine_doubao_21_pro() -> None:
    rule = resolve_cache_price("volcengine", "doubao-seed-2-1-pro")
    assert rule.input_cny_per_mtok == 6.0
    assert rule.cache_read_cny_per_mtok == 1.2
    assert savings_cny_per_mtok(rule) == 4.8


def test_volcengine_deepseek_v3() -> None:
    rule = resolve_cache_price("doubao", "deepseek-v3-250324")
    assert savings_cny_per_mtok(rule) == 1.5


def test_aliyun_qwen_implicit_cache() -> None:
    rule = resolve_cache_price("aliyun", "qwen3-max")
    assert savings_cny_per_mtok(rule) == 2.0  # 2.5 * 0.8


def test_row_savings_one_million_doubao_cache() -> None:
    assert estimate_row_cache_savings_cny(1_000_000, provider="volcengine", model="doubao-seed-2-1-pro") == 4.8


def test_row_request_cost_doubao_no_cache() -> None:
    # 1M input @ 6 CNY/M + 0.5M output @ 12 CNY/M (2× input)
    cost = estimate_row_request_cost_cny(
        1_000_000,
        500_000,
        provider="volcengine",
        model="doubao-seed-2-1-pro",
    )
    assert cost == 12.0


def test_row_request_cost_with_cache_read() -> None:
    cost = estimate_row_request_cost_cny(
        1_000_000,
        0,
        cache_read_tokens=800_000,
        cache_miss_tokens=200_000,
        provider="volcengine",
        model="doubao-seed-2-1-pro",
    )
    # miss 200k @ 6 + read 800k @ 1.2 = 1.2 + 0.96 = 2.16
    assert cost == 2.16


def test_detect_platform_user_stack() -> None:
    assert detect_platform("volcengine", "glm-4.7") == "volcengine"
    assert detect_platform("aliyun", "qwen-plus") == "aliyun"
