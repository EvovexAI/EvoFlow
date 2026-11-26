"""模型调用缓存命中率：0% 可区分、偏低可诊断。"""

from __future__ import annotations

from evoflow.observability.cache_metrics import (
    CACHE_HIT_RATE_LOW,
    compute_cache_hit_rate,
    diagnose_cache_hit,
)


def test_compute_cache_hit_rate_none_when_no_cache_fields():
    assert compute_cache_hit_rate(0, 0, 0) is None


def test_compute_cache_hit_rate_zero_when_only_miss():
    """有未命中、无命中 → 0.0（不是 None），便于发现异常偏低。"""
    assert compute_cache_hit_rate(0, 10_000, 0) == 0.0


def test_compute_cache_hit_rate_normal():
    rate = compute_cache_hit_rate(7_000, 3_000, 0)
    assert rate == 0.7


def test_diagnose_first_call_cold_start():
    d = diagnose_cache_hit(
        cache_read_tokens=0,
        cache_miss_tokens=8_000,
        cache_creation_tokens=8_000,
        model_call_seq=1,
        message_count=12,
        invocation_kind="main",
    )
    assert d["status"] in {"none", "write"}
    assert d["hit_rate_pct"] is not None
    assert any("第 1" in n or "写入" in n for n in d["notes"])


def test_diagnose_low_hit_with_unstable_prefix():
    d = diagnose_cache_hit(
        cache_read_tokens=1_000,
        cache_miss_tokens=9_000,
        cache_creation_tokens=500,
        model_call_seq=4,
        message_count=48,
        invocation_kind="main",
        prompt_tokens=60_000,
    )
    assert d["hit_rate"] is not None
    assert d["hit_rate"] < CACHE_HIT_RATE_LOW
    assert d["status"] == "low"
    assert any("偏低" in n for n in d["notes"])
    assert any("前缀" in n or "消息条数" in n for n in d["notes"])


def test_diagnose_ok_hit():
    d = diagnose_cache_hit(
        cache_read_tokens=20_000,
        cache_miss_tokens=2_000,
        model_call_seq=3,
        invocation_kind="main",
    )
    assert d["status"] == "ok"
    assert d["hit_rate_pct"] is not None
    assert d["hit_rate_pct"] >= 80
