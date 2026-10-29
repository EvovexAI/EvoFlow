"""Thin helpers: record Asset Hub Phase1/Phase2 runs into the DB log."""

from __future__ import annotations

import logging
from typing import Any

from evoflow.assets.paths import EntityRef

logger = logging.getLogger(__name__)


def record_asset_phase_run(
    *,
    phase: str,
    trigger: str,
    result: dict[str, Any] | None = None,
    entity: EntityRef | None = None,
    thread_id: str = "",
    agent_name: str = "",
    principal_id: str = "",
    error: str | None = None,
    detail: dict[str, Any] | None = None,
) -> str | None:
    """Best-effort persist one Phase1/Phase2 outcome. Never raises."""
    try:
        from evoflow.persistence.asset_memory_run_repositories import record_phase_result

        et = ""
        eid = ""
        if entity is not None:
            try:
                n = entity.normalized()
                et = str(n.entity_type or "")
                eid = str(n.entity_id or "")
            except Exception:
                pass
        return record_phase_result(
            phase=phase,
            trigger=trigger,
            result=result,
            entity_type=et,
            entity_id=eid,
            thread_id=thread_id,
            agent_name=agent_name,
            principal_id=principal_id,
            error=error,
            detail=detail,
        )
    except Exception:
        logger.debug("record_asset_phase_run failed", exc_info=True)
        return None
