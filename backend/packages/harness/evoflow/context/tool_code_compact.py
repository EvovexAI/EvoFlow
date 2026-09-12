"""Lightweight code/text compaction before tool results enter context."""

from __future__ import annotations

import re

_BLOCK_START = re.compile(r"/\*")
_BLOCK_END = re.compile(r"\*/")


def compact_code_light(text: str) -> str:
    """Drop blank lines and line comments; preserve structure (no semantic deletion)."""
    if not text:
        return text
    out: list[str] = []
    in_block = False
    for line in text.splitlines():
        raw = line
        stripped = raw.strip()
        if in_block:
            if _BLOCK_END.search(stripped):
                in_block = False
            continue
        if stripped.startswith("/*"):
            in_block = _BLOCK_END.search(stripped) is None
            continue
        if stripped.startswith("//"):
            continue
        if stripped.startswith("#") and not stripped.startswith("#!"):
            continue
        if not stripped:
            continue
        out.append(raw.rstrip())
    return "\n".join(out)
