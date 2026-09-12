"""Pre-call guardrail — sanitizes messages before each LLM API call.

Runs automatically to prevent common issues:
- Orphaned tool_call/tool_result pairs
- Messages with invalid roles
- Duplicate tool calls (same tool + args in one turn)
- Tool calls exceeding concurrent limits
"""

import json
import logging
from typing import Any

logger = logging.getLogger(__name__)

_VALID_API_ROLES = frozenset({"system", "user", "assistant", "tool", "function"})


def _get_tool_call_id(tc: Any) -> str:
    """Extract call ID from a tool_call entry (dict or object)."""
    if isinstance(tc, dict):
        return tc.get("id", "") or ""
    return getattr(tc, "id", "") or ""


class PreCallGuardrail:
    """Sanitizes messages before LLM invocation.

    Usage:
        guardrail = PreCallGuardrail()
        clean_messages = guardrail.sanitize(messages)
    """

    def __init__(self, max_concurrent_calls: int = 5):
        self.max_concurrent_calls = max_concurrent_calls

    def sanitize(self, messages: list[dict]) -> list[dict]:
        """Apply all sanitization passes and return clean messages."""
        messages = self._drop_invalid_roles(messages)
        messages = self._fix_orphaned_pairs(messages)
        messages = self._deduplicate_tool_calls(messages)
        messages = self._cap_concurrent_delegates(messages)
        return messages

    # ── Pass 1: Drop invalid roles ────────────────────────────────────
    def _drop_invalid_roles(self, messages: list[dict]) -> list[dict]:
        filtered = []
        for msg in messages:
            role = msg.get("role", "")
            if role not in _VALID_API_ROLES:
                logger.debug("Guardrail: dropping message with invalid role %r", role)
                continue
            filtered.append(msg)
        return filtered

    # ── Pass 2: Fix orphaned tool_call / tool_result pairs ────────────
    def _fix_orphaned_pairs(self, messages: list[dict]) -> list[dict]:
        surviving_call_ids: set[str] = set()
        for msg in messages:
            if msg.get("role") == "assistant":
                for tc in msg.get("tool_calls") or []:
                    cid = _get_tool_call_id(tc)
                    if cid:
                        surviving_call_ids.add(cid)

        result_call_ids: set[str] = set()
        for msg in messages:
            if msg.get("role") == "tool":
                cid = msg.get("tool_call_id", "") or ""
                if cid:
                    result_call_ids.add(cid)

        orphaned_results = result_call_ids - surviving_call_ids
        if orphaned_results:
            messages = [m for m in messages if not (m.get("role") == "tool" and m.get("tool_call_id", "") in orphaned_results)]
            logger.debug("Guardrail: removed %d orphaned tool result(s)", len(orphaned_results))

        missing_results = surviving_call_ids - result_call_ids
        if missing_results:
            patched: list[dict] = []
            for msg in messages:
                patched.append(msg)
                if msg.get("role") == "assistant":
                    for tc in msg.get("tool_calls") or []:
                        cid = _get_tool_call_id(tc)
                        if cid in missing_results:
                            patched.append(
                                {
                                    "role": "tool",
                                    "content": "[Result unavailable — see context summary above]",
                                    "tool_call_id": cid,
                                }
                            )
            messages = patched
            logger.debug("Guardrail: added %d stub tool result(s)", len(missing_results))

        return messages

    # ── Pass 3: Deduplicate same-named+same-arg tool calls in one turn ─
    def _deduplicate_tool_calls(self, messages: list[dict]) -> list[dict]:
        for msg in messages:
            if msg.get("role") != "assistant":
                continue
            tool_calls = msg.get("tool_calls")
            if not tool_calls:
                continue
            seen: set[str] = set()
            unique: list[dict] = []
            for tc in tool_calls:
                func = tc.get("function", {}) if isinstance(tc, dict) else {}
                name = func.get("name", "")
                args_raw = func.get("arguments", "")
                # Normalize JSON args for comparison
                try:
                    args_normalized = json.dumps(json.loads(args_raw), sort_keys=True) if args_raw else ""
                except (json.JSONDecodeError, TypeError):
                    args_normalized = args_raw
                key = f"{name}|{args_normalized}"
                if key in seen:
                    logger.debug("Guardrail: removing duplicate tool call '%s'", name)
                    continue
                seen.add(key)
                unique.append(tc)
            if len(unique) < len(tool_calls):
                msg["tool_calls"] = unique
        return messages

    # ── Pass 4: Cap concurrent delegate_task calls ────────────────────
    def _cap_concurrent_delegates(self, messages: list[dict]) -> list[dict]:
        for msg in messages:
            if msg.get("role") != "assistant":
                continue
            tool_calls = msg.get("tool_calls")
            if not tool_calls:
                continue
            # Count delegate_task calls
            delegate_indices = [i for i, tc in enumerate(tool_calls) if _get_tool_name(tc) == "delegate_task" or _get_tool_name(tc) == "task"]
            if len(delegate_indices) > self.max_concurrent_calls:
                keep = set(delegate_indices[: self.max_concurrent_calls])
                tool_calls[:] = [tc for i, tc in enumerate(tool_calls) if i in keep or i not in delegate_indices]
                logger.debug(
                    "Guardrail: capped delegate_task calls from %d to %d",
                    len(delegate_indices),
                    self.max_concurrent_calls,
                )
        return messages


def _get_tool_name(tc: Any) -> str:
    """Extract tool name from a tool_call."""
    if isinstance(tc, dict):
        func = tc.get("function", {})
        if isinstance(func, dict):
            return func.get("name", "")
        return ""
    return getattr(tc, "name", "") or ""
