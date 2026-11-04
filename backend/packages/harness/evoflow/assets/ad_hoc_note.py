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
    text = ensure_body_recorded_at(text).strip()
    ensure_entity_tree(entity)
    filename = build_ad_hoc_filename(slug_hint=slug_hint or text.splitlines()[0][:40])
    err = validate_ad_hoc_filename(filename)
    if err:
        raise ValueError(err)
    ts = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    rel = _unique_note_rel(entity, filename)
    body = f"---\nsource: {source}\ncreated: {ts}\n---\n\n{text}\n"
    return write_text_file(entity, rel, body)


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


def format_pending_inbox_notes_for_prompt(
    entity: EntityRef,
    *,
    limit: int = 6,
    max_chars: int = 0,
) -> str:
    """Inject pending ``_inbox/notes`` until Phase2 consolidates them into standing/craft.

    Must be applied **live each turn** (not frozen with standing): otherwise a note
    written mid-chat stays invisible until freeze invalidation / new session.

    Default ``max_chars=0`` keeps each note body intact (ops/debug + model see the
    full draft). Pass a positive ``max_chars`` only when a caller needs a hard budget.

    每条 note 单独过 prompt-injection 扫描器：note 正文是不可信内容（对话里
    可以种），一条中毒只屏蔽那一条，不拖累整块。
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
    budget = int(max_chars or 0)
    for path in files:
        try:
            raw = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        meta, body = parse_frontmatter(raw)
        created = str(meta.get("created") or "").strip() or "?"
        body = str(body or "").strip()
        # Keep full note body (whitespace-collapsed to one line for the catalog row).
        preview_lines = [ln.strip() for ln in body.splitlines() if ln.strip()]
        preview = " ".join(preview_lines)
        if not preview:
            continue
        line = f"- [{created}|{path.name}] {preview}"
        if budget > 0 and used + len(line) > budget:
            lines.append("- …(pending inbox truncated)")
            break
        lines.append(line)
        used += len(line) + 1
    if not lines:
        return ""
    try:
        # note 正文不可信：逐条扫描（整块扫描会被单条中毒笔记整块屏蔽）。
        from evoflow.agents.content_scanner import scan_memory_entries

        lines = scan_memory_entries(lines, source="pending_inbox_notes")
    except Exception:
        pass
    # Paired XML like other prompt regions — not a bare HTML comment tail.
    return (
        "<pending_inbox>\n"
        "<!-- injected until Phase2 consolidates -->\n"
        + "\n".join(lines)
        + "\n</pending_inbox>"
    )
