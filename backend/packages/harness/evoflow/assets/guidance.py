"""Build native-style memory read guidance + catalog for prompt injection."""

from __future__ import annotations

import logging
import os

from evoflow.assets.catalog import format_entity_catalog_xml, read_standing_text, standing_is_placeholder
from evoflow.assets.injection_budget import TIER0_ASSET_TOTAL_CHARS, TIER0_STANDING_CHARS, cap_text_chars
from evoflow.assets.memory_injection import asset_hub_memory_injection
from evoflow.assets.paths import EntityRef, entity_relative_dir, entity_root
from evoflow.assets.prompt_templates import render_memory_prompt

logger = logging.getLogger(__name__)

_LEGACY_AGENT_MEMORY = os.getenv("EVOFLOW_AGENT_MEMORY_LEGACY", "").strip().lower() in (
    "1",
    "true",
    "yes",
)


def is_employee_agent_name(agent_name: str | None) -> bool:
    """True when ``agent_name`` resolves to a proactive employee role."""
    code = str(agent_name or "").strip().lower()
    if not code or code in ("main", "user", "default", "lead_agent"):
        return False
    try:
        from evoflow.proactive.repositories import ProactiveRepository

        return ProactiveRepository.get_role(code) is not None
    except Exception:
        return False


def resolve_profile_entity(
    *,
    agent_name: str | None = None,
    entity_type: str | None = None,
    entity_id: str | None = None,
    principal_id: str = "",
) -> EntityRef:
    """Entity for SOUL / identity reads (agent or employee profile).

    ``principal_id``: authenticated callers read their own personal user
    bucket (``assets/users/<pid>/``) — same bucket the Asset Center shows.
    """
    if entity_type and entity_id:
        return EntityRef(str(entity_type), str(entity_id)).normalized()

    code = str(agent_name or "").strip().lower()
    if code and is_employee_agent_name(code):
        return EntityRef("employee", code).normalized()
    if code and code not in ("main", "user", "default", "lead_agent"):
        try:
            from evoflow.persistence import config_repositories as cfg_repo

            if cfg_repo.agent_exists(code):
                return EntityRef("agent", code).normalized()
        except Exception:
            logger.debug("resolve_profile_entity: agent lookup skipped", exc_info=True)
        try:
            if entity_root(EntityRef("agent", code)).is_dir():
                return EntityRef("agent", code).normalized()
        except Exception:
            pass
    pid = str(principal_id or "").strip()
    if pid:
        from evoflow.assets.paths import sanitize_user_asset_id

        return EntityRef("user", sanitize_user_asset_id(pid)).normalized()
    return EntityRef("user", "user").normalized()


def resolve_memory_entity(
    *,
    agent_name: str | None = None,
    entity_type: str | None = None,
    entity_id: str | None = None,
    principal_id: str = "",
) -> EntityRef:
    """Entity for memory/craft writes and standing injection.

    Agents are configuration shells — dialogue memory always belongs to **user**,
    except proactive **employee** roles which keep independent memory trees.

    ``principal_id``: authenticated callers use their personal user bucket
    (``assets/users/<pid>/``); unauthenticated local keeps the shared ``user``.
    """
    if _LEGACY_AGENT_MEMORY:
        return resolve_session_entity_legacy(
            agent_name=agent_name, entity_type=entity_type, entity_id=entity_id
        )

    if entity_type and entity_id:
        et = str(entity_type).strip().lower()
        eid = str(entity_id).strip()
        if et == "workspace":
            from evoflow.assets.paths import workspace_entity_ref

            return workspace_entity_ref(eid)
        if et == "employee":
            return EntityRef("employee", eid).normalized()
        if et == "user":
            pid = str(principal_id or "").strip()
            if pid:
                from evoflow.assets.paths import sanitize_user_asset_id

                return EntityRef("user", sanitize_user_asset_id(pid)).normalized()
            return EntityRef("user", "user").normalized()
        if et == "agent":
            # Explicit agent memory ops → user (agents have no memory tree).
            pid = str(principal_id or "").strip()
            if pid:
                from evoflow.assets.paths import sanitize_user_asset_id

                return EntityRef("user", sanitize_user_asset_id(pid)).normalized()
            return EntityRef("user", "user").normalized()

    code = str(agent_name or "").strip().lower()
    if code and is_employee_agent_name(code):
        return EntityRef("employee", code).normalized()
    pid = str(principal_id or "").strip()
    if pid:
        from evoflow.assets.paths import sanitize_user_asset_id

        return EntityRef("user", sanitize_user_asset_id(pid)).normalized()
    return EntityRef("user", "user").normalized()


def resolve_session_entity_legacy(
    *,
    agent_name: str | None = None,
    entity_type: str | None = None,
    entity_id: str | None = None,
) -> EntityRef:
    """Pre-refactor mapping (employee > agent > user). Opt-in via env flag."""
    if entity_type and entity_id:
        return EntityRef(str(entity_type), str(entity_id)).normalized()

    code = str(agent_name or "").strip().lower()
    if code and code not in ("main", "user", "default"):
        if is_employee_agent_name(code):
            return EntityRef("employee", code).normalized()
        try:
            from evoflow.persistence import config_repositories as cfg_repo

            if cfg_repo.agent_exists(code):
                return EntityRef("agent", code).normalized()
        except Exception:
            logger.debug("resolve_session_entity_legacy: agent lookup skipped", exc_info=True)
        try:
            if entity_root(EntityRef("agent", code)).is_dir():
                return EntityRef("agent", code).normalized()
            if entity_root(EntityRef("employee", code)).is_dir():
                return EntityRef("employee", code).normalized()
        except Exception:
            pass
    return EntityRef("user", "user").normalized()


