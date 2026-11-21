"""LogRateLimitFilter：per-logger 令牌桶 + 连续重复折叠（2026-11-21 日志洪水第三道闸）。"""

import logging

import pytest

from app.gateway.logging_setup import LogRateLimitFilter


def rec(name: str, msg: str, level: int = logging.INFO) -> logging.LogRecord:
    return logging.LogRecord(
        name=name, level=level, pathname=__file__, lineno=1, msg=msg, args=None, exc_info=None
    )


@pytest.fixture(autouse=True)
def _no_env_limit(monkeypatch):
    monkeypatch.delenv("EVOFLOW_LOG_RATE_LIMIT_PER_SEC", raising=False)


def test_burst_then_throttle_per_logger():
    f = LogRateLimitFilter(per_sec=5)  # capacity = 10
    # 前 10 条（满桶）放行，之后瞬间打空
    verdicts = [f.filter(rec("app.a", f"msg-{i}")) for i in range(12)]
    assert verdicts[:10] == [True] * 10
    assert verdicts[10:] == [False, False]


def test_throttle_is_per_logger():
    f = LogRateLimitFilter(per_sec=5)
    # logger a 打满桶后，logger b 仍全额放行
    for i in range(12):
        f.filter(rec("app.a", f"a-{i}"))
    assert f.filter(rec("app.b", "b-0")) is True
    assert f.filter(rec("app.b", "b-1")) is True


def test_duplicate_folding_passes_every_100th():
    f = LogRateLimitFilter(per_sec=5)
    first = rec("app.dup", "same line")
    assert f.filter(first) is True
    # 第 2~100 条重复：丢弃；第 100 条放行并带 ×100 标注
    verdicts = [f.filter(rec("app.dup", "same line")) for _ in range(99)]
    assert all(v is False for v in verdicts)
    marked = rec("app.dup", "same line")
    assert f.filter(marked) is True
    assert "(repeated ×100)" in marked.getMessage()
    # 第 101 条起继续丢弃
    assert f.filter(rec("app.dup", "same line")) is False


def test_warning_and_above_never_limited():
    f = LogRateLimitFilter(per_sec=1)  # 极小桶
    for i in range(50):
        assert f.filter(rec("app.err", f"warn-{i}", level=logging.WARNING)) is True
        assert f.filter(rec("app.err", f"err-{i}", level=logging.ERROR)) is True


def test_same_record_seen_by_two_handlers_counts_once():
    f1 = LogRateLimitFilter(per_sec=5)
    f2 = LogRateLimitFilter(per_sec=5)
    # 第一条：f1 放行
    r = rec("app.x", "hello")
    assert f1.filter(r) is True
    # 同一 record 到达第二个 handler：用缓存裁决，不再二次记账/改写
    assert f2.filter(r) is True
    # f2 的桶未被消费：全新 record 在 f2 上仍有满额突发
    fresh_verdicts = [f2.filter(rec("app.x", f"fresh-{i}")) for i in range(12)]
    assert fresh_verdicts[:10] == [True] * 10


def test_disabled_via_zero():
    f = LogRateLimitFilter(per_sec=0)
    for i in range(100):
        assert f.filter(rec("app.y", f"y-{i}")) is True


def test_repeated_env_disable(monkeypatch):
    monkeypatch.setenv("EVOFLOW_LOG_RATE_LIMIT_PER_SEC", "0")
    f = LogRateLimitFilter()
    assert f._per_sec == 0.0
    for i in range(50):
        assert f.filter(rec("app.z", f"z-{i}")) is True
