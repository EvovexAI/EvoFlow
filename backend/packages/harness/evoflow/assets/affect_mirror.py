"""Mirror person_affect DB state into ``profile/affect.md`` for Asset Center."""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)


def maybe_mirror_affect_file(agent_code: str, affect: dict[str, Any] | None = None) -> str | None:
    """Write ``profile/affect.md`` under agent or employee entity. Best-effort."""
    code = str(agent_code or "").strip().lower()
    if not code or code in {"user", "system", "main", "default"}:
        return None
    try:
        from evoflow.assets.guidance import is_employee_agent_name
        from evoflow.assets.hub import ensure_entity_tree, write_text_file
        from evoflow.assets.paths import EntityRef
        from evoflow.persistence import person_relations_repositories as rel_repo
        from evoflow.person_affect import mirror_affect_markdown

        aff = affect if isinstance(affect, dict) else rel_repo.get_affect(code)
        body = mirror_affect_markdown(aff)
        if is_employee_agent_name(code):
            ent = EntityRef("employee", code).normalized()
        else:
            ent = EntityRef("agent", code).normalized()
        ensure_entity_tree(ent)
        write_text_file(ent, "profile/affect.md", body)
        return "profile/affect.md"
    except Exception:
        logger.debug("affect mirror skipped for %s", code, exc_info=True)
        return None


def ensure_default_affect_md(entity) -> None:
    """Create default affect.md when missing (entity tree ensure hook).

    Writes via Path directly — must not call ``write_text_file`` / ``ensure_entity_tree``
    (those re-enter this hook and would recurse).
    """
    try:
        from evoflow.assets.paths import profile_path
        from evoflow.person_affect import default_affect_md

        e = entity.normalized() if hasattr(entity, "normalized") else entity
        if getattr(e, "entity_type", "") not in ("agent", "employee"):
            return
        path = profile_path(e, "affect.md")
        if path.is_file():
            return
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(default_affect_md(), encoding="utf-8")
    except Exception:
        logger.debug("ensure_default_affect_md skipped", exc_info=True)
