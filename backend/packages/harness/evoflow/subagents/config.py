"""Subagent configuration definitions."""

from __future__ import annotations

import os
from dataclasses import dataclass, field

from evoflow.runtime.long_run_limits import MAX_SUBAGENT_RECURSION_LIMIT

# LangGraph ``recursion_limit`` counts graph super-steps (model + middleware + tools),
# not LLM "turns". Each agent round typically costs several steps.
DEFAULT_RECURSION_STEPS_PER_TURN = 8
MIN_SUBAGENT_RECURSION_LIMIT = 750


def resolve_subagent_recursion_limit(max_turns: int, explicit: int | None = None) -> int:
    """Map semantic ``max_turns`` (model rounds) to LangGraph ``recursion_limit``."""
    if explicit is not None and int(explicit) > 0:
        return int(explicit)
    mult = DEFAULT_RECURSION_STEPS_PER_TURN
    raw = (os.getenv("EVOFLOW_SUBAGENT_RECURSION_STEPS_PER_TURN") or "").strip()
    if raw:
        try:
            mult = max(2, min(int(raw), 24))
        except ValueError:
            pass
    mt = max(1, int(max_turns))
    return min(MAX_SUBAGENT_RECURSION_LIMIT, max(MIN_SUBAGENT_RECURSION_LIMIT, mt * mult))


@dataclass
class SubagentConfig:
    """Configuration for a subagent.

    Attributes:
        name: Unique identifier for the subagent.
        description: When Claude should delegate to this subagent.
        system_prompt: The system prompt that guides the subagent's behavior.
        tools: Optional tool allowlist. If None, inherits the corresponding agent /
            parent session agent tools (bound∪deferred under execution mode) — never
            the raw global catalog.
        disallowed_tools: Optional list of tool names to deny.
        model: Model to use - 'inherit' uses parent's model.
        max_turns: Maximum model rounds (AIMessage count) before stopping tool use.
        recursion_limit: Optional LangGraph step budget; default derived from max_turns.
        timeout_seconds: Maximum execution time in seconds (default: 900 = 15 minutes).
    """

    name: str
    description: str
    system_prompt: str
    tools: list[str] | None = None
    disallowed_tools: list[str] | None = field(default_factory=lambda: ["subagent", "task", "scenario", "plan", "supervisor", "ask_clarification"])
    model: str = "inherit"
    max_turns: int = 500
    recursion_limit: int | None = None
    timeout_seconds: int = 900
