"""Tests for sync read registry (rendered inside mission_state)."""

from __future__ import annotations

from unittest.mock import patch

from evoflow.config.working_memory_config import load_working_memory_config_from_dict
from evoflow.context.working_memory import (
    clear_registry,
    format_files_already_read_section,
    format_read_registry_for_analyzer,
    list_entries,
    register_read,
    register_tool_result,
)


def setup_function() -> None:
    load_working_memory_config_from_dict({"enabled": True})
    for tid in ("t1", "t2", "t2b", "t3", "t4"):
        clear_registry(tid)


def test_register_read_file_records_path_and_note():
    register_tool_result(
        "t1",
        tool_name="read_file",
        tool_input={"path": "src/auth/login.ts", "offset": 10, "limit": 40},
        output_text="export function handleLogin() {\n  return auth.login();\n}\n",
    )
    entries = list_entries("t1")
    assert len(entries) == 1
    assert entries[0].path == "src/auth/login.ts"
    assert entries[0].offset == 10
    assert entries[0].limit == 40
    assert "handleLogin" in entries[0].note


def test_batch_read_paths_registered_from_post_search():
    out = (
        "hits\n<post_search_reads offset=0 limit=1>\n"
        "[tool:summary] tool=read_file\npath: src/a.py\nlines: 1-40\ncore: export foo\n"
        "</post_search_reads>"
    )
    register_tool_result("t2", tool_name="search_code_index", tool_input={"query": "foo"}, output_text=out)
    entries = list_entries("t2")
    assert len(entries) == 1
    assert entries[0].path == "src/a.py"


def test_search_catalog_only_does_not_register_paths():
    out = (
        "hits for foo\n"
        "Read catalog (0-based index; prefer read_file on the top 1-2 most relevant paths):\n"
        "  [0] src/a.py:12\n"
        "  [1] src/b.py\n"
    )
    register_tool_result("t2b", tool_name="search_code_index", tool_input={"query": "foo"}, output_text=out)
    assert list_entries("t2b") == []


def test_files_already_read_section():
    register_read("t3", path="src/x.ts", note="exports X")
    block = format_files_already_read_section("t3")
    assert "<files_already_read>" in block
    assert "src/x.ts" in block
    assert "Do not re-read" in block


def test_duplicate_read_moves_to_end_without_duplicating():
    register_read("t4", path="src/a.py")
    register_read("t4", path="src/b.py")
    register_read("t4", path="src/a.py")
    entries = list_entries("t4")
    assert len(entries) == 2
    assert entries[-1].path == "src/a.py"


def test_format_read_registry_for_analyzer():
    clear_registry("t-reg")
    assert format_read_registry_for_analyzer("t-reg") == ""
    register_read("t-reg", path="src/a.ts", note="export A")
    text = format_read_registry_for_analyzer("t-reg")
    assert "src/a.ts" in text
    assert "export A" in text
    clear_registry("t-reg")


def test_mission_state_section_skipped_when_prompt_injection_disabled():
    from evoflow.agents.lead_agent.prompt import _build_mission_state_section

    register_read("t5", path="src/foo.ts", note="Foo export")
    section = _build_mission_state_section(
        {
            "primary_objective": "Fix login bug",
            "exploration_summary": "- login.ts exports handleLogin",
            "exploration_gaps": ["confirm token refresh path"],
        },
        thread_id="t5",
    )
    assert section == ""
    clear_registry("t5")


def test_mission_state_section_includes_files_and_exploration():
    from evoflow.agents.lead_agent.prompt import _build_mission_state_section

    register_read("t5", path="src/foo.ts", note="Foo export")
    with patch("evoflow.agents.mission_state.config.MISSION_STATE_PROMPT_INJECTION_ENABLED", True):
        section = _build_mission_state_section(
            {
                "primary_objective": "Fix login bug",
                "exploration_summary": "- login.ts exports handleLogin",
                "exploration_gaps": ["confirm token refresh path"],
            },
            thread_id="t5",
        )
    assert "<mission_state>" in section
    assert "<files_already_read>" in section
    clear_registry("t5")
