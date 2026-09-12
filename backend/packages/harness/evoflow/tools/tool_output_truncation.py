"""runtime-aligned inline tool output truncation (middle omit + warning header)."""

from __future__ import annotations

from evoflow.context.compaction_token_utils import _CHARS_PER_TOKEN
from evoflow.context.tool_tokens import count_tool_tokens

_OMITTED_MARKER_TEMPLATE = "... {omitted} tokens truncated ..."


def truncate_text_to_token_budget(text: str, max_tokens: int) -> str:
    """Middle truncation to fit *max_tokens* (head + marker + tail)."""
    raw = str(text or "")
    if not raw or max_tokens <= 0:
        return ""
    if count_tool_tokens(raw) <= max_tokens:
        return raw

    if len(raw) <= _CHARS_PER_TOKEN * max_tokens // 2:
        half = max(128, len(raw) // 2)
        return raw[:half] + "\n\n[Truncated for tool output budget.]"

    omitted = max(0, count_tool_tokens(raw) - max_tokens)
    marker = _OMITTED_MARKER_TEMPLATE.format(omitted=omitted)
    marker_tokens = max(1, count_tool_tokens(marker))
    body_budget = max(64, max_tokens - marker_tokens)

    # Binary search a char window whose token count fits body_budget.
    lo, hi = 0, len(raw)
    head_len = 0
    while lo <= hi:
        mid = (lo + hi) // 2
        head = raw[:mid]
        tail = raw[len(raw) - mid :] if mid < len(raw) else ""
        candidate = f"{head}\n\n{marker}\n\n{tail}" if tail else f"{head}\n\n{marker}"
        if count_tool_tokens(candidate) <= max_tokens:
            head_len = mid
            lo = mid + 1
        else:
            hi = mid - 1

    if head_len <= 0:
        return raw[: max(128, _CHARS_PER_TOKEN * max_tokens // 4)] + "\n\n[Truncated for tool output budget.]"

    head = raw[:head_len]
    tail = raw[-head_len:] if head_len < len(raw) else ""
    if tail and tail != head:
        return f"{head}\n\n{marker}\n\n{tail}"
    return f"{head}\n\n{marker}"


def formatted_truncate_tool_output(text: str, max_tokens: int) -> str:
    """Truncate with native-style metadata header for model-visible tool results."""
    raw = str(text or "")
    if not raw:
        return raw
    original_token_count = count_tool_tokens(raw)
    if original_token_count <= max_tokens:
        return raw
    total_lines = len(raw.splitlines()) or 1
    body = truncate_text_to_token_budget(raw, max_tokens)
    return (
        f"Warning: truncated output (original token count: {original_token_count})\n"
        f"Total output lines: {total_lines}\n\n"
        f"{body}"
    )