def resolve_session_entity(
    *,
    agent_name: str | None = None,
    entity_type: str | None = None,
    entity_id: str | None = None,
    principal_id: str = "",
) -> EntityRef:
    """Alias for memory entity resolution (runtime pipeline write path)."""
    return resolve_memory_entity(
        agent_name=agent_name,
        entity_type=entity_type,
        entity_id=entity_id,
        principal_id=principal_id,
    )


def build_read_path_guidance(entity: EntityRef, *, standing: str | None = None) -> str:
    """Render runtime ``read_path`` template with standing filled in."""
    e = entity.normalized()
    rel = entity_relative_dir(e)
    base = f"assets/{rel}"
    summary = standing if standing is not None else read_standing_text(e, max_chars=TIER0_STANDING_CHARS)
    if asset_hub_memory_injection():
        if standing_is_placeholder(summary) or not str(summary or "").strip():
            return ""
    try:
        layout_lines, cross_entity_note = _entity_layout_lines(e)
        return render_memory_prompt(
            "read_path",
            entity_root=base,
            layout_lines=layout_lines,
            cross_entity_note=cross_entity_note,
            memory_summary=summary or "（尚无站立摘要）",
        )
    except Exception:
        logger.debug("build_read_path_guidance failed", exc_info=True)
        return ""


def _entity_layout_lines(entity: EntityRef) -> tuple[str, str]:
    """Compact layout: root stated once in template; lines are relative paths only."""
    e = entity.normalized()
    lines: list[str] = []

    if e.entity_type == "user":
        lines.append(
            "- profile/basic-info.md · preferences.md · persona.md "
            "(USER_PROFILE when filled)"
        )
    elif e.entity_type == "employee":
        lines.append("- profile/ (SOUL / duty identity)")
    # workspace: no profile tree

    lines.extend(
        [
            "- memory/standing.md (summary below; do not re-open for the same text)",
            "- memory/MEMORY.md (registry — primary search target)",
            "- memory/facts/ (stable facts / conventions)",
            "- memory/episodic/ (process recaps — search, do not bulk-read)",
            "- memory/journal/ (reflections — search, do not bulk-read)",
            "- craft/<name>/SKILL.md (reusable procedures)",
        ]
    )

    cross = ""
    if e.entity_type == "workspace":
        cross = (
            "\nShared (not under this root): user dialogue → `assets/user/memory/` · "
            "agent SOUL → `assets/agents/{code}/profile/`"
        )
    elif e.entity_type == "employee":
        cross = (
            "\nShared: user dialogue → `assets/user/memory/` · "
            "agent SOUL → `assets/agents/{code}/profile/`"
        )

    return "\n".join(lines), cross


def build_entity_memory_injection(
    entity: EntityRef,
    *,
    include_read_guidance: bool = True,
    include_catalog: bool | None = None,
) -> str:
    """Tier-0 block: runtime read_path + standing (catalog off by default in asset-hub memory mode)."""
    e = entity.normalized()
    asset_mode = asset_hub_memory_injection()
    if include_catalog is None:
        include_catalog = not asset_mode
    parts: list[str] = []
    standing = read_standing_text(e, max_chars=TIER0_STANDING_CHARS)
    if asset_mode and (standing_is_placeholder(standing) or not standing.strip()):
        return ""
    if include_read_guidance:
        guide = build_read_path_guidance(e, standing=standing)
        if guide.strip():
            parts.append(guide.strip())
    if include_catalog:
        cat = format_entity_catalog_xml(
            e,
            include_standing=False,
            include_facts=True,
            include_episodes=True,
            include_craft=True,
            tag="catalog",
        )
        if cat.strip():
            parts.append(cat.strip())
    if not parts:
        return ""
    body = "\n\n".join(parts)
    if asset_mode:
        return body
    return cap_text_chars(body, TIER0_ASSET_TOTAL_CHARS)


def build_agent_soul_injection_block(*, agent_name: str | None = None) -> str:
    """Tier-0 pin for custom agent SOUL summary (profile only, not memory)."""
    prof = resolve_profile_entity(agent_name=agent_name)
    if prof.entity_type != "agent":
        return ""
    code = prof.entity_id
    try:
        from evoflow.assets.soul_summary import load_soul_summary_text

        summary = load_soul_summary_text(code).strip()
    except Exception:
        logger.debug("agent soul injection skipped", exc_info=True)
        return ""
    if not summary:
        return ""
    return f'<agent_soul agent="{code}">\n{summary}\n</agent_soul>'


def build_session_asset_memory_block(
    *,
    agent_name: str | None = None,
    principal_id: str = "",
) -> str:
    """User/employee memory Tier-0 + optional agent SOUL summary.

    ``principal_id`` anchors the memory/standing entity to the caller's
    personal bucket so injected content matches what the Asset Center shows.
    """
    try:
        from evoflow.assets.hub import ensure_entity_tree

        memory_ent = resolve_memory_entity(agent_name=agent_name, principal_id=principal_id)
        ensure_entity_tree(memory_ent)
        parts: list[str] = []
        mem = build_entity_memory_injection(memory_ent)
        if mem.strip():
            parts.append(mem.strip())
        soul = build_agent_soul_injection_block(agent_name=agent_name)
        if soul.strip():
            parts.append(soul.strip())
        return "\n\n".join(parts)
    except Exception:
        logger.debug("build_session_asset_memory_block failed", exc_info=True)
        return ""
