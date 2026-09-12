from evoflow.config.tool_results_config import tool_is_llm_summary_candidate


def test_read_file_never_llm_summary_candidate_even_if_configured():
    assert tool_is_llm_summary_candidate("read") is False
    assert tool_is_llm_summary_candidate("read_file") is False
    assert tool_is_llm_summary_candidate("read_files") is False
