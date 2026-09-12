"""Facade: locale-specific static prompt blocks (default English).

When editing prompts, update **both** ``prompt_blocks_zh.py`` and ``prompt_blocks_en.py``.
"""

from __future__ import annotations

from evoflow.agents.lead_agent import prompt_blocks_en as _en
from evoflow.agents.lead_agent import prompt_blocks_zh as _zh
from evoflow.agents.lead_agent.prompt_language import resolve_prompt_language


def _module(lang: str | None) -> object:
    return _en if resolve_prompt_language(lang) == "en" else _zh


def get_static_blocks(lang: str | None = None):
    """Return the prompt_blocks module for ``lang`` (``zh`` | ``en``)."""
    return _module(lang)


# Default-locale exports (English) for backward-compatible imports.
SAFETY_BLOCK = _en.SAFETY_BLOCK
ROLE_BLOCK_CHAT_TEMPLATE = _en.ROLE_BLOCK_CHAT_TEMPLATE
COMMUNICATION_STYLE_BLOCK = _en.COMMUNICATION_STYLE_BLOCK
COMMUNICATION_STYLE_COMPACT_BLOCK = _en.COMMUNICATION_STYLE_COMPACT_BLOCK
ENTITY_ASSETS_BLOCK = _en.ENTITY_ASSETS_BLOCK
ENTITY_ASSETS_COMPACT_BLOCK = _en.ENTITY_ASSETS_COMPACT_BLOCK
SCENARIO_ACTIVATION_BLOCK = _en.SCENARIO_ACTIVATION_BLOCK
SESSION_MODE_POLICY_BLOCK = _en.SESSION_MODE_POLICY_BLOCK
WEB_CITATION_POLICY_BLOCK = _en.WEB_CITATION_POLICY_BLOCK
TOOL_CALLING_BLOCK = _en.TOOL_CALLING_BLOCK
WORKSPACE_BLOCK_TEMPLATE = _en.WORKSPACE_BLOCK_TEMPLATE
WORKSPACE_BLOCK_COMPACT_TEMPLATE = _en.WORKSPACE_BLOCK_COMPACT_TEMPLATE
CONTEXT_PRIORITY_BLOCK = _en.CONTEXT_PRIORITY_BLOCK
THINKING_POLICY_BLOCK = _en.THINKING_POLICY_BLOCK
