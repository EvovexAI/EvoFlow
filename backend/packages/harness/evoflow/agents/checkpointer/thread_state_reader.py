"""Read thread checkpoint state without compiling the lead agent graph.

LangGraph ``GET /threads/{id}/state`` normally invokes the graph factory (``make_lead_agent``),
which loads tools, middleware, and config — seconds per request. EvoFlow Gateway can serve the
same ``values`` payload from the SQLite checkpointer in milliseconds.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any

logger = logging.getLogger(__name__)


def _message_to_jsonable(msg: Any) -> Any:
    """Flatten LangChain messages for EvoPanel / LangGraph HTTP state JSON."""
    if msg is None:
        return None
    if isinstance(msg, (str, int, float, bool)):
        return msg
    try:
        from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, SystemMessage, ToolMessage
    except ImportError:
        BaseMessage = ()  # type: ignore[misc, assignment]

    if isinstance(msg, BaseMessage):
        if isinstance(msg, HumanMessage):
            return {"type": "human", "content": msg.content, "id": getattr(msg, "id", None)}
        if isinstance(msg, AIMessage):
            out: dict[str, Any] = {
                "type": "ai",
                "content": msg.content,
                "id": getattr(msg, "id", None),
            }
            if msg.tool_calls:
                out["tool_calls"] = [
                    {
                        "name": tc.get("name"),
                        "args": tc.get("args"),
                        "id": tc.get("id"),
                    }
                    for tc in msg.tool_calls
                    if isinstance(tc, dict)
                ]
            um = getattr(msg, "usage_metadata", None)
            if um:
                out["usage_metadata"] = um
            return out
        if isinstance(msg, ToolMessage):
            return {
                "type": "tool",
                "content": msg.content,
                "name": getattr(msg, "name", None),
                "tool_call_id": getattr(msg, "tool_call_id", None),
                "id": getattr(msg, "id", None),
            }
        if isinstance(msg, SystemMessage):
            return {"type": "system", "content": msg.content, "id": getattr(msg, "id", None)}
        from langchain_core.messages import message_to_dict

        return _message_to_jsonable(message_to_dict(msg))

    if isinstance(msg, dict):
        # LangChain ``message_to_dict`` wire format: {type, data: {content, ...}}
        inner = msg.get("data")
        if isinstance(inner, dict) and msg.get("type") in ("human", "ai", "tool", "system"):
            flat = {"type": str(msg["type"]), **inner}
            flat.pop("type", None)
            return _message_to_jsonable(flat)
        return {k: _json_safe_value(v) for k, v in msg.items()}

    return str(msg)


def _json_safe_value(obj: Any) -> Any:
    if obj is None or isinstance(obj, (str, int, float, bool)):
        return obj
    if isinstance(obj, (list, tuple)):
        return [_json_safe_value(x) for x in obj]
    if isinstance(obj, dict):
        return {str(k): _json_safe_value(v) for k, v in obj.items()}
    try:
        from langchain_core.messages import BaseMessage

        if isinstance(obj, BaseMessage):
            return _message_to_jsonable(obj)
    except ImportError:
        pass
    if hasattr(obj, "model_dump"):
        try:
            return _json_safe_value(obj.model_dump(mode="json"))
        except Exception:
            pass
    return str(obj)


def json_safe_channel_values(channel_values: dict[str, Any] | None) -> dict[str, Any]:
    """Make checkpoint ``channel_values`` JSON-serializable for FastAPI responses."""
    if not isinstance(channel_values, dict):
        return {}
    out: dict[str, Any] = {}
    for key, val in channel_values.items():
        if key in ("messages", "ui_messages") and isinstance(val, list):
            out[key] = [_message_to_jsonable(m) for m in val]
        else:
            out[key] = _json_safe_value(val)
    return out


_THREAD_STATE_PATH_RE = re.compile(r"^threads/([^/]+)/state/?$", re.IGNORECASE)


def parse_thread_id_from_state_path(path: str) -> str | None:
    m = _THREAD_STATE_PATH_RE.match(str(path or "").strip().strip("/"))
    if not m:
        return None
    tid = m.group(1).strip()
    return tid or None


def get_thread_state_snapshot(thread_id: str) -> dict[str, Any] | None:
    """Return LangGraph-compatible state body from checkpointer (``values`` only)."""
    tid = str(thread_id or "").strip()
    if not tid:
        return None
    from evoflow.agents.checkpointer.provider import get_checkpointer, reset_checkpointer

    config = {"configurable": {"thread_id": tid}}
    tup = None
    for attempt in range(2):
        cp = get_checkpointer()
        try:
            tup = cp.get_tuple(config)
            break
        except Exception as exc:
            err = str(exc).lower()
            if attempt == 0 and "closed database" in err:
                logger.warning(
                    "thread_state_reader: checkpointer connection closed for %s; retrying",
                    tid,
                )
                reset_checkpointer()
                continue
            logger.warning("thread_state_reader: get_tuple failed for %s", tid, exc_info=True)
            return None
    if tup is None:
        return {
            "values": {},
            "next": [],
            "tasks": [],
            "metadata": {},
            "source": "checkpointer",
        }

    checkpoint = tup.checkpoint if isinstance(tup.checkpoint, dict) else {}
    channel_values = checkpoint.get("channel_values")
    values = json_safe_channel_values(channel_values if isinstance(channel_values, dict) else None)

    metadata = _json_safe_value(tup.metadata if isinstance(tup.metadata, dict) else {})
    body = {
        "values": values,
        "next": [],
        "tasks": [],
        "metadata": metadata if isinstance(metadata, dict) else {},
        "source": "checkpointer",
    }
    # Fail fast before FastAPI json.dumps — surface serialization bugs in logs.
    json.dumps(body)
    return body
