"""Filter internal / non-LLM tool invocations from observability aggregates."""

from __future__ import annotations


def is_internal_tool_invocation(tool_name: str | None) -> bool:
    """True for scheduler hooks and other non-LLM tool rows in ``evoflow_obs_tool_invocations``."""
    n = str(tool_name or "").strip().lower()
    if not n:
        return False
    return n.startswith("scheduler:")


def llm_tool_visibility_sql(*, include_internal: bool = False) -> str:
    """SQL predicate fragment (no leading AND/WHERE)."""
    if include_internal:
        return "1=1"
    return "tool_name NOT LIKE 'scheduler:%'"


def tool_invocation_where(*parts: str | None, include_internal: bool = False) -> str:
    """Build a WHERE clause for tool invocation queries."""
    clauses = [llm_tool_visibility_sql(include_internal=include_internal)]
    for part in parts:
        text = str(part or "").strip()
        if text:
            clauses.append(text)
    return " WHERE " + " AND ".join(clauses)


def tool_invocation_and_suffix(*parts: str | None, include_internal: bool = False) -> str:
    """Append visibility filter to an existing WHERE (leading `` AND ...``)."""
    clauses = [llm_tool_visibility_sql(include_internal=include_internal)]
    for part in parts:
        text = str(part or "").strip()
        if text:
            clauses.append(text)
    return " AND " + " AND ".join(clauses)
