"""Unit tests for evaluation metrics helpers."""

from __future__ import annotations

from evoflow.observability.analysis_report import build_eval_recommendations, build_recommendations
from evoflow.observability.eval_metrics import (
    build_eval_findings,
    compute_thread_health_score,
    pick_sample_threads,
)


def test_build_eval_recommendations_invalid_tools():
    eval_dims = {
        "invalid_tool_calls": {
            "invalid_tool_call_rate": 0.12,
            "total_invalid_tool_calls": 15,
        },
        "thread_tool_density": {"dense_threads": []},
        "compress_kind": {"auxiliary_kind_ratio": 0.1},
    }
    recs = build_eval_recommendations(eval_dims)
    assert any("invalid_tool_calls" in str(r.get("phenomenon", "")) for r in recs)


def test_build_eval_findings_compress_ratio():
    dims = {
        "eval": {
            "invalid_tool_calls": {"invalid_tool_call_rate": 0.01, "total_invalid_tool_calls": 0},
            "thread_tool_density": {"dense_threads": []},
            "compress_kind": {"auxiliary_kind_ratio": 0.4},
        }
    }
    findings = build_eval_findings(dims)
    assert any(f.get("id") == "model_auxiliary_kind_ratio_high" for f in findings)


def test_build_recommendations_includes_eval_dimension():
    dims = {
        "reliability": {"tool_error_rate": 0.01, "errors_by_type": []},
        "tool_latency": {"top_slow_tools": []},
        "model_latency": {},
        "tokens": {"highest_token_invocations": []},
        "channels": {"im_channel_error_count": 0},
        "eval": {
            "invalid_tool_calls": {"invalid_tool_call_rate": 0.2, "total_invalid_tool_calls": 20},
            "thread_tool_density": {"dense_threads": [{"thread_id": "a"}, {"thread_id": "b"}, {"thread_id": "c"}]},
            "compress_kind": {"auxiliary_kind_ratio": 0.05},
        },
    }
    recs = build_recommendations(dims)
    assert any("invalid_tool_calls" in str(r.get("phenomenon", "")) for r in recs)


def test_pick_sample_threads_dedupes():
    insights = {
        "recent_tool_errors": [{"thread_id": "t1", "tool_name": "x"}],
        "highest_token_model_invocations": [{"thread_id": "t1", "usage_total_tokens": 200000}],
    }
    overview = {"top_slow_threads": [{"thread_id": "t1", "total_tool_ms": 99999}]}
    picked = pick_sample_threads(since_hours=168, sample_k=5, insights=insights, overview=overview)
    ids = [p["thread_id"] for p in picked]
    assert len(ids) == len(set(ids))


def test_compute_thread_health_score_bounds():
    score = compute_thread_health_score(
        thread_id="unknown-thread",
        since_hours=168,
        overview={"tool_duration_p95_ms": 1000},
        invalid_summary={"top_threads_by_invalid": []},
    )
    assert 0 <= float(score.get("health_score") or 0) <= 100
