"""Offload oversized write/replace tool-call string args to temp files before ToolNode runs.

Problem: When the model generates very large ``content``/``old_string``/``new_string``
arguments for write/replace tools, the full string travels through:
  model output → AIMessage.tool_calls → LangGraph state → ToolNode → tool function
…which can exceed vendor output-token limits, SSE frame size caps, or internal
JSON serialization limits, causing truncation / "long write failed" errors.

Solution: This middleware runs in ``after_model`` (before ToolNode). For write-family
tools, it scans ``content``/``old_string``/``new_string`` args. Any string larger than
:data:`_OFFLOAD_THRESHOLD_BYTES` is written to a temp file on disk, and the arg is
replaced with a sentinel reference: ``__EVOFLOW_LARGE_FILE_REF__::<abspath>``.
The tool functions (``write_file_hd``, ``str_replace_hd``) detect this sentinel and
read the actual content from disk, then delete the temp file after use.

This keeps large payloads out of the in-memory state chain and SSE stream while
remaining transparent to the model.
"""

from __future__ import annotations

import logging
import os
import tempfile
import uuid

try:
    from typing import override
except ImportError:
    from typing import override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langchain_core.messages import AIMessage
from langgraph.runtime import Runtime

logger = logging.getLogger(__name__)

# Sentinel prefix that marks a string arg as an offloaded temp-file reference.
# Keep this distinctive and unlikely to appear in real file content.
LARGE_FILE_REF_PREFIX = "__EVOFLOW_LARGE_FILE_REF__::"

# Strings larger than this threshold (in characters, ~bytes for UTF-8 ASCII)
# are offloaded to temp files. 32 KB is well below typical vendor output limits
# and SSE frame size caps, but large enough that normal small edits pass through.
_OFFLOAD_THRESHOLD_BYTES = 32 * 1024

# Tool names whose args we inspect for large strings.
_WRITE_FAMILY_TOOLS = frozenset({
    "write",
    "replace",
    "write_file",
    "str_replace",
    "write_to_file",
    "replace_in_file",
})

# Arg keys that may contain large string content for write-family tools.
_LARGE_STRING_KEYS = ("content", "old_string", "new_string")


def _offload_large_string(value: object) -> object:
    """If ``value`` is a string exceeding the threshold, write it to a temp file
    and return the sentinel reference path; otherwise return ``value`` unchanged."""
    if not isinstance(value, str):
        return value
    if len(value) < _OFFLOAD_THRESHOLD_BYTES:
        return value
    try:
        fd, tmp_path = tempfile.mkstemp(
            prefix=f"evoflow_offload_{uuid.uuid4().hex[:8]}_",
            suffix=".txt",
        )
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                f.write(value)
        except Exception:
            # If fdopen/write fails, fd may still be open; close it safely.
            try:
                os.close(fd)
            except OSError:
                pass
            raise
        ref = f"{LARGE_FILE_REF_PREFIX}{tmp_path}"
        logger.info(
            "large_content_offload: offloaded %d chars to temp file %s",
            len(value),
            tmp_path,
        )
        return ref
    except Exception as exc:
        logger.warning(
            "large_content_offload: failed to offload large string (%d chars): %s",
            len(value),
            exc,
        )
        return value


def _resolve_tool_call_args(tc: object) -> dict[str, object]:
    """Extract the args dict from a tool call (dict or LangChain object)."""
    if isinstance(tc, dict):
        raw = tc.get("args")
        if raw is None:
            raw = tc.get("arguments")
        if isinstance(raw, dict):
            return dict(raw)
        return {}
    raw = getattr(tc, "args", None)
    if isinstance(raw, dict):
        return dict(raw)
    return {}


def _tool_call_name(tc: object) -> str:
    if isinstance(tc, dict):
        return str(tc.get("name") or "").strip()
    return str(getattr(tc, "name", None) or "").strip()


def _rebuild_tool_call(tc: object, new_args: dict[str, object]) -> object:
    """Return a copy of tool call ``tc`` with args replaced by ``new_args``."""
    if isinstance(tc, dict):
        out = dict(tc)
        out["args"] = new_args
        out["arguments"] = new_args  # keep both keys in sync
        return out
    # LangChain tool call object (has .id, .name, .args)
    return {"id": getattr(tc, "id", None), "name": getattr(tc, "name", None), "args": new_args, "type": "tool_call"}


def _process_ai_message(last: AIMessage) -> tuple[AIMessage, int]:
    """Scan tool_calls on this AIMessage and offload oversized string args.

    Returns (possibly updated message, count of offloaded fields).
    """
    tool_calls = list(getattr(last, "tool_calls", None) or [])
    if not tool_calls:
        return last, 0

    offloaded_count = 0
    changed = False
    out_calls: list[object] = []

    for tc in tool_calls:
        name = _tool_call_name(tc)
        if name not in _WRITE_FAMILY_TOOLS:
            out_calls.append(tc)
            continue
        args = _resolve_tool_call_args(tc)
        if not args:
            out_calls.append(tc)
            continue
        new_args = dict(args)
        tc_changed = False
        for key in _LARGE_STRING_KEYS:
            if key in new_args and isinstance(new_args[key], str):
                original = new_args[key]
                replaced = _offload_large_string(original)
                if replaced is not original:
                    new_args[key] = replaced
                    tc_changed = True
                    offloaded_count += 1
        if tc_changed:
            out_calls.append(_rebuild_tool_call(tc, new_args))
            changed = True
        else:
            out_calls.append(tc)

    if not changed:
        return last, 0

    return last.model_copy(update={"tool_calls": out_calls}), offloaded_count


def _process_state(state: AgentState) -> dict | None:
    messages = list(state.get("messages") or [])
    if not messages:
        return None
    last = messages[-1]
    if not isinstance(last, AIMessage):
        return None
    updated, count = _process_ai_message(last)
    if count == 0:
        return None
    logger.info("large_content_offload: offloaded %d arg(s) in after_model", count)
    return {"messages": [*messages[:-1], updated]}


def resolve_offloaded_ref(value: object) -> str | None:
    """Public helper used by write/replace tool functions.

    If ``value`` is a string starting with the offload sentinel, read the temp
    file, return its content, and delete the temp file. Otherwise return ``None``
    (caller should treat ``value`` as the literal content).
    """
    if not isinstance(value, str):
        return None
    if not value.startswith(LARGE_FILE_REF_PREFIX):
        return None
    tmp_path = value[len(LARGE_FILE_REF_PREFIX):]
    try:
        with open(tmp_path, "r", encoding="utf-8") as f:
            content = f.read()
        logger.info("large_content_offload: resolved ref %s (%d chars)", tmp_path, len(content))
        return content
    except FileNotFoundError:
        logger.warning("large_content_offload: temp file already removed: %s", tmp_path)
        return None
    except Exception as exc:
        logger.warning("large_content_offload: failed to read temp file %s: %s", tmp_path, exc)
        return None
    finally:
        # Best-effort cleanup: delete the temp file after reading.
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


class LargeContentOffloadMiddleware(AgentMiddleware[AgentState]):
    """Offload oversized write/replace string args to temp files before ToolNode.

    Runs in ``after_model`` so the large payload never enters the LangGraph state
    dict, the ToolNode call path, or the SSE event stream.
    """

    @override
    def after_model(self, state: AgentState, runtime: Runtime) -> dict | None:
        return _process_state(state)

    @override
    async def aafter_model(self, state: AgentState, runtime: Runtime) -> dict | None:
        return _process_state(state)
