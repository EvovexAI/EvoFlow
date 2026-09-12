"""Mission intent analyzer prompt."""

from __future__ import annotations

from evoflow.agents.mission_state.prompt import build_mission_analyzer_prompt


def test_prompt_includes_schema_and_incremental_mode() -> None:
    text = build_mission_analyzer_prompt(
        thread_id="t1",
        mode="incremental",
        previous_state_json="{}",
        conversation="User: 帮我整理本周工作\n\nAssistant: 好的",
        analyze_scenarios=False,
    )
    assert "primary_objective" in text
    assert "incremental" in text
    assert "intent_hint" not in text or "仅当 analyze_scenarios" not in text
    assert "exploration_summary" in text
    assert "禁止" in text
    assert "supervisor" in text
    assert "## read_registry" not in text


def test_prompt_includes_read_registry_when_provided() -> None:
    text = build_mission_analyzer_prompt(
        thread_id="t1",
        mode="incremental",
        previous_state_json="{}",
        conversation="User: 修登录",
        analyze_scenarios=False,
        read_registry="- src/auth.ts (full, read_file) — handleLogin",
    )
    assert "read_registry" in text
    assert "## read_registry" in text
    assert "src/auth.ts" in text


def test_prompt_includes_scenarios_when_enabled() -> None:
    text = build_mission_analyzer_prompt(
        thread_id="t1",
        mode="incremental",
        previous_state_json="{}",
        conversation="User: hi",
        analyze_scenarios=True,
    )
    assert "intent_hint" in text
    assert "chat|plan|workspace" in text
