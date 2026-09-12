"""Facade: locale-specific plan workflow blocks (default English).

When editing prompts, update **both** ``plan_prompt_blocks_zh.py`` and ``plan_prompt_blocks_en.py``.
"""

from __future__ import annotations

from evoflow.agents.lead_agent import plan_prompt_blocks_en as _en
from evoflow.agents.lead_agent import plan_prompt_blocks_zh as _zh
from evoflow.agents.lead_agent.prompt_language import resolve_prompt_language

__all__ = [
    "format_plan_workflow_system_block",
    "DECISION_POLICY_BLOCK",
    "COLLABORATION_POLICY_BLOCK",
    "get_plan_policy_blocks",
]


def _module(lang: str | None):
    return _en if resolve_prompt_language(lang) == "en" else _zh


def format_plan_workflow_system_block(
    agent_name: str,
    *,
    include_clarification: bool,
    prompt_language: str | None = None,
) -> str:
    return _module(prompt_language).format_plan_workflow_system_block(
        agent_name,
        include_clarification=include_clarification,
    )


def get_plan_policy_blocks(prompt_language: str | None = None) -> tuple[str, str]:
    m = _module(prompt_language)
    return m.DECISION_POLICY_BLOCK, m.COLLABORATION_POLICY_BLOCK


# Default English (backward-compatible module-level constants).
DECISION_POLICY_BLOCK = _en.DECISION_POLICY_BLOCK
COLLABORATION_POLICY_BLOCK = _en.COLLABORATION_POLICY_BLOCK
