from evoflow.tools.tool_output_truncation import formatted_truncate_tool_output, truncate_text_to_token_budget


def test_formatted_truncate_adds_warning_header():
    body = "alpha\n" * 400
    out = formatted_truncate_tool_output(body, max_tokens=80)
    assert out.startswith("Warning: truncated output (original token count:")
    assert "Total output lines:" in out
    assert "alpha" in out


def test_truncate_text_to_token_budget_preserves_small_body():
    body = "short tool output"
    assert truncate_text_to_token_budget(body, max_tokens=500) == body
