"""Normalized agent memory (``evoflow_memory`` + child tables)."""

from __future__ import annotations

import json
from typing import Any

from evoflow.persistence.db import get_db
from evoflow.persistence.timestamps import coerce_iso_z, now_iso_z
from evoflow.timeutil import utc_now_iso_z

_USER_SECTIONS = (
    ("user", "workContext"),
    ("user", "personalContext"),
    ("user", "topOfMind"),
)
_HISTORY_SECTIONS = (
    ("history", "recentMonths"),
    ("history", "earlierContext"),
    ("history", "longTermBackground"),
)
_PROJECT_SECTIONS = (
    ("project", "overview"),
    ("project", "architecture"),
    ("project", "entryPoints"),
    ("project", "conventions"),
    ("project", "gotchas"),
)


def _json_dumps(obj: Any) -> str:
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


def _json_loads(raw: str | None) -> Any:
    if not raw:
        return None
    return json.loads(raw)


def _agent_key(agent_name: str | None) -> str:
    return (agent_name or "").strip()


def _row_dict(row: Any) -> dict[str, Any]:
    return {k: row[k] for k in row.keys()}


def memory_to_rows(document: dict[str, Any], agent_key: str) -> tuple[dict[str, Any], list[dict[str, Any]], list[dict[str, Any]]]:
    doc = dict(document)
    header = {
        "agent_key": agent_key,
        "version": str(doc.get("version") or "1.0"),
        "last_updated": coerce_iso_z(doc.get("lastUpdated") or doc.get("last_updated"), now_if_empty=True),
    }
    section_defs = _USER_SECTIONS + _HISTORY_SECTIONS
    if isinstance(doc.get("project"), dict) or agent_key.startswith("ws-"):
        section_defs = section_defs + _PROJECT_SECTIONS
    sections: list[dict[str, Any]] = []
    for group, kind in section_defs:
        block = (doc.get(group) or {}).get(kind) if isinstance(doc.get(group), dict) else None
        if not isinstance(block, dict):
            block = {}
        sections.append(
            {
                "agent_key": agent_key,
                "section_group": group,
                "section_kind": kind,
                "summary": str(block.get("summary") or ""),
                "section_updated_at": coerce_iso_z(block.get("updatedAt") or block.get("updated_at")),
            }
        )
    facts_out: list[dict[str, Any]] = []
    for idx, fact in enumerate(doc.get("facts") or []):
        if not isinstance(fact, dict):
            continue
        known = {"id", "content", "category", "confidence", "source", "tags", "createdAt", "updatedAt"}
        extra = {k: v for k, v in fact.items() if k not in known}
        facts_out.append(
            {
                "agent_key": agent_key,
                "fact_id": str(fact.get("id") or f"fact-{idx}"),
                "content": str(fact.get("content") or ""),
                "category": str(fact.get("category") or "general"),
                "extra_json": _json_dumps(extra) if extra else "{}",
                "sort_order": idx,
            }
        )
    return header, sections, facts_out


def rows_to_memory(header: dict[str, Any], sections: list[dict[str, Any]], facts: list[dict[str, Any]]) -> dict[str, Any]:
    out: dict[str, Any] = {
        "version": header.get("version") or "1.0",
        "lastUpdated": header.get("last_updated") or utc_now_iso_z(),
        "user": {
            "workContext": {"summary": "", "updatedAt": ""},
            "personalContext": {"summary": "", "updatedAt": ""},
            "topOfMind": {"summary": "", "updatedAt": ""},
        },
        "history": {
            "recentMonths": {"summary": "", "updatedAt": ""},
            "earlierContext": {"summary": "", "updatedAt": ""},
            "longTermBackground": {"summary": "", "updatedAt": ""},
        },
        "project": {
            "overview": {"summary": "", "updatedAt": ""},
            "architecture": {"summary": "", "updatedAt": ""},
            "entryPoints": {"summary": "", "updatedAt": ""},
            "conventions": {"summary": "", "updatedAt": ""},
            "gotchas": {"summary": "", "updatedAt": ""},
        },
        "facts": [],
    }
    for s in sections:
        group = s["section_group"]
        kind = s["section_kind"]
        block = {
            "summary": s.get("summary") or "",
            "updatedAt": s.get("section_updated_at") or "",
        }
        if group == "user" and kind in out["user"]:
            out["user"][kind] = block
        elif group == "history" and kind in out["history"]:
            out["history"][kind] = block
        elif group == "project" and kind in out["project"]:
            out["project"][kind] = block
    for f in sorted(facts, key=lambda r: int(r.get("sort_order") or 0)):
        fact: dict[str, Any] = {
            "id": f.get("fact_id") or "",
            "content": f.get("content") or "",
            "category": f.get("category") or "general",
        }
        extra = _json_loads(f.get("extra_json"))
        if isinstance(extra, dict):
            fact.update(extra)
        out["facts"].append(fact)
    return out


def _delete_children(conn: Any, agent_key: str) -> None:
    conn.execute("DELETE FROM evoflow_memory_sections WHERE agent_key = ?", (agent_key,))
    conn.execute("DELETE FROM evoflow_memory_facts WHERE agent_key = ?", (agent_key,))


def save_memory(agent_name: str | None, document: dict[str, Any]) -> None:
    """Persist memory via unified mem_* (legacy evoflow_memory table no longer written)."""
    from evoflow.agents.memory.storage import get_memory_storage

    key = agent_name if (agent_name or "").strip() else None
    # Workspace / raw keys (ws-…) are valid agent_name slots for storage
    ok = get_memory_storage().save(document if isinstance(document, dict) else {}, key)
    if not ok:
        raise OSError("Failed to save memory to owned mem_*")


def load_memory(agent_name: str | None) -> dict[str, Any] | None:
    """Load memory document from mem_* (migrates legacy once)."""
    from evoflow.memory.document_codec import atoms_to_document, namespace_for_agent_key
    from evoflow.memory.migrate_legacy import ensure_legacy_migrated
    from evoflow.memory.store import namespace_has_atoms

    ensure_legacy_migrated()
    key = agent_name if (agent_name or "").strip() else None
    ns = namespace_for_agent_key(key)
    if not namespace_has_atoms(ns):
        return None
    return atoms_to_document(ns)


def agent_keys_with_memory_content() -> set[str]:
    """Return agent/workspace keys that have mem_* atoms (legacy table ignored)."""
    keys: set[str] = set()
    try:
        from evoflow.knowledge.owned.db import db

        with db() as conn:
            rows = conn.execute(
                """
                SELECT DISTINCT n.kind, n.owner_ref
                FROM mem_namespaces n
                JOIN mem_atoms a ON a.namespace_id = n.id
                WHERE a.deleted_at IS NULL
                """
            ).fetchall()
            for row in rows:
                kind = str(row["kind"] if hasattr(row, "keys") else row[0] or "")
                owner = str(row["owner_ref"] if hasattr(row, "keys") else row[1] or "")
                if kind == "agent":
                    keys.add(owner)
                elif kind == "user" and owner in {"", "default"}:
                    keys.add("")
                elif kind == "workspace":
                    keys.add(owner if owner.startswith("ws-") else f"ws-{owner}")
    except Exception:
        pass
    return keys
