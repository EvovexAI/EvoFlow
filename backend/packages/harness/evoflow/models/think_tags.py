"""Strip provider-leaked ``<think>…</think>`` blocks out of assistant body text.

Some models (DeepSeek / Minimax / OpenAI-compat) put chain-of-thought inside the
content string instead of ``reasoning_content``. Leaving those tags in the body
makes the chat look like it “串了” — prior-turn planning leaks into the visible
reply. Shared helper so every adapter / SSE path strips the same way.
"""

from __future__ import annotations

import re

_THINK_TAG_RE = re.compile(r"<think>\s*(.*?)\s*</think>", re.DOTALL | re.IGNORECASE)
_OPEN_THINK_RE = re.compile(r"<think\b[^>]*>", re.IGNORECASE)


def merge_reasoning(*values: str | None) -> str | None:
    merged: list[str] = []
    for value in values:
        if not value:
            continue
        normalized = value.strip()
        if normalized and normalized not in merged:
            merged.append(normalized)
    return "\n\n".join(merged) if merged else None


def strip_inline_think_tags(content: str) -> tuple[str, str | None]:
    """Return ``(cleaned_body, extracted_reasoning)``.

    Complete ``<think>…</think>`` blocks move to reasoning. An unclosed
    ``<think>`` (streaming) is also pulled out of the visible body so half-open
    tags never flash in the chat transcript.

    Critical for SSE: live chunks are appended as-is. Do **not** ``.strip()`` the
    body — a delta that is only ``\\n\\n`` or ``\\n## heading`` must keep those
    newlines, or ATX headings/lists/tables glue into the previous paragraph and
    render as raw ``##`` in the chat.
    """
    if not content:
        return content, None
    # Fast path: most token deltas have no think tags. Preserve exact bytes
    # (including whitespace-only chunks).
    lower = content.lower()
    if "<think" not in lower and "</think>" not in lower:
        return content, None

    reasoning_parts: list[str] = []

    def _replace(match: re.Match[str]) -> str:
        reasoning = match.group(1).strip()
        if reasoning:
            reasoning_parts.append(reasoning)
        return ""

    cleaned = _THINK_TAG_RE.sub(_replace, content)
    open_match = _OPEN_THINK_RE.search(cleaned)
    if open_match is not None:
        incomplete = cleaned[open_match.end() :].strip()
        if incomplete:
            reasoning_parts.append(incomplete)
        cleaned = cleaned[: open_match.start()]

    reasoning = "\n\n".join(reasoning_parts) if reasoning_parts else None
    return cleaned, reasoning
