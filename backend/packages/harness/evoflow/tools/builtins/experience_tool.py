"""Experience Library — persistent episodic memory for the AI agent.

Agent tools delegate to :mod:`evoflow.admin.experience` (same SQLite store as ``evoflow experience`` CLI).
"""

from __future__ import annotations

import json
import logging
from typing import Any

from langchain.tools import tool

from evoflow.admin import experience as experience_admin
from evoflow.admin.errors import AdminError

logger = logging.getLogger(__name__)

_DEFAULT_CATEGORY = "general"


def _json_or_raw(value: Any) -> Any:
    if isinstance(value, str) and value.startswith(("[", "{")):
        try:
            return json.loads(value)
        except (json.JSONDecodeError, TypeError):
            pass
    return value


def _ensure_list(value: Any, default: Any = None) -> list:
    if value is None:
        return default if default is not None else []
    parsed = _json_or_raw(value)
    if isinstance(parsed, list):
        return parsed
    if isinstance(parsed, str):
        return [parsed]
    return []


def _admin_error_payload(exc: AdminError) -> str:
    return json.dumps({"error": exc.message}, ensure_ascii=False)


@tool("experience_save", parse_docstring=True)
def experience_save_tool(
    title: str,
    *,
    category: str = _DEFAULT_CATEGORY,
    tags: Any = None,
    problem: str = "",
    solution: str = "",
    outcome: str = "",
    applicable_to: str = "",
    steps: Any = None,
    source_sessions: Any = None,
) -> str:
    """Save a new experience entry to the experience library.

    Args:
        title: Clear, descriptive title for keyword search later.
        category: Category path like "devops/docker" or "coding/python".
        tags: List of keywords for search. Can be a list or JSON string.
        problem: What problem was being solved.
        solution: How it was solved (key steps and reasoning).
        outcome: What result was achieved.
        applicable_to: What scenarios this experience applies to.
        steps: Ordered list of steps. Can be a list or JSON string.
        source_sessions: Session IDs this experience came from.
    """
    try:
        result = experience_admin.save_experience(
            {
                "title": title,
                "category": category,
                "tags": _ensure_list(tags),
                "problem": problem,
                "solution": solution,
                "outcome": outcome,
                "applicable_to": applicable_to,
                "steps": _ensure_list(steps),
                "source_sessions": _ensure_list(source_sessions),
            }
        )
        return json.dumps(result, ensure_ascii=False)
    except AdminError as e:
        return _admin_error_payload(e)
    except Exception as e:
        logger.error("Failed to save experience: %s", e)
        return json.dumps({"error": str(e)})


@tool("experience_get", parse_docstring=True)
def experience_get_tool(experience_id: str) -> str:
    """Get full details of a specific experience entry by ID.

    Args:
        experience_id: The ID of the experience (e.g. "exp_abc123").
    """
    try:
        return json.dumps(experience_admin.get_experience(experience_id), ensure_ascii=False)
    except AdminError as e:
        return _admin_error_payload(e)
    except Exception as e:
        return json.dumps({"error": str(e)})


@tool("experience_list", parse_docstring=True)
def experience_list_tool(
    *,
    category: str = "",
    tags: Any = None,
    query: str = "",
    max_results: int = 10,
) -> str:
    """Search the experience library for relevant past experiences.

    Args:
        category: Filter by category path prefix. Empty string means all categories.
        tags: Filter by tags (match any). Can be a list or JSON string.
        query: Keywords to search in title/problem/solution/outcome.
        max_results: Maximum results to return (default 10, max 30).
    """
    try:
        return json.dumps(
            experience_admin.list_experiences(
                category=category,
                tags=_ensure_list(tags),
                query=query,
                max_results=max_results,
            ),
            ensure_ascii=False,
        )
    except AdminError as e:
        return _admin_error_payload(e)
    except Exception as e:
        return json.dumps({"error": str(e), "experiences": []})


@tool("experience_update", parse_docstring=True)
def experience_update_tool(
    experience_id: str,
    *,
    title: str | None = None,
    tags: Any = None,
    problem: str | None = None,
    solution: str | None = None,
    outcome: str | None = None,
    applicable_to: str | None = None,
    steps: Any = None,
    append_steps: Any = None,
    source_sessions: Any = None,
) -> str:
    """Update an existing experience entry.

    Args:
        experience_id: The ID of the experience to update.
        title: New title.
        tags: Replace existing tags. Can be a list or JSON string.
        problem: Replace problem description.
        solution: Replace solution description.
        outcome: Replace outcome.
        applicable_to: Replace applicable scenarios.
        steps: Replace all steps entirely.
        append_steps: Additional steps to append.
        source_sessions: Add additional source sessions.
    """
    payload: dict[str, Any] = {}
    if title is not None:
        payload["title"] = title
    if tags is not None:
        payload["tags"] = _ensure_list(tags)
    if problem is not None:
        payload["problem"] = problem
    if solution is not None:
        payload["solution"] = solution
    if outcome is not None:
        payload["outcome"] = outcome
    if applicable_to is not None:
        payload["applicable_to"] = applicable_to
    if steps is not None:
        payload["steps"] = _ensure_list(steps)
    if append_steps is not None:
        payload["append_steps"] = _ensure_list(append_steps)
    if source_sessions is not None:
        payload["source_sessions"] = _ensure_list(source_sessions)
    try:
        return json.dumps(experience_admin.update_experience(experience_id, payload), ensure_ascii=False)
    except AdminError as e:
        return _admin_error_payload(e)
    except Exception as e:
        return json.dumps({"error": str(e)})


@tool("experience_mark_used", parse_docstring=True)
def experience_mark_used_tool(experience_id: str) -> str:
    """Mark an experience as having been used again (increments use_count).

    Args:
        experience_id: The ID of the experience that was used.
    """
    try:
        return json.dumps(experience_admin.mark_experience_used(experience_id), ensure_ascii=False)
    except AdminError as e:
        return _admin_error_payload(e)
    except Exception as e:
        return json.dumps({"error": str(e)})


@tool("experience_delete", parse_docstring=True)
def experience_delete_tool(experience_id: str, *, permanent: bool = False) -> str:
    """Delete or deprecate an experience entry.

    Args:
        experience_id: The ID of the experience to delete.
        permanent: If True, permanently remove from database (default soft delete).
    """
    try:
        return json.dumps(
            experience_admin.delete_experience(experience_id, permanent=permanent),
            ensure_ascii=False,
        )
    except AdminError as e:
        return _admin_error_payload(e)
    except Exception as e:
        return json.dumps({"error": str(e)})
