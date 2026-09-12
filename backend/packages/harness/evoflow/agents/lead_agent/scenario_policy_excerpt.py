"""Scenario-specific policy excerpts for intra-turn injection (not full system prompt).

Full assembly remains ``apply_prompt_template`` on a new user turn (see
``DynamicSystemPromptOnScenarioMiddleware``). Same-turn ``scenario(activate)`` returns
``policy_excerpt`` here; ``ScenarioRuntimeHintMiddleware`` appends it to the system message.
"""

from __future__ import annotations

from evoflow.agents.lead_agent.intent_tool_profile import ordered_scenario_keys_for_display

__all__ = ["build_scenario_policy_excerpt", "scenario_policy_block_map"]


def scenario_policy_block_map(prompt_language: str | None = None) -> dict[str, list[tuple[str, str]]]:
    """Locale-aware policy blocks per scenario key (aligned with runtime hint / static assembly)."""
    del prompt_language
    return {
        "agent": [],
    }


def build_scenario_policy_excerpt(
    active_scenarios: list[str],
    *,
    prompt_language: str | None = None,
) -> str:
    """Build scenario policy text for intra-turn use (activate tool JSON + system patch)."""
    keys = ordered_scenario_keys_for_display(active_scenarios)
    if not keys:
        return ""
    policy_blocks = scenario_policy_block_map(prompt_language)
    lines: list[str] = []
    seen: set[str] = set()
    for s in keys:
        for _block_name, block_text in policy_blocks.get(s, []):
            tag = _block_name
            if tag in seen:
                continue
            seen.add(tag)
            if block_text.strip():
                lines.append(block_text.strip())
    if not lines:
        return ""
    return "\n\n".join(lines)
