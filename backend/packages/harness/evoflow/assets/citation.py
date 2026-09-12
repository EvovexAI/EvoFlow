"""Parse / strip ``<evo-asset-citation>`` blocks (runtime-aligned citation protocol)."""

from __future__ import annotations

import re
from typing import Any

_CITATION_BLOCK_RE = re.compile(
    r"<evo-asset-citation>\s*(.*?)\s*</evo-asset-citation>",
    re.DOTALL | re.IGNORECASE,
)
_ENTRIES_RE = re.compile(
    r"<citation_entries>\s*(.*?)\s*</citation_entries>",
    re.DOTALL | re.IGNORECASE,
)
_ROLLOUT_IDS_RE = re.compile(
    r"<rollout_ids>\s*(.*?)\s*</rollout_ids>",
    re.DOTALL | re.IGNORECASE,
)
_THREAD_IDS_RE = re.compile(
    r"<thread_ids>\s*(.*?)\s*</thread_ids>",
    re.DOTALL | re.IGNORECASE,
)
_ENTRY_LINE_RE = re.compile(
    r"^(?P<path>[^:\s][^:]*?)(?::(?P<start>\d+)-(?P<end>\d+))?"
    r"(?:\|note=\[(?P<note>.*?)\])?\s*$"
)


def parse_rollout_ids(block_inner: str) -> list[str]:
    """Parse ``<rollout_ids>`` or legacy ``<thread_ids>``."""
    raw = str(block_inner or "")
    body = ""
    for pattern in (_ROLLOUT_IDS_RE, _THREAD_IDS_RE):
        m = pattern.search(raw)
        if m:
            body = m.group(1)
            break
    ids: list[str] = []
    seen: set[str] = set()
    for line in body.splitlines():
        tid = line.strip()
        if not tid or tid in seen:
            continue
        seen.add(tid)
        ids.append(tid)
    return ids


def parse_citation_entries(block_inner: str) -> list[dict[str, Any]]:
    m = _ENTRIES_RE.search(str(block_inner or ""))
    body = m.group(1) if m else str(block_inner or "")
    entries: list[dict[str, Any]] = []
    for raw_line in body.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("<"):
            continue
        em = _ENTRY_LINE_RE.match(line)
        if not em:
            continue
        path = str(em.group("path") or "").strip()
        if not path:
            continue
        entries.append(
            {
                "path": path,
                "lineStart": int(em.group("start")) if em.group("start") else None,
                "lineEnd": int(em.group("end")) if em.group("end") else None,
                "note": str(em.group("note") or "").strip(),
            }
        )
    return entries


def extract_evo_asset_citations(text: str) -> dict[str, Any]:
    """Return ``{text, entries, rollout_ids}`` with citation blocks stripped from ``text``."""
    raw = str(text or "")
    entries: list[dict[str, Any]] = []
    rollout_ids: list[str] = []
    seen_rollout: set[str] = set()

    def _repl(match: re.Match[str]) -> str:
        inner = match.group(1)
        entries.extend(parse_citation_entries(inner))
        for tid in parse_rollout_ids(inner):
            if tid not in seen_rollout:
                seen_rollout.add(tid)
                rollout_ids.append(tid)
        return ""

    cleaned = _CITATION_BLOCK_RE.sub(_repl, raw)
    # Collapse trailing whitespace left by stripped block
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned).rstrip() + ("\n" if raw.endswith("\n") and cleaned else "")
    # Dedupe by path+note
    seen: set[str] = set()
    uniq: list[dict[str, Any]] = []
    for e in entries:
        key = f"{e.get('path')}|{e.get('note')}"
        if key in seen:
            continue
        seen.add(key)
        uniq.append(e)
    return {"text": cleaned, "entries": uniq, "rollout_ids": rollout_ids}


def strip_evo_asset_citations(text: str) -> str:
    return str(extract_evo_asset_citations(text).get("text") or "")


def record_citations_from_messages(
    messages: list[Any],
    *,
    agent_name: str | None = None,
    entity: Any | None = None,
) -> dict[str, Any]:
    """Persist ``cite_count`` for paths cited in final assistant replies."""
    from evoflow.agents.memory.conversation_filter import (
        _is_final_assistant_message,
        format_message_plain_text,
    )
    from evoflow.assets.guidance import resolve_session_entity
    from evoflow.assets.paths import EntityRef
    from evoflow.assets.usage import touch_asset_citations

    try:
        ent = entity or resolve_session_entity(agent_name=agent_name)
        if not isinstance(ent, EntityRef):
            ent = EntityRef(entity_type=ent.entity_type, entity_id=ent.entity_id).normalized()
    except Exception as exc:
        return {"ok": False, "error": str(exc)}

    paths: list[str] = []
    rollout_ids: list[str] = []
    seen: set[str] = set()
    seen_rollout: set[str] = set()
    for msg in messages or []:
        if not _is_final_assistant_message(msg):
            continue
        text = format_message_plain_text(msg).strip()
        if not text:
            continue
        parsed = extract_evo_asset_citations(text)
        for entry in parsed.get("entries") or []:
            path = str(entry.get("path") or "").replace("\\", "/").lstrip("/")
            if not path or path in seen:
                continue
            seen.add(path)
            paths.append(path)
        for tid in parsed.get("rollout_ids") or []:
            if tid not in seen_rollout:
                seen_rollout.add(tid)
                rollout_ids.append(tid)

    if not paths:
        return {"ok": True, "recorded": 0, "paths": [], "rollout_ids": rollout_ids}

    recorded = touch_asset_citations(ent, paths)
    return {"ok": True, "recorded": recorded, "paths": paths, "rollout_ids": rollout_ids}
