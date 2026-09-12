"""Unit tests for observability report builder."""

from __future__ import annotations

from evoflow.observability.analysis_report import build_recommendations


def test_build_recommendations_high_error_rate():
    dims = {
        "reliability": {"tool_error_rate": 0.2, "errors_by_type": []},
        "tool_latency": {"top_slow_tools": []},
        "model_latency": {"latency_p95_ms": None},
        "tokens": {"highest_token_invocations": []},
        "channels": {"im_channel_error_count": 0},
    }
    recs = build_recommendations(dims)
    assert any(r.get("priority") == "P0" and r.get("dimension") == "reliability" for r in recs)


def test_build_recommendations_validation_error():
    dims = {
        "reliability": {
            "tool_error_rate": 0.05,
            "errors_by_type": [{"error_type": "ValidationError", "count": 10}],
        },
        "tool_latency": {"top_slow_tools": []},
        "model_latency": {},
        "tokens": {},
        "channels": {},
    }
    recs = build_recommendations(dims)
    assert any("ValidationError" in str(r.get("phenomenon", "")) for r in recs)
