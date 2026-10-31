"""Gateway traffic lane classifier — unknown APIs must not default to Control."""

from __future__ import annotations

from app.gateway.traffic_lanes import Lane, classify_path, refine_tasks_list_lane


def test_health_is_control() -> None:
    assert classify_path("/health/liveness").lane == Lane.CONTROL
    assert classify_path("/api/health/ready").lane == Lane.CONTROL


def test_stream_is_stream() -> None:
    assert classify_path("/api/langgraph/threads/x/runs/stream").lane == Lane.STREAM
    assert classify_path("/api/v4/conversation/frames").lane == Lane.STREAM


def test_tasks_catalog_is_best_effort() -> None:
    assert classify_path("/api/tasks", method="GET").lane == Lane.BEST_EFFORT
    assert refine_tasks_list_lane(path="/api/tasks", query="page=1&page_size=40") is None


def test_tasks_point_lookup_is_data() -> None:
    d = refine_tasks_list_lane(path="/api/tasks", query="thread_id=abc")
    assert d is not None
    assert d.lane == Lane.DATA


def test_serve_file_is_best_effort() -> None:
    assert classify_path("/api/workspaces/serve-file").lane == Lane.BEST_EFFORT


def test_unknown_api_defaults_to_data_not_control() -> None:
    """Coverage guarantee: new slow endpoints are isolated until allow-listed."""
    assert classify_path("/api/brand-new-slow-thing").lane == Lane.DATA
    assert classify_path("/api/foo/bar/baz").lane == Lane.DATA


def test_chat_mutation_is_control() -> None:
    assert classify_path("/api/chat/sessions/x/messages", method="POST").lane == Lane.CONTROL
    assert classify_path("/api/threads/x/interrupt", method="POST").lane == Lane.CONTROL


def test_browser_log_is_best_effort() -> None:
    assert classify_path("/api/browser/log", method="POST").lane == Lane.BEST_EFFORT
