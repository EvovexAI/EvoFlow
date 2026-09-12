"""Deprecated: agent teams have been retired in favor of the tag system.

This module is kept ONLY as a backward-compatibility shim so that legacy
schema migrations (v34/v35/v36/v61) and any stale callers can still import
the historical symbols without breaking application startup.  All team
machinery has been removed from the data model:

* the ``team_code`` column on ``evoflow_agents`` was dropped by schema
  migration v82, and
* the ``evoflow_agent_teams`` table was dropped in the same migration.

Grouping is now expressed through ``tags_json`` (see
:mod:`evoflow.config.agent_tags`).  Do not add new code depending on this
module -- it will be removed once the remaining migration files are cleaned
up by a later step.
"""

from __future__ import annotations

from typing import Any

# Historical constant kept as an empty tuple: no built-in teams exist anymore.
BUILTIN_AGENT_TEAMS: tuple[dict[str, Any], ...] = ()


def infer_team_code_for_agent(*, agent_code: str, agent_type: str | None = None) -> str | None:
    """Deprecated: return ``None`` (teams are gone).

    Tag inference is now :func:`evoflow.config.agent_tags.infer_tags_for_agent`.
    Kept only so legacy callers/migrations import successfully.
    """
    return None


def default_team_code_for_new_agent(*, agent_type: str = "custom") -> str | None:
    """Deprecated: return ``None`` (teams are gone)."""
    return None


def sync_builtin_agent_teams(conn: Any) -> None:  # noqa: ARG001
    """Deprecated no-op.

    The ``evoflow_agent_teams`` table no longer exists after schema v82, so
    there is nothing to sync.  Retained so legacy migrations import cleanly.
    """
    return None
