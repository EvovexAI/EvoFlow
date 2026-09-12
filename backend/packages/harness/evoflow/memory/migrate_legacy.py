"""One-shot migration from legacy evoflow_memory / person_memory into mem_*."""

from __future__ import annotations

import logging
from typing import Any

from evoflow.memory import facade as mem_facade
from evoflow.memory import store as mem_store
from evoflow.memory.document_codec import document_to_atoms, namespace_for_agent_key
from evoflow.memory.namespaces import person_ns

logger = logging.getLogger(__name__)

# v1 flagged-complete after a broken get_db() context-manager call; v2 re-runs for real.
_FLAG_USER = "mem_migrated_evoflow_memory_v2"
_FLAG_PERSON = "mem_migrated_person_memory_v2"


def ensure_legacy_migrated() -> None:
    """Idempotent: migrate old SQLite memory tables into owned mem_* once."""
    try:
        _migrate_user_memory()
    except Exception:
        logger.exception("legacy user memory migration failed")
    try:
        _migrate_person_memory()
    except Exception:
        logger.exception("legacy person memory migration failed")


def _load_legacy_document(agent_key: str) -> dict[str, Any] | None:
    """Read normalized document from evoflow_memory_* (not mem_*)."""
    from evoflow.persistence.db import get_db
    from evoflow.persistence.memory_repositories import rows_to_memory

    key = (agent_key or "").strip()
    conn = get_db()
    header_row = conn.execute(
        "SELECT agent_key, version, last_updated FROM evoflow_memory WHERE agent_key = ?",
        (key,),
    ).fetchone()
    if not header_row:
        return None
    header = {k: header_row[k] for k in header_row.keys()}
    sections = [
        {k: r[k] for k in r.keys()}
        for r in conn.execute(
            """
            SELECT agent_key, section_group, section_kind, summary, section_updated_at
            FROM evoflow_memory_sections WHERE agent_key = ?
            """,
            (key,),
        ).fetchall()
    ]
    facts = [
        {k: r[k] for k in r.keys()}
        for r in conn.execute(
            """
            SELECT agent_key, fact_id, content, category, extra_json, sort_order
            FROM evoflow_memory_facts WHERE agent_key = ?
            ORDER BY sort_order ASC
            """,
            (key,),
        ).fetchall()
    ]
    return rows_to_memory(header, sections, facts)


def _migrate_user_memory() -> None:
    if mem_store.migration_flag(_FLAG_USER) == "1":
        return
    try:
        from evoflow.persistence.db import get_db
    except Exception as exc:
        logger.debug("skip user memory migrate: %s", exc)
        mem_store.set_migration_flag(_FLAG_USER, "1")
        return

    try:
        conn = get_db()
        rows = conn.execute("SELECT agent_key FROM evoflow_memory").fetchall()
        keys = [r["agent_key"] if hasattr(r, "keys") else r[0] for r in rows]
    except Exception as exc:
        logger.info("no evoflow_memory table or empty: %s", exc)
        mem_store.set_migration_flag(_FLAG_USER, "1")
        return

    if not keys:
        keys = [""]

    total = 0
    for key in keys:
        agent_key = key if key is not None else ""
        try:
            doc = _load_legacy_document(agent_key)
        except Exception:
            logger.exception("load legacy memory failed key=%r", agent_key)
            continue
        if not isinstance(doc, dict):
            continue
        ns = namespace_for_agent_key(agent_key if agent_key else None)
        # Upsert by subject_key / fact id — safe to re-run over existing mem_* atoms
        written = document_to_atoms(doc, namespace=ns, source="migrate")
        total += written
        if written:
            logger.info("migrated agent_key=%r → %s atoms=%s", agent_key, ns, written)
    logger.info("migrated legacy evoflow_memory → mem_atoms atoms≈%s", total)
    mem_store.set_migration_flag(_FLAG_USER, "1")


def _migrate_person_memory() -> None:
    if mem_store.migration_flag(_FLAG_PERSON) == "1":
        return
    try:
        from evoflow.persistence.db import get_db
    except Exception:
        mem_store.set_migration_flag(_FLAG_PERSON, "1")
        return

    try:
        conn = get_db()
        rows = conn.execute(
            """
            SELECT id, agent_code, layer, content, importance, vitality,
                   round_id, source, created_at, status, kind, title,
                   evidence_json, hit_count, skill_name, access_tier
            FROM evoflow_person_memory_entries
            ORDER BY created_at ASC
            """
        ).fetchall()
    except Exception as exc:
        logger.info("no person memory table or empty: %s", exc)
        mem_store.set_migration_flag(_FLAG_PERSON, "1")
        return

    n = 0
    for row in rows:
        d = {k: row[k] for k in row.keys()} if hasattr(row, "keys") else {}
        if not d:
            continue
        code = str(d.get("agent_code") or "").strip().lower()
        content = str(d.get("content") or "").strip()
        if not code or not content:
            continue
        ns = person_ns(code)
        layer = str(d.get("layer") or "episodic")
        kind = str(d.get("kind") or layer)
        pin = str(d.get("access_tier") or "") == "core"
        evidence: dict[str, Any] = {"legacy_person_id": d.get("id")}
        raw_ev = d.get("evidence_json")
        if raw_ev:
            try:
                import json

                parsed = json.loads(raw_ev) if isinstance(raw_ev, str) else raw_ev
                if isinstance(parsed, dict):
                    evidence.update(parsed)
            except Exception:
                pass
        legacy_id = str(d.get("id") or "").strip()
        aid = mem_facade.remember(
            ns,
            content,
            layer=layer,
            kind=kind or "episodic",
            summary=str(d.get("title") or ""),
            importance=float(d.get("importance") or 0.5),
            confidence=0.85,
            vitality=float(d.get("vitality") or 1.0),
            # Prefer subject upsert so re-runs don't collide on primary key
            subject_key=f"person:{legacy_id}" if legacy_id else f"person:{code}:{hash(content) & 0xFFFFFFFF:x}",
            atom_id=None,
            source=str(d.get("source") or "migrate"),
            pin=pin,
            evidence=evidence,
            tags=[str(d.get("status") or ""), str(d.get("skill_name") or "")],
        )
        if aid:
            n += 1
    logger.info("migrated legacy person_memory → mem_atoms atoms≈%s", n)
    mem_store.set_migration_flag(_FLAG_PERSON, "1")
