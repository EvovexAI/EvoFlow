"""Shared SKILL.md frontmatter parsing."""

from __future__ import annotations

import re


def split_skill_frontmatter(content: str) -> tuple[str, str] | None:
    """Split SKILL.md into ``(frontmatter_text, body)``.

    Uses the first ``---`` line as opening delimiter and the next line that is
    exactly ``---`` (optional trailing whitespace) as closing delimiter.

    A leading UTF-8 BOM (``\\ufeff``) is stripped so Windows-edited files still parse.
    """
    text = content or ""
    if text.startswith("\ufeff"):
        text = text.lstrip("\ufeff")
    if not text.startswith("---"):
        return None

    pos = 3
    if text.startswith("---\r\n", 0):
        pos = 5
    elif text.startswith("---\n", 0):
        pos = 4
    else:
        return None

    line_start = pos
    while line_start < len(text):
        line_end = text.find("\n", line_start)
        if line_end == -1:
            line = text[line_start:]
            next_start = len(text)
        else:
            line = text[line_start:line_end]
            next_start = line_end + 1

        if re.match(r"^---\s*$", line.rstrip("\r")):
            frontmatter_text = text[pos:line_start].rstrip("\r\n")
            body = text[next_start:]
            return frontmatter_text, body

        if line_end == -1:
            break
        line_start = next_start

    return None
