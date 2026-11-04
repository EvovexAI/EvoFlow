"""Workspace/project memory runtime paths are retired (no inject / no auto-write)."""

from __future__ import annotations

from evoflow.agents.lead_agent.prompt import build_memory_injection_sections
from evoflow.agents.memory.workspace_memory import (
    bootstrap_workspace_memory,
    format_workspace_memory_context,
    schedule_workspace_memory_bootstrap_if_needed,
    seed_workspace_memory,
    update_workspace_memory_from_conversation,
)


def test_format_workspace_memory_context_always_empty():
    assert format_workspace_memory_context(r"D:\dev\github\EvoFlow") == ""
    assert format_workspace_memory_context(None) == ""


def test_bootstrap_seed_update_are_noops():
    assert schedule_workspace_memory_bootstrap_if_needed(r"D:\dev\github\EvoFlow") is False
    assert update_workspace_memory_from_conversation([], r"D:\dev\github\EvoFlow") is False
    boot = bootstrap_workspace_memory(r"D:\dev\github\EvoFlow")
    assert boot["status"] == "disabled"
    seed = seed_workspace_memory(r"D:\dev\github\EvoFlow")
    assert seed["status"] == "disabled"


def test_memory_injection_skips_workspace_block(tmp_path, monkeypatch):
    monkeypatch.setenv("EVOFLOW_HOME", str(tmp_path))
    from evoflow.config.paths import reset_paths_cache

    reset_paths_cache()
    try:
        text = build_memory_injection_sections(
            agent_name="main",
            local_workspace_root=str(tmp_path / "proj"),
            injection_profile="chat_compact",
        )
    finally:
        reset_paths_cache()
    assert "<workspace_memory>" not in text
