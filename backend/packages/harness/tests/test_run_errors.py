from evoflow.proactive.run_errors import (
    extract_langgraph_run_error,
    format_langgraph_run_failure,
    humanize_execution_result,
)


def test_empty_langgraph_error_is_actionable():
    msg = format_langgraph_run_failure("error", {"error": ""})
    assert "执行失败" in msg
    assert "工作轨迹" in msg


def test_recursion_limit_detected_from_detail():
    msg = format_langgraph_run_failure(
        "error",
        {"error": "Recursion limit of 1500 reached without hitting a stop condition."},
    )
    assert "步数用尽" in msg


def test_humanize_legacy_empty_bridge_string():
    msg = humanize_execution_result("Execution failed: LangGraph run error: ")
    assert "执行失败" in msg
    assert "工作轨迹" in msg
    assert "LangGraph run error:" not in msg or "技术细节" in msg


def test_extract_from_kwargs():
    assert (
        extract_langgraph_run_error({"kwargs": {"error": "boom"}}) == "boom"
    )
