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
_ORPHAN_ENTRIES_RE = re.compile(
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
# Tolerate spaces around ``|note=`` (models often insert them).
_ENTRY_LINE_RE = re.compile(
    r"^(?P<path>[^:\s|][^:|\n]*?)(?::(?P<start>\d+)-(?P<end>\d+))?"
    r"(?:\s*\|\s*note\s*=\s*\[(?P<note>.*?)\])?\s*$",
    re.IGNORECASE,
)
_LOOSE_ENTRIES_LABEL_RE = re.compile(r"^\s*citation_entries\s*:\s*(.*)$", re.IGNORECASE)


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


def _parse_entry_line(line: str) -> dict[str, Any] | None:
    em = _ENTRY_LINE_RE.match(line)
    if not em:
        return None
    path = str(em.group("path") or "").strip()
    if not path:
        return None
    return {
        "path": path,
        "lineStart": int(em.group("start")) if em.group("start") else None,
        "lineEnd": int(em.group("end")) if em.group("end") else None,
        "note": str(em.group("note") or "").strip(),
    }


def parse_citation_entries(block_inner: str) -> list[dict[str, Any]]:
    m = _ENTRIES_RE.search(str(block_inner or ""))
    body = m.group(1) if m else str(block_inner or "")
    entries: list[dict[str, Any]] = []
    for raw_line in body.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("<"):
            continue
        parsed = _parse_entry_line(line)
        if parsed:
            entries.append(parsed)
    return entries


def _strip_loose_citation_entry_leaks(raw: str) -> tuple[str, list[dict[str, Any]]]:
    """Strip model-leaked ``citation_entries: …`` lines without XML wrapper."""
    entries: list[dict[str, Any]] = []
    lines = str(raw or "").splitlines()
    out: list[str] = []
    i = 0
    while i < len(lines):
        line = lines[i]
        label = _LOOSE_ENTRIES_LABEL_RE.match(line)
        if not label:
            out.append(line)
            i += 1
            continue
        rest = str(label.group(1) or "").strip()
        if rest:
            parsed = _parse_entry_line(rest)
            if parsed:
                entries.append(parsed)
            i += 1
            continue
        i += 1
        while i < len(lines):
            next_line = lines[i].strip()
            if not next_line or next_line.startswith("<"):
                break
            if _LOOSE_ENTRIES_LABEL_RE.match(next_line):
                break
            parsed = _parse_entry_line(next_line)
            if not parsed:
                break
            entries.append(parsed)
            i += 1
    cleaned = "\n".join(out)
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned).rstrip()
    return cleaned, entries


def _dedupe_entries(entries: list[dict[str, Any]]) -> list[dict[str, Any]]:
    seen: set[str] = set()
    uniq: list[dict[str, Any]] = []
    for e in entries:
        key = f"{e.get('path')}|{e.get('note')}"
        if key in seen:
            continue
        seen.add(key)
        uniq.append(e)
    return uniq


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

    def _orphan_repl(match: re.Match[str]) -> str:
        entries.extend(parse_citation_entries(match.group(1)))
        return ""

    cleaned = _ORPHAN_ENTRIES_RE.sub(_orphan_repl, cleaned)
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned).rstrip()
    if raw.endswith("\n") and cleaned:
        cleaned = cleaned + "\n"

    loose_text, loose_entries = _strip_loose_citation_entry_leaks(cleaned)
    entries.extend(loose_entries)
    return {
        "text": loose_text,
        "entries": _dedupe_entries(entries),
        "rollout_ids": rollout_ids,
    }


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
            # Skip bare knowledge-base ids — not asset paths.
            if re.fullmatch(r"kb_[a-z0-9]+", path, re.IGNORECASE):
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
