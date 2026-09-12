"""Shared text/image read logic for read_file."""

from __future__ import annotations

import base64
import mimetypes
from pathlib import Path

_IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".gif", ".webp"}
# Minified JSON/logs: one physical line can exceed model tier; paginate by chars when line-based slice fails.
_SINGLE_LINE_PAGE_CHARS = 8000


def read_file_content(
    path: str,
    *,
    offset: int | None = None,
    limit: int | None = None,
    use_cache: bool = True,
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
            return (
                f"Error: Path is a directory, not a file: {path}. "
                "Use terminal (e.g. dir / ls) to browse, or read_file with a concrete file path (e.g. outputs/result.txt)."
            )

        if p.suffix.lower() in _IMAGE_EXTENSIONS:
            mime_type = mimetypes.guess_type(str(p))[0] or "image/png"
            with open(p, "rb") as f:
                b64 = base64.b64encode(f.read()).decode("ascii")
            return f"data:{mime_type};base64,{b64}"

        if use_cache and offset is None and limit is None:
            from evoflow.context.file_read_cache import get_cached_text, store_cached_text

            cached = get_cached_text(p)
            if cached is not None:
                return cached

        content = p.read_text(encoding="utf-8", errors="replace")
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
