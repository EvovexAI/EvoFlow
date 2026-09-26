"""Subagent type utilities.

This module was previously used for Claude Code worker routing.
Claude Code tools have been removed; these functions now return safe defaults.
"""

from __future__ import annotations


def is_claude_code_subagent_type(name: str | None) -> bool:
    """Claude Code worker detection — always False after removal."""
    return False


def collab_executor_allows_auto_outcome_without_report(*worker_types: str | None) -> bool:
    """Claude Code auto-outcome — always True (no Claude Code workers exist)."""
    return True


def claude_subagent_lookup_keys(name: str) -> set[str]:
    """Claude Code lookup keys — empty after removal."""
    return set()


def effective_subagent_type(subagent_type: str | None) -> str | None:
    """Claude Code remapping — returns input unchanged after removal."""
    return subagent_type
