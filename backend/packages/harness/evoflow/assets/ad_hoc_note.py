"""Ad-hoc inbox notes: slug filename; created timestamp lives in frontmatter."""

from __future__ import annotations

import re
from datetime import UTC, datetime
from typing import Any

from evoflow.assets.paths import EntityRef

_FILENAME_MAX_BYTES = 128
_SLUG_MAX_BYTES = 80
_SLUG_RE = re.compile(r"[^a-z0-9-]+")
# Legacy writes used YYYY-MM-DDTHH-MM-SS-<slug>.md — still accepted when reading.
_LEGACY_TS_PREFIX_LEN = len("YYYY-MM-DDTHH-MM-SS-")


def normalize_ad_hoc_slug(text: str, *, fallback: str = "note") -> str:
    raw = str(text or "").strip().lower()
    slug = _SLUG_RE.sub("-", raw).strip("-")
    if not slug:
        slug = fallback
    while slug.encode("utf-8") and len(slug.encode("utf-8")) > _SLUG_MAX_BYTES:
        slug = slug[:-1].rstrip("-")
    return slug or fallback


def build_ad_hoc_filename(*, slug_hint: str = "", fallback: str = "note") -> str:
    """Return ``<slug>.md`` — time belongs in note body/frontmatter, not the name."""
    slug = normalize_ad_hoc_slug(slug_hint, fallback=fallback)
    name = f"{slug}.md"
    if len(name.encode("utf-8")) > _FILENAME_MAX_BYTES:
        raise ValueError("ad_hoc filename too long")
    return name


def validate_ad_hoc_filename(filename: str) -> str | None:
    """Return error string when invalid; ``None`` when OK.

    Accepts ``<slug>.md`` (preferred) and legacy ``YYYY-MM-DDTHH-MM-SS-<slug>.md``.
    """
    name = str(filename or "").strip()
    if not name:
        return "empty filename"
    if len(name.encode("utf-8")) > _FILENAME_MAX_BYTES:
        return "must be at most 128 bytes"
    if not name.endswith(".md"):
        return "must end with .md"
    stem = name[: -len(".md")]
    if not stem:
        return "must use <slug>.md"
    if _has_valid_timestamp_prefix(stem):
        slug = stem[_LEGACY_TS_PREFIX_LEN:]
    else:
        slug = stem
    if not slug or len(slug.encode("utf-8")) > _SLUG_MAX_BYTES:
        return "slug must be 1 to 80 bytes"
    if not all(c.isascii() and (c.islower() or c.isdigit() or c == "-") for c in slug):
        return "slug must contain only lowercase ASCII letters, digits, or hyphens"
    return None


def _has_valid_timestamp_prefix(stem: str) -> bool:
    b = stem.encode("utf-8")
    if len(b) <= _LEGACY_TS_PREFIX_LEN:
        return False
    return (
        b[4] == ord("-")
        and b[7] == ord("-")
        and b[10] == ord("T")
        and b[13] == ord("-")
        and b[16] == ord("-")
        and b[19] == ord("-")
        and b[0:4].isdigit()
        and b[5:7].isdigit()
        and b[8:10].isdigit()
        and b[11:13].isdigit()
        and b[14:16].isdigit()
        and b[17:19].isdigit()
    )


def _unique_note_rel(entity: EntityRef, filename: str) -> str:
    """Avoid clobbering: slug.md, then slug-2.md, slug-3.md, …"""
    from evoflow.assets.paths import resolve_entity_file

    base = filename[: -len(".md")] if filename.endswith(".md") else filename
    for i in range(1, 100):
        name = f"{base}.md" if i == 1 else f"{base}-{i}.md"
        err = validate_ad_hoc_filename(name)
        if err:
            continue
        rel = f"memory/_inbox/notes/{name}"
        path = resolve_entity_file(entity, rel)
        if not path.is_file():
            return rel
    raise ValueError("ad_hoc note name collision")


def write_ad_hoc_note(
    entity: EntityRef,
    content: str,
    *,
    slug_hint: str = "",
    source: str = "assets.note",
) -> dict[str, Any]:
    """Write one note under ``memory/_inbox/notes/`` (Phase2 merges later)."""
    from evoflow.assets.hub import ensure_entity_tree, write_text_file

    text = str(content or "").strip()
    if not text:
        raise ValueError("empty_content")
    if len(text) > 4000:
        text = text[:3999] + "…"
    ensure_entity_tree(entity)
    filename = build_ad_hoc_filename(slug_hint=slug_hint or text.splitlines()[0][:40])
    err = validate_ad_hoc_filename(filename)
    if err:
        raise ValueError(err)
    ts = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    rel = _unique_note_rel(entity, filename)
    body = f"---\nsource: {source}\ncreated: {ts}\n---\n\n{text}\n"
    return write_text_file(entity, rel, body)


def format_pending_inbox_notes_for_prompt(
    entity: EntityRef,
    *,
    limit: int = 6,
    max_chars: int = 900,
) -> str:
    """Inject pending ``_inbox/notes`` until Phase2 consolidates them into standing/craft.

    Without this, a note written mid-chat is invisible until consolidation finishes.
    """
    from evoflow.assets.catalog import parse_frontmatter
    from evoflow.assets.paths import entity_root

    notes_dir = entity_root(entity.normalized()) / "memory" / "_inbox" / "notes"
    if not notes_dir.is_dir():
        return ""
    files = sorted(
        (p for p in notes_dir.glob("*.md") if p.is_file() and p.name.lower() != "readme.md"),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )[: max(1, limit)]
    if not files:
        return ""

    lines: list[str] = []
    used = 0
    for path in files:
        try:
            raw = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        meta, body = parse_frontmatter(raw)
        created = str(meta.get("created") or "").strip() or "?"
        body = str(body or "").strip()
        # Drop first-line tag noise for a one-line preview.
        preview_lines = [ln.strip() for ln in body.splitlines() if ln.strip()]
        preview = " ".join(preview_lines)[:180]
        if not preview:
            continue
        line = f"- [{created}|{path.name}] {preview}"
        if used + len(line) > max_chars:
            break
        lines.append(line)
        used += len(line) + 1
    if not lines:
        return ""
    return (
        "<!-- pending inbox notes: injected until Phase2 consolidates -->\n"
        + "\n".join(lines)
    )
