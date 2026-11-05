"""Ad-hoc inbox notes: slug filename; created timestamp lives in frontmatter.

If the model omits a visible time in the Markdown body, ``ensure_body_recorded_at``
adds a ``记录时间：`` line (local clock). Frontmatter ``created`` is always set.
"""

from __future__ import annotations

import re
import secrets
from datetime import UTC, datetime
from typing import Any

from evoflow.assets.paths import EntityRef

_FILENAME_MAX_BYTES = 128
_SLUG_MAX_BYTES = 80
# CJK-aware: 记忆/笔记标题多为中文，文件名保持可读（目录名仍是 ASCII 约定）。
_SLUG_RE = re.compile(r"[^a-zA-Z0-9\u4e00-\u9fff-]+")
# Legacy writes used YYYY-MM-DDTHH-MM-SS-<slug>.md — still accepted when reading.
_LEGACY_TS_PREFIX_LEN = len("YYYY-MM-DDTHH-MM-SS-")
_TAG_LINE_RE = re.compile(
    r"^\[(preference|process|experience|reflection|project)\]\s*",
    re.IGNORECASE,
)
# Body already stamped by model or a prior ensure pass.
_BODY_HAS_TIME_RE = re.compile(
    r"(记录时间|记下时间|发生时间|日期\s*[:：]|created(?:_at)?\s*[:：]|"
    r"recorded(?:_at)?\s*[:：]|\b\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2})?)",
    re.IGNORECASE,
)


def ensure_body_recorded_at(content: str, *, when: datetime | None = None) -> str:
    """If Markdown body has no visible time, insert ``记录时间：YYYY-MM-DD HH:MM``.

    Keeps optional first-line ``[tag] …`` above the stamp. Idempotent when a date
    or ``记录时间`` already appears in the body (frontmatter ignored for the check).
    """
    raw = str(content or "")
    if not raw.strip():
        return raw

    fm = ""
    body = raw
    if body.lstrip().startswith("---"):
        parts = body.split("---", 2)
        if len(parts) >= 3:
            fm = f"---{parts[1]}---\n"
            body = parts[2].lstrip("\n")

    if _BODY_HAS_TIME_RE.search(body):
        return raw

    stamp_dt = when or datetime.now().astimezone()
    stamp = stamp_dt.strftime("%Y-%m-%d %H:%M")
    line = f"记录时间：{stamp}"

    lines = body.splitlines()
    if lines and _TAG_LINE_RE.match(lines[0].strip()):
        rest = "\n".join(lines[1:]).lstrip("\n")
        stamped = f"{lines[0].rstrip()}\n{line}\n" + (f"\n{rest}" if rest else "")
    elif lines and lines[0].lstrip().startswith("#"):
        rest = "\n".join(lines[1:]).lstrip("\n")
        stamped = f"{lines[0].rstrip()}\n\n{line}\n" + (f"\n{rest}" if rest else "")
    else:
        stamped = f"{line}\n\n{body.lstrip()}"

    out = (fm + stamped).rstrip() + "\n"
    return out


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
    if not all(
        c == "-" or c.isdigit() or ("a" <= c <= "z") or ("\u4e00" <= c <= "\u9fff") for c in slug
    ):
        return "slug must contain only CJK, lowercase ASCII letters, digits, or hyphens"
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
    """Avoid clobbering: ``slug.md``，冲突时追加短随机后缀。

    随机后缀替代旧的 ``-2/-3`` 计数循环：计数是 TOCTOU，并发写同标题的两条
    笔记会互相整文件覆盖。
    """
    from evoflow.assets.paths import resolve_entity_file

    base = filename[: -len(".md")] if filename.endswith(".md") else filename
    candidates = [f"{base}.md"]
    candidates += [f"{base}-{secrets.token_hex(2)}.md" for _ in range(5)]
    for name in candidates:
        err = validate_ad_hoc_filename(name)
        if err:
            continue
        rel = f"memory/_inbox/notes/{name}"
        path = resolve_entity_file(entity, rel)
        if not path.is_file():
            return rel
    raise ValueError("ad_hoc note name collision")


def parse_note_tag(content: str) -> tuple[str, str]:
    """Return ``(tag, body)``. Untagged defaults to ``process`` (legacy tag-in-body)."""
    text = str(content or "").strip()
    if not text:
        return "process", ""
    lines = text.splitlines()
    m = _TAG_LINE_RE.match(lines[0].strip())
    if not m:
        return "process", text
    tag = m.group(1).strip().lower()
    if tag == "project":
        tag = "process"
    rest = "\n".join(lines[1:]).strip()
    trailing = _TAG_LINE_RE.sub("", lines[0].strip(), count=1).strip()
    if trailing and rest:
        body = f"{trailing}\n{rest}"
    elif trailing:
        body = trailing
    else:
        body = rest or text
    return tag, body


def normalize_note_kind(kind: str) -> str:
    """Map tool ``kind`` aliases → preference|process|experience|reflection."""
    k = str(kind or "").strip().lower()
    aliases = {
        "preference": "preference",
        "pref": "preference",
        "standing": "preference",
        "long_term": "preference",
        "process": "process",
        "episodic": "process",
        "project": "process",
        "experience": "experience",
        "craft": "experience",
        "reflection": "reflection",
        "journal": "reflection",
    }
    return aliases.get(k, "")


