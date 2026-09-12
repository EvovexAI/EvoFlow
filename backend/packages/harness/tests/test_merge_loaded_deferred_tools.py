from evoflow.agents.thread_state import (
    EVF_REPLACE_LOADED_DEFERRED_MARKER,
    merge_artifacts,
    merge_loaded_deferred_tools,
)


def test_merge_loaded_deferred_tools_append_like_tool_search() -> None:
    assert merge_loaded_deferred_tools(["a"], ["b"]) == ["a", "b"]
    assert merge_loaded_deferred_tools(None, ["x"]) == ["x"]


def test_merge_loaded_deferred_tools_replace_after_scenario() -> None:
    prior = ["web_search", "read_file", "write_to_file"]
    repl = [EVF_REPLACE_LOADED_DEFERRED_MARKER, "read_file", "list_dir"]
    assert merge_loaded_deferred_tools(prior, repl) == ["read_file", "list_dir"]


def test_merge_loaded_deferred_tools_replace_clears() -> None:
    assert merge_loaded_deferred_tools(["web_search"], [EVF_REPLACE_LOADED_DEFERRED_MARKER]) == []


def test_artifacts_still_merge_only() -> None:
    assert merge_artifacts(["a"], ["b"]) == ["a", "b"]
