"""Convert between legacy memory.json document shape and mem_atoms."""

from __future__ import annotations

from typing import Any

from evoflow.memory import facade as mem_facade
from evoflow.memory import store as mem_store
from evoflow.memory.namespaces import agent_ns, workspace_ns
from evoflow.timeutil import utc_now_iso_z

_SECTION_SUBJECTS = (
    ("user", "workContext", "section.user.workContext"),
    ("user", "personalContext", "section.user.personalContext"),
    ("user", "topOfMind", "section.user.topOfMind"),
    ("history", "recentMonths", "section.history.recentMonths"),
    ("history", "earlierContext", "section.history.earlierContext"),
    ("history", "longTermBackground", "section.history.longTermBackground"),
    ("project", "overview", "section.project.overview"),
    ("project", "architecture", "section.project.architecture"),
    ("project", "entryPoints", "section.project.entryPoints"),
    ("project", "conventions", "section.project.conventions"),
    ("project", "gotchas", "section.project.gotchas"),
)


def namespace_for_agent_key(agent_key: str | None) -> str:
    key = (agent_key or "").strip()
    if key.startswith("ws-") or key.startswith("workspace:"):
        return workspace_ns(key)
    # Dialogue memory is user-scoped; agent codes are config shells only.
    from evoflow.memory.namespaces import user_ns

    return user_ns("default")


def document_to_atoms(document: dict[str, Any], *, namespace: str, source: str = "migrate") -> int:
    """Write a legacy memory document into mem_atoms. Returns written count."""
    if not isinstance(document, dict):
        return 0
    n = 0
    for group, kind, subject in _SECTION_SUBJECTS:
        block = (document.get(group) or {}).get(kind) if isinstance(document.get(group), dict) else None
        if not isinstance(block, dict):
            continue
        summary = str(block.get("summary") or "").strip()
        if not summary:
            continue
        pin = kind in {"workContext", "personalContext", "overview", "conventions"}
        aid = mem_facade.remember(
            namespace,
            summary,
            layer="semantic",
            kind=f"section:{group}.{kind}",
            summary=summary,
            confidence=0.9,
            importance=0.85 if pin else 0.7,
            subject_key=subject,
            source=source,
            pin=pin,
            evidence={"legacy_section": f"{group}.{kind}"},
        )
        if aid:
            n += 1

    for fact in document.get("facts") or []:
        if not isinstance(fact, dict):
            continue
        content = str(fact.get("content") or "").strip()
        if not content:
            continue
        fid = str(fact.get("id") or "").strip() or None
        cat = str(fact.get("category") or "fact")
        try:
            conf = float(fact.get("confidence") or 0.7)
        except (TypeError, ValueError):
            conf = 0.7
        aid = mem_facade.remember(
            namespace,
            content,
            layer="semantic",
            kind=cat or "fact",
            confidence=conf,
            importance=conf,
            subject_key=f"fact:{fid}" if fid else "",
            atom_id=fid,
            source=source,
            evidence={"legacy_fact_id": fid or ""},
            tags=list(fact.get("tags") or []) if isinstance(fact.get("tags"), list) else None,
        )
        if aid:
            n += 1
    return n


def atoms_to_document(namespace: str) -> dict[str, Any]:
    """Rebuild legacy document shape from mem_atoms for UI / updater prompts."""
    atoms = mem_store.list_namespace_atoms(namespace, limit=500)
    out: dict[str, Any] = {
        "version": "1.0",
        "lastUpdated": utc_now_iso_z(),
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
    latest = ""
    for atom in atoms:
        latest = max(latest, str(atom.get("updated_at") or ""))
        sk = str(atom.get("subject_key") or "")
        kind = str(atom.get("kind") or "")
        text = str(atom.get("content") or "")
        updated = str(atom.get("updated_at") or "")
        placed = False
        for group, section, subject in _SECTION_SUBJECTS:
            if sk == subject or kind == f"section:{group}.{section}":
                out[group][section] = {"summary": text, "updatedAt": updated}
                placed = True
                break
        if placed:
            continue
        # Regular facts
        out["facts"].append(
            {
                "id": atom.get("id"),
                "content": text,
                "category": kind if not kind.startswith("section:") else "context",
                "confidence": float(atom.get("confidence") or 0.7),
                "createdAt": atom.get("created_at") or "",
                "updatedAt": updated,
                "source": atom.get("source") or "",
            }
        )
    if latest:
        out["lastUpdated"] = latest
    return out


def save_document(document: dict[str, Any], *, namespace: str) -> bool:
    """Replace namespace content with document (section+facts sync).

    Strategy: upsert all sections/facts by subject_key; soft-delete atoms whose
    subject_keys are no longer present (legacy fact ids / section keys only).
    """
    if not isinstance(document, dict):
        return False
    keep_subjects: set[str] = set()
    keep_ids: set[str] = set()

    for group, kind, subject in _SECTION_SUBJECTS:
        block = (document.get(group) or {}).get(kind) if isinstance(document.get(group), dict) else None
        if not isinstance(block, dict):
            continue
        summary = str(block.get("summary") or "").strip()
        keep_subjects.add(subject)
        if not summary:
            # Clear section
            for atom in mem_store.list_namespace_atoms(namespace, limit=500):
                if atom.get("subject_key") == subject:
                    mem_store.soft_delete_atom(atom["id"])
            continue
        pin = kind in {"workContext", "personalContext", "overview", "conventions"}
        aid = mem_facade.remember(
            namespace,
            summary,
            layer="semantic",
            kind=f"section:{group}.{kind}",
            confidence=0.9,
            importance=0.85 if pin else 0.7,
            subject_key=subject,
            source="updater",
            pin=pin,
        )
        if aid:
            keep_ids.add(aid)

    for fact in document.get("facts") or []:
        if not isinstance(fact, dict):
            continue
        content = str(fact.get("content") or "").strip()
        if not content:
            continue
        fid = str(fact.get("id") or "").strip()
        cat = str(fact.get("category") or "fact")
        try:
            conf = float(fact.get("confidence") or 0.7)
        except (TypeError, ValueError):
            conf = 0.7
        subject = f"fact:{fid}" if fid else ""
        if subject:
            keep_subjects.add(subject)
        aid = mem_facade.remember(
            namespace,
            content,
            layer="semantic",
            kind=cat,
            confidence=conf,
            importance=conf,
            subject_key=subject,
            atom_id=fid or None,
            source=str(fact.get("source") or "updater"),
        )
        if aid:
            keep_ids.add(aid)
            keep_subjects.add(f"fact:{aid}")

    # Soft-delete stale legacy-mapped atoms (sections/facts only)
    for atom in mem_store.list_namespace_atoms(namespace, limit=1000):
        sk = str(atom.get("subject_key") or "")
        kind = str(atom.get("kind") or "")
        is_legacy = sk.startswith("section.") or sk.startswith("fact:") or kind.startswith("section:")
        if not is_legacy:
            continue
        if atom["id"] in keep_ids:
            continue
        if sk and sk in keep_subjects:
            continue
        # fact without subject still kept if id kept
        if atom["id"] not in keep_ids:
            mem_store.soft_delete_atom(atom["id"])
    try:
        from evoflow.memory.kg_extract import flush_kg_batch

        flush_kg_batch(namespace)
    except Exception:
        pass
    try:
        from evoflow.assets.memory_mirror import mirror_memory_document

        mirror_memory_document(namespace, document)
    except Exception as exc:
        import logging

        logging.getLogger(__name__).debug("asset memory mirror skipped: %s", exc)
    return True
