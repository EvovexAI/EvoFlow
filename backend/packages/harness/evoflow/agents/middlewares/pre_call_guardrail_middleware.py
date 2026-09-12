"""Pre-call guardrail middleware — sanitizes messages before LLM API calls.

Runs before every LLM invocation to fix common issues that would otherwise
cause API errors or waste context:
1. Remove orphaned tool results (no matching assistant tool_call)
2. Inject stub results for missing tool_call results
3. Deduplicate identical tool calls in the same turn
4. Cap excessive tool calls (delegate_task concurrency)
"""

import logging
from collections import Counter

logger = logging.getLogger(__name__)


def sanitize_messages(messages: list[dict]) -> list[dict]:
    """Clean up message list before sending to LLM API.

    Mutates and returns the message list. Handles:
      - Orphaned tool results
      - Missing tool result stubs
      - Duplicate tool calls
    """
    if not messages:
        return messages

    # ── 1. Collect surviving tool_call IDs ────────────────────────────
    surviving_call_ids: set[str] = set()
    for msg in messages:
        if msg.get("role") == "assistant":
            for tc in msg.get("tool_calls") or []:
                cid = _get_call_id(tc)
                if cid:
                    surviving_call_ids.add(cid)

    # ── 2. Collect tool result IDs ────────────────────────────────────
    result_call_ids: set[str] = set()
    for msg in messages:
        if msg.get("role") == "tool":
            cid = msg.get("tool_call_id") or ""
            if cid:
                result_call_ids.add(cid)

    # ── 3. Drop orphaned tool results (no matching assistant call) ────
    orphaned = result_call_ids - surviving_call_ids
    if orphaned:
        messages = [m for m in messages if not (m.get("role") == "tool" and m.get("tool_call_id") in orphaned)]
        logger.info("Pre-call guardrail: removed %d orphaned tool result(s)", len(orphaned))

    # ── 4. Inject stub results for missing tool_call results ──────────
    missing = surviving_call_ids - result_call_ids
    if missing:
        patched: list[dict] = []
        for msg in messages:
            patched.append(msg)
            if msg.get("role") == "assistant":
                for tc in msg.get("tool_calls") or []:
                    cid = _get_call_id(tc)
                    if cid in missing:
                        patched.append(
                            {
                                "role": "tool",
                                "content": "[Result unavailable — removed during context management]",
                                "tool_call_id": cid,
                            }
                        )
        messages = patched
        logger.info("Pre-call guardrail: added %d stub tool result(s)", len(missing))

    # ── 5. Deduplicate identical tool calls in same turn ─────────────
    deduped: list[dict] = []
    for msg in messages:
        if msg.get("role") == "assistant":
            tcs = msg.get("tool_calls") or []
            if len(tcs) > 1:
                seen = set()
                unique_tcs = []
                for tc in tcs:
                    sig = _tool_call_signature(tc)
                    if sig not in seen:
                        seen.add(sig)
                        unique_tcs.append(tc)
                if len(unique_tcs) < len(tcs):
                    msg = {**msg, "tool_calls": unique_tcs}
                    logger.info("Pre-call guardrail: removed %d duplicate tool call(s)", len(tcs) - len(unique_tcs))
        deduped.append(msg)
    messages = deduped

    return messages


def _get_call_id(tc) -> str:
    """Extract call_id from a tool_call entry (dict or object)."""
    if isinstance(tc, dict):
        return tc.get("id", "") or ""
    return getattr(tc, "id", "") or ""


def _tool_call_signature(tc) -> str:
    """Create a unique signature for a tool call (name + JSON args)."""
    if isinstance(tc, dict):
        fn = tc.get("function", {}) or {}
        name = fn.get("name", "") if isinstance(fn, dict) else getattr(fn, "name", "")
        args = fn.get("arguments", "") if isinstance(fn, dict) else getattr(fn, "arguments", "")
        return f"{name}:{args}"
    return str(tc)


class PreCallGuardrailMiddleware:
    """Middleware that sanitizes messages before every LLM call.

    Usage:
        guardrail = PreCallGuardrailMiddleware()
        messages = guardrail.clean(messages)
        response = llm.invoke(messages)
    """

    def __init__(self):
        self._stats: dict[str, int] = Counter()

    def clean(self, messages: list[dict]) -> list[dict]:
        """Sanitize *messages* and return cleaned copy."""
        cleaned = sanitize_messages(messages)
        return cleaned

    def stats(self) -> dict[str, int]:
        return dict(self._stats)
