"""Shared text/image read logic for read_file."""

from __future__ import annotations

import base64
import logging
import mimetypes
import os
from pathlib import Path

logger = logging.getLogger(__name__)

_IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".gif", ".webp"}
# Minified JSON/logs: one physical line can exceed model tier; paginate by chars when line-based slice fails.
_SINGLE_LINE_PAGE_CHARS = 8000

# zcode Read alignment: whole-file reads are gated to the first N lines with a
# pagination banner (zcode default limit=2000). A big file read once must not
# ride on every later request. EVOFLOW_READ_LINE_LIMIT=0 disables the gate.
_DEFAULT_READ_LINE_LIMIT = 2000
# Second-level cap inside shown lines: a few giant lines can still overflow the
# window even when the line count fits (~25K tokens of mixed text).
_READ_CHAR_FALLBACK = 100_000


def _read_line_gate_limit() -> int:
    raw = os.environ.get("EVOFLOW_READ_LINE_LIMIT", "").strip()
    if raw:
        try:
            value = int(raw)
            if value >= 0:
                return value
        except ValueError:
            pass
    return _DEFAULT_READ_LINE_LIMIT


def apply_whole_file_read_gate(content: str, *, path: str = "") -> str:
    """Cap a whole-file read to the first N lines (zcode Read default limit).

    Returns *content* unchanged when the file fits; otherwise a line-numbered
    partial view with a banner giving the exact next-page call, so the model
    paginates deliberately instead of resending the whole file every turn.
    Partial views never qualify for edit (read_file_state full_read stays False;
    the edit guard auto-heals by registering a backend full read, same as replace).
    """
    limit = _read_line_gate_limit()
    if limit <= 0 or not content:
        return content
    lines = content.splitlines()
    total = len(lines)
    if total <= limit and len(content) <= _READ_CHAR_FALLBACK:
        return content
    shown = lines[:limit]
    acc = 0
    cut = len(shown)
    for i, line in enumerate(shown):
        acc += len(line) + 1
        if acc > _READ_CHAR_FALLBACK:
            cut = max(1, i)
            break
    shown = shown[:cut]
    shown_n = len(shown)
    body = "\n".join(f"{i + 1}: {line}" for i, line in enumerate(shown))
    banner = (
        f"\n\n[Showing lines 1-{shown_n} of {total} total ({len(content):,} chars). "
        f"Call read with offset={shown_n + 1} for the next page, or rg to find specific content. "
        "Do NOT re-read the whole file; partial views do not qualify for edit — "
        "page through to the needed range first.]"
    )
    # Observability: gate hits are rare (big files only) and directly quantify
    # how much per-request context the gate is shaving off.
    logger.info(
        "read whole-file gate: path=%s total_lines=%d shown=%d chars=%d (limit=%d)",
        os.path.basename(path) or "?",
        total,
        shown_n,
        len(content),
        limit,
    )
    return f"{body}{banner}"


def _is_binary_content(raw: bytes) -> bool:
    """zcode ``looksLikeBinary`` alignment: NUL byte anywhere => binary.

    zcode rejects such files with "Unsupported or binary text encoding"
    instead of force-decoding to U+FFFD noise; we return a structured error
    the same way (image/pdf/office branches are dispatched before this).
    """
    return b"\x00" in raw


def read_file_content(
    path: str,
    *,
    offset: int | None = None,
    limit: int | None = None,
    use_cache: bool = True,
    pages: str | None = None,
) -> str:
    """Read file content; returns error string on failure."""
    try:
        if isinstance(path, str) and path.startswith("skill:"):
            from evoflow.skills.skill_uri import resolve_skill_uri

            resolved = resolve_skill_uri(path, require_enabled=True)
            if resolved is None:
                return f"Error: Unknown, disabled, or invalid skill path: {path}"
            path = str(resolved)
        p = Path(path)

        if not p.exists():
            return f"Error: File not found: {path}"

        if not p.is_file():
            return f"Error: Path is a directory, not a file: {path}. Use terminal (e.g. dir / ls) to browse, or read_file with a concrete file path (e.g. outputs/result.txt)."

        if p.suffix.lower() in _IMAGE_EXTENSIONS:
            mime_type = mimetypes.guess_type(str(p))[0] or "image/png"
            with open(p, "rb") as f:
                b64 = base64.b64encode(f.read()).decode("ascii")
            return f"data:{mime_type};base64,{b64}"

        # zcode Read PDF alignment: never force-decode PDF binaries as text
        # (previously produced U+FFFD noise); extract per-page text instead.
        if p.suffix.lower() == ".pdf":
            from evoflow.tools.host_direct.read_pdf import read_pdf_file

            return read_pdf_file(p, pages=pages)

        # Office documents: convert to markdown via markitdown (+ fallback
        # extractors). offset/limit paginate the converted markdown.
        from evoflow.tools.host_direct.read_office import OFFICE_EXTENSIONS, read_office_file

        if p.suffix.lower() in OFFICE_EXTENSIONS:
            return read_office_file(p, offset=offset, limit=limit)

        if use_cache and offset is None and limit is None:
            from evoflow.context.file_read_cache import get_cached_text, store_cached_text

            cached = get_cached_text(p)
            if cached is not None:
                return cached

        raw = p.read_bytes()
        if _is_binary_content(raw):
            return (
                f"Error: Unsupported or binary file: {path}. "
                "The file contains binary data and cannot be shown as text. "
                "Use an appropriate tool (Python in the sandbox) to inspect or convert it."
            )
        content = raw.decode("utf-8", errors="replace")
        lines = content.splitlines()

        if offset is not None or limit is not None:
            start = max(0, (offset or 1) - 1)
            if len(lines) == 1 and len(lines[0]) > _SINGLE_LINE_PAGE_CHARS:
                line = lines[0]
                page_idx = start
                page_size = _SINGLE_LINE_PAGE_CHARS
                start_c = page_idx * page_size
                end_c = min(len(line), start_c + page_size)
                total_pages = max(1, (len(line) + page_size - 1) // page_size)
                snippet = line[start_c:end_c]
                next_off = page_idx + 2 if end_c < len(line) else page_idx + 1
                return (
                    f"[single-line file: page {page_idx + 1}/{total_pages}, "
                    f"chars {start_c + 1:,}-{end_c:,} of {len(line):,}]\n"
                    f"{snippet}\n"
                    f"… (minified/one-line file: offset is page number, ~{page_size:,} chars/page; "
                    f"next: offset={next_off}, limit=1)"
                )
            end = start + limit if limit is not None else len(lines)
            lines = lines[start:end]
            return "\n".join(f"{start + i + 1}:{line}" for i, line in enumerate(lines))

        if use_cache and offset is None and limit is None:
            from evoflow.context.file_read_cache import store_cached_text

            store_cached_text(p, content)
        return content

    except PermissionError:
        return f"Error: Permission denied reading file: {path}"
    except Exception as e:
        return f"Error: Failed to read file '{path}': {e}"
