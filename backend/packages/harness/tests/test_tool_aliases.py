"""Tool name alias normalization for plan worker_profile.tools."""

from __future__ import annotations

from evoflow.collab.plan_subtasks_sync import build_worker_profile_from_step
from evoflow.tools.tool_aliases import (
    augment_file_io_tools,
    augment_process_tools,
    augment_worker_tool_allowlist,
    normalize_worker_tool_names,
    resolve_tools_against_catalog,
)


def test_normalize_plan_tool_aliases() -> None:
    assert normalize_worker_tool_names(["write_file", "ls", "read_file"]) == [
        "write",
        "terminal",
        "read",
    ]


def test_normalize_retired_write_and_search_aliases() -> None:
    assert normalize_worker_tool_names(
        ["write_to_file", "delete_file", "replace_in_file", "search_content", "str_replace"]
    ) == ["write", "delete", "replace", "search_code_index"]


def test_resolve_and_augment_file_io() -> None:
    allowed = {
        "read",
        "write",
        "replace",
        "delete",
        "terminal",
        "bash",
    }
    matched, unknown = resolve_tools_against_catalog(["write_file"], allowed)
    assert unknown == []
    assert matched == ["write"]
    augmented = augment_file_io_tools(matched, allowed)
    assert set(augmented) >= {"write", "read", "replace", "delete"}


def test_augment_process_tools_when_terminal_present() -> None:
    allowed = {"terminal", "process", "read"}
    out = augment_process_tools(["read", "terminal"], allowed)
    assert "terminal" in out
    assert "process" in out


def test_augment_worker_tool_allowlist_chains_file_io_and_process() -> None:
    allowed = {
        "read",
        "write",
        "terminal",
        "process",
    }
    out = augment_worker_tool_allowlist(["write_file", "terminal"], allowed)
    assert set(out) >= {"write", "read", "terminal", "process"}


def test_build_worker_profile_normalizes_tools() -> None:
    wp = build_worker_profile_from_step(
        {"tools": ["write_file", "list_dir"]},
        assigned="general-purpose",
        depends_refs=[],
    )
    tools = wp["tools"]
    assert "write" in tools
    assert "terminal" in tools
    assert "write_file" not in tools


def test_build_worker_profile_adds_process_tools_with_terminal() -> None:
    wp = build_worker_profile_from_step(
        {"tools": ["read", "write", "terminal"]},
        assigned="project-implementer",
        depends_refs=[],
    )
    assert "terminal" in wp["tools"]
    assert "process" in wp["tools"]
    assert "write" in wp["tools"]