def write_ad_hoc_note(
    entity: EntityRef,
    content: str,
    *,
    kind: str = "",
    mode: str = "",
    slug_hint: str = "",
    update_path: str = "",
    source: str = "assets.note",
) -> dict[str, Any]:
    """Write one note **directly** to its durable home (no inbox hop).

    Prefer explicit ``kind`` (preference|process|experience|reflection).
    Legacy first-line ``[tag]`` still works when ``kind`` is omitted.

    ``mode=replace`` + standing path → overwrite ``memory/standing.md``.
    Otherwise preference appends. Create unless ``update_path`` is set.
    """
    from evoflow.assets.hub import (
        append_standing_long_term,
        save_craft_note,
        write_episode,
        write_journal,
        write_text_file,
    )

    text = str(content or "").strip()
    if not text:
        raise ValueError("empty_content")
    if len(text) > 4000:
        text = text[:3999] + "…"

    explicit = normalize_note_kind(kind)
    if explicit:
        tag = explicit
        first = (text.splitlines() or [""])[0].strip()
        # Drop redundant leading [tag] if model still pasted one.
        if _TAG_LINE_RE.match(first):
            _, body = parse_note_tag(text)
        else:
            body = text
    else:
        tag, body = parse_note_tag(text)

    body = ensure_body_recorded_at(body if body else text).strip()
    if not body:
        raise ValueError("empty_content")

    hint = str(slug_hint or "").strip() or body.splitlines()[0].lstrip("#[] ").strip()[:60]
    upd = str(update_path or "").replace("\\", "/").lstrip("/")
    mode_l = str(mode or "").strip().lower()

    if tag == "preference":
        if mode_l == "replace":
            data = write_text_file(
                entity, "memory/standing.md", body if body.endswith("\n") else body + "\n"
            )
            return {**data, "kind": "standing", "tag": tag, "source": source, "updated": True}
        data = append_standing_long_term(entity, body)
        return {**data, "kind": "standing", "tag": tag, "source": source, "updated": False}
    if tag == "experience":
        data = save_craft_note(
            entity,
            title=hint or "经验",
            content=body,
            description=hint[:30],
            update_path=upd if upd.startswith("craft/") else "",
        )
        return {**data, "kind": "craft", "tag": tag, "source": source}
    if tag == "reflection":
        data = write_journal(
            entity,
            body,
            title=hint,
            append=not bool(upd),
            summary=hint[:30],
            update_path=upd if upd.startswith("memory/journal/") else "",
        )
        return {**data, "kind": "journal", "tag": tag, "source": source}
    data = write_episode(
        entity,
        body,
        title=hint,
        summary=hint[:30],
        update_path=upd if upd.startswith("memory/episodic/") else "",
    )
    return {**data, "kind": "episodic", "tag": tag, "source": source}


def format_live_pending_inbox_for_agent(
    *,
    agent_name: str | None = None,
    principal_id: str = "",
    limit: int = 6,
    max_chars: int = 0,
) -> str:
    """Resolve the dialogue memory entity and return pending-inbox preview text.

    Used every model turn (outside standing freeze) so ``assets note`` takes effect
    on the next turn without waiting for Phase2 or a new session.
    """
    try:
        from evoflow.assets.guidance import resolve_memory_entity

        entity = resolve_memory_entity(
            agent_name=agent_name,
            principal_id=principal_id,
        )
    except Exception:
        return ""
    return format_pending_inbox_notes_for_prompt(
        entity,
        limit=limit,
        max_chars=max_chars,
    )


def _inbox_note_title_label(filename: str, body: str) -> str:
    """Short label from leading tag line / first sentence — never the full body."""
    for ln in str(body or "").splitlines():
        s = ln.strip()
        if not s:
            continue
        # Prefer ``[process] …`` / ``[experience] …`` first line as the human title.
        if len(s) > 120:
            s = s[:119].rstrip() + "…"
        return s
    stem = str(filename or "").removesuffix(".md").removesuffix(".markdown")
    return stem.replace("-", " ")


def format_pending_inbox_notes_for_prompt(
    entity: EntityRef,
    *,
    limit: int = 6,
    max_chars: int = 0,
) -> str:
    """Inject pending ``_inbox/notes`` as **filename + short title only**.

    Bodies stay on disk; the model must ``assets read`` a filename for detail.
    (Same contract as Asset Hub turn-tail recall — titles remind, files hold truth.)

    Must be applied **live each turn** (not frozen with standing): otherwise a note
    written mid-chat stays invisible until freeze invalidation / new session.

    ``max_chars`` caps the whole block when > 0; default is generous for title rows.
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
    budget = int(max_chars or 0) or 1200
    for path in files:
        try:
            raw = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        meta, body = parse_frontmatter(raw)
        created = str(meta.get("created") or "").strip() or "?"
        title = _inbox_note_title_label(path.name, str(body or ""))
        if not title:
            continue
        # Filename is the durable handle; title is a one-line hint (not the note body).
        line = f"- `{path.name}` · [{created}] {title}"
        if used + len(line) > budget and lines:
            lines.append("- …(pending inbox truncated)")
            break
        lines.append(line)
        used += len(line) + 1
    if not lines:
        return ""
    try:
        # Titles are still model-visible; scan per row (one poison line ≠ whole block).
        from evoflow.agents.content_scanner import scan_memory_entries

        lines = scan_memory_entries(lines, source="pending_inbox_notes")
    except Exception:
        pass
    return (
        "<pending_inbox>\n"
        "<!-- filenames only until Phase2; details → assets read -->\n"
        + "\n".join(lines)
        + "\n</pending_inbox>"
    )
