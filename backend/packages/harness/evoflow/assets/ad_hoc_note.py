"""runtime-aligned ad-hoc note filenames + write helper (``extensions/ad_hoc/notes/`` map)."""

from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Any

from evoflow.assets.paths import EntityRef

_TIMESTAMP_PREFIX_LEN = len("YYYY-MM-DDTHH-MM-SS-")
_FILENAME_MAX_BYTES = 128
_SLUG_MAX_BYTES = 80
_SLUG_RE = re.compile(r"[^a-z0-9-]+")


def normalize_ad_hoc_slug(text: str, *, fallback: str = "note") -> str:
    raw = str(text or "").strip().lower()
    slug = _SLUG_RE.sub("-", raw).strip("-")
    if not slug:
        slug = fallback
    while slug.encode("utf-8") and len(slug.encode("utf-8")) > _SLUG_MAX_BYTES:
        slug = slug[:-1].rstrip("-")
    return slug or fallback


def build_ad_hoc_filename(*, slug_hint: str = "", fallback: str = "note") -> str:
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%S")
    slug = normalize_ad_hoc_slug(slug_hint, fallback=fallback)
    name = f"{ts}-{slug}.md"
    if len(name.encode("utf-8")) > _FILENAME_MAX_BYTES:
        raise ValueError("ad_hoc filename too long")
    return name


def validate_ad_hoc_filename(filename: str) -> str | None:
    """Return error string when invalid; ``None`` when OK."""
    name = str(filename or "").strip()
    if not name:
        return "empty filename"
    if len(name.encode("utf-8")) > _FILENAME_MAX_BYTES:
        return "must be at most 128 bytes"
    if not name.endswith(".md"):
        return "must end with .md"
    stem = name[: -len(".md")]
    if len(stem) <= _TIMESTAMP_PREFIX_LEN:
        return "must use YYYY-MM-DDTHH-MM-SS-<slug>.md"
    if not _has_valid_timestamp_prefix(stem):
        return "must use YYYY-MM-DDTHH-MM-SS-<slug>.md"
    slug = stem[_TIMESTAMP_PREFIX_LEN :]
    if not slug or len(slug.encode("utf-8")) > _SLUG_MAX_BYTES:
        return "slug must be 1 to 80 bytes"
    if not all(c.isascii() and (c.islower() or c.isdigit() or c == "-") for c in slug):
        return "slug must contain only lowercase ASCII letters, digits, or hyphens"
    return None


def _has_valid_timestamp_prefix(stem: str) -> bool:
    b = stem.encode("utf-8")
    if len(b) <= _TIMESTAMP_PREFIX_LEN:
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
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    rel = f"memory/_inbox/notes/{filename}"
    body = f"---\nsource: {source}\ncreated: {ts}\n---\n\n[ad-hoc note]\n\n{text}\n"
    return write_text_file(entity, rel, body)
