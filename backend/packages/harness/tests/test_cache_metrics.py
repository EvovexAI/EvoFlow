"""Tests for cache metrics aggregation."""

from evoflow.observability.cache_metrics import compute_cache_hit_rate


def test_cache_hit_rate_read_over_read_plus_miss() -> None:
    assert compute_cache_hit_rate(900, 100, 0) == 0.9


def test_cache_hit_rate_none_without_read() -> None:
    assert compute_cache_hit_rate(0, 100, 50) is None
