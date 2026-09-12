"""maybe_persist LLM path respects llm_summary_tool_names."""

from evoflow.config.tool_results_config import ToolResultsConfig, set_tool_results_config
from evoflow.tools.large_result_store import maybe_persist


def test_maybe_persist_read_file_no_medium_summary(monkeypatch) -> None:
    set_tool_results_config(
        ToolResultsConfig(
            enabled=True,
            threshold_chars=50_000,
            medium_threshold_chars=500,
            llm_summary_enabled=True,
            llm_summary_tool_names=["grep"],
        )
    )

    def _boom(*_args, **_kwargs):
        raise AssertionError("LLM must not run for non-whitelist read_file")

    monkeypatch.setattr("evoflow.models.create_chat_model", _boom)
    content = "x" * 800
    out = maybe_persist(content, "read_file", "c1")
    assert out is content
    assert "[ToolResult summary" not in out


def test_maybe_persist_read_file_keeps_inline_until_large(monkeypatch) -> None:
    set_tool_results_config(
        ToolResultsConfig(
            enabled=True,
            threshold_chars=50_000,
            medium_threshold_chars=8_000,
            llm_summary_enabled=True,
        )
    )
    content = "line\n" * 3000  # ~12k chars
    out = maybe_persist(content, "read_file", "c1")
    assert out is content
    assert "[ToolResult summary" not in out


def test_maybe_persist_whitelisted_tool_can_use_llm(monkeypatch) -> None:
    set_tool_results_config(
        ToolResultsConfig(
            enabled=True,
            threshold_chars=50_000,
            medium_threshold_chars=500,
            llm_summary_enabled=True,
            llm_summary_tool_names=["grep"],
        )
    )

    def _fake_llm(content: str, tool_name: str) -> str | None:
        raise AssertionError("LLM must not run while large result offload is disabled")

    monkeypatch.setattr("evoflow.tools.large_result_store._llm_summary", _fake_llm)
    content = "y" * 800
    out = maybe_persist(content, "grep", "c2")
    assert out is content
