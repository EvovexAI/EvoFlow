"""Subagent recursion_limit vs max_turns mapping."""

from evoflow.subagents.config import resolve_subagent_recursion_limit


def test_resolve_subagent_recursion_limit_scales_with_max_turns():
    assert resolve_subagent_recursion_limit(40) == 750  # floor (40*8=320 < 750)
    assert resolve_subagent_recursion_limit(120) == 960


def test_resolve_subagent_recursion_limit_respects_floor_and_explicit():
    assert resolve_subagent_recursion_limit(5) >= 750
    assert resolve_subagent_recursion_limit(120, explicit=1500) == 1500
