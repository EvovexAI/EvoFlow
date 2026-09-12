"""Deprecated: UI transcript is stored in ``evoflow_chat_messages`` (Gateway), not checkpoint.

This middleware is no longer registered on the lead agent. Kept for reference/tests only.
"""

from __future__ import annotations

import json
import logging
from copy import deepcopy
from typing import Any

try:
    from typing import override
except ImportError:
    from typing import override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langgraph.runtime import Runtime

from evoflow.agents.middlewares.message_usage_helpers import infer_usage_metadata_for_ai_message
from evoflow.timeutil import utc_now_iso_z

logger = logging.getLogger(__name__)


def _write_diag_log(phase: str, data: dict) -> None:
    """Write diagnostic logs to temp directory for troubleshooting."""
    try:
        from evoflow.debug.trace_sink import debug_file_path

        log_path = debug_file_path("lead_agent_conversation_diag.log")
        log_path.parent.mkdir(parents=True, exist_ok=True)

        entry = {"timestamp": utc_now_iso_z(), "phase": phase, **data}

        with open(log_path, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False, default=str) + "\n")
    except Exception as e:
        logger.debug(f"Failed to write diag log: {e}")


class UiMessagesSnapshotMiddleware(AgentMiddleware[AgentState]):
    """Middleware that captures UI conversation flow.

    Extracts real user/AI/tool messages from state and stores them in ui_messages
    field for the frontend to display. Filters out system-injected prompts.
    """

    @override
    def process(self, state: AgentState, runtime: Runtime, **kwargs) -> dict[str, Any] | None:
        return self._extract_ui_messages(state, runtime)

    @override
    def before_model(self, state: AgentState, runtime: Runtime) -> dict[str, Any] | None:
        # Critical: snapshot UI transcript before SummarizationMiddleware mutates
        # `messages`, so `/threads/{id}/state` keeps full user/assistant history.
        return self._extract_ui_messages(state, runtime)

    @override
    async def abefore_model(self, state: AgentState, runtime: Runtime) -> dict[str, Any] | None:
        return self.before_model(state, runtime)

    @override
    def after_model(self, state: AgentState, runtime: Runtime) -> dict[str, Any] | None:
        # Also snapshot after the model returns so the latest AIMessage is
        # immediately visible via `/threads/{id}/state` without waiting for the next user turn.
        return self._extract_ui_messages(state, runtime)

    @override
    async def aafter_model(self, state: AgentState, runtime: Runtime) -> dict[str, Any] | None:
        return self.after_model(state, runtime)

    def _extract_ui_messages(self, state: AgentState, runtime: Runtime) -> dict[str, Any] | None:
        """Extract real conversation messages for UI display.

        Workflow:
        1. Get existing ui_messages from state
        2. Filter incoming messages to keep only real interactions
        3. Append new messages, skipping duplicates by ID
        """
        thread_id = None
        try:
            thread_id = runtime.context.get("thread_id") if runtime and runtime.context else None
        except Exception:
            pass

        existing = state.get("ui_messages") or []
        base = list(existing) if isinstance(existing, list) else []

        # Get incoming messages from state
        incoming = state.get("messages") or []

        # DIAG: Log entry state
        _write_diag_log(
            "middleware_entry",
            {
                "thread_id": thread_id,
                "existing_ui_count": len(base),
                "incoming_count": len(incoming),
                "incoming_types": [type(m).__name__ for m in incoming[-5:]],  # Last 5
            },
        )

        # Track existing IDs to avoid duplicates
        existing_ids = {m.get("id") for m in base if isinstance(m, dict) and m.get("id")}

        real_messages = self._filter_real_messages(incoming, thread_id=str(thread_id or ""))

        # DIAG: Log filter results
        _write_diag_log(
            "middleware_filter",
            {
                "thread_id": thread_id,
                "before_filter": len(incoming),
                "after_filter": len(real_messages),
                "filtered_types": [type(m).__name__ for m in real_messages],
            },
        )

        added = 0
        patched = 0
        for m in real_messages:
            msg_id = getattr(m, "id", None)

            # Skip if already exists (by ID) — but merge late-arriving AIMessage fields (usage_metadata, etc.)
            if msg_id and msg_id in existing_ids:
                if self._merge_duplicate_ai_message(base, msg_id, m):
                    patched += 1
                    _write_diag_log(
                        "middleware_duplicate_merge_usage",
                        {
                            "thread_id": thread_id,
                            "msg_id": msg_id,
                            "msg_type": type(m).__name__,
                        },
                    )
                else:
                    _write_diag_log(
                        "middleware_duplicate_skip",
                        {
                            "thread_id": thread_id,
                            "msg_id": msg_id,
                            "msg_type": type(m).__name__,
                        },
                    )
                continue

            # Convert to dict and add
            msg_dict = self._message_to_dict(m)
            base.append(msg_dict)
            if msg_id:
                existing_ids.add(msg_id)
            added += 1

        if added > 0 or patched > 0:
            logger.info("UI messages updated: added %s, patched %s, total %s (thread=%s)", added, patched, len(base), thread_id or "?")

            # DIAG: Log final state
            _write_diag_log(
                "middleware_updated",
                {
                    "thread_id": thread_id,
                    "added": added,
                    "total": len(base),
                    "last_msg_preview": str(base[-1].get("content", "")[:200]) if base else None,
                },
            )
            return {"ui_messages": base}
        else:
            # DIAG: Log no update
            _write_diag_log(
                "middleware_no_update",
                {
                    "thread_id": thread_id,
                    "reason": "no_new_messages",
                    "real_messages_count": len(real_messages),
                },
            )

        return None

    def _merge_duplicate_ai_message(self, base: list[dict[str, Any]], msg_id: str, m: Any) -> bool:
        """When the same LangGraph message id is seen again, patch stored dict (streaming usage)."""
        if not isinstance(m, AIMessage):
            return False
        inferred_usage = infer_usage_metadata_for_ai_message(m)
        resp = getattr(m, "response_metadata", None)
        if inferred_usage is None and resp is None:
            return False
        for entry in reversed(base):
            if not isinstance(entry, dict) or entry.get("id") != msg_id:
                continue
            t = str(entry.get("type") or "")
            if "AIMessage" not in t and t not in ("ai", "AIMessageChunk"):
                continue
            changed = False
            if inferred_usage is not None:
                entry["usage_metadata"] = deepcopy(inferred_usage)
                changed = True
            if resp is not None:
                entry["response_metadata"] = deepcopy(resp) if not isinstance(resp, (str, int, float, bool)) else resp
                changed = True
            return changed
        return False

    def _filter_real_messages(self, messages: list[Any], *, thread_id: str) -> list[Any]:
        """Filter to keep only real user/AI/tool messages.

        Filters out:
        - Conversation summary injections
        - Task authorization system prompts
        - Task execution instructions
        """
        result = []

        for m in messages:
            if isinstance(m, HumanMessage):
                content = str(getattr(m, "content", "") or "")
                name = getattr(m, "name", None)

                # Skip conversation summary
                if name == "conversation_summary":
                    continue

                # Skip hosted/auto-follow synthetic messages (backend orchestrator).
                if name in {"goal", "goal_controller", "hosted_autofollow", "task_autofollow"}:
                    continue

                # Skip summary / compaction injections (with or without name)
                head = content.lstrip()
                head_lower = head.lower()
                if head_lower.startswith("here is a summary of the conversation") or head_lower.startswith("here's a summary of the conversation"):
                    continue
                if head_lower.startswith("[context compaction") or head.startswith(("[上下文摘要", "[深度压缩摘要")):
                    continue

                # Skip task authorization prompts (system injected)
                if "has been authorized for execution" in content:
                    continue

                # Skip task execution instructions (system injected)
                if "Task Description:" in content and "rules:" in content.lower():
                    continue

                # Skip supervisor tool instructions
                if "Please use the supervisor_tool" in content and "Thread ID:" in content:
                    continue

                # Skip Chinese task instructions
                if "先执行任务" in content and "规则：" in content:
                    continue

                result.append(m)

            elif isinstance(m, (AIMessage, ToolMessage)):
                if isinstance(m, AIMessage):
                    try:
                        ak = getattr(m, "additional_kwargs", None) or {}
                        reasoning = ak.get("reasoning_content") if isinstance(ak, dict) else None
                        if isinstance(reasoning, str) and reasoning.strip():
                            preview = reasoning.strip().replace("\r\n", "\n").replace("\r", "\n")[:120]
                            _write_diag_log(
                                "ai_reasoning_detected",
                                {
                                    "thread_id": thread_id,
                                    "msg_id": getattr(m, "id", None),
                                    "reasoning_len": len(reasoning),
                                    "reasoning_preview": preview,
                                },
                            )
                        else:
                            _write_diag_log(
                                "ai_reasoning_missing",
                                {
                                    "thread_id": thread_id,
                                    "msg_id": getattr(m, "id", None),
                                },
                            )
                    except Exception:
                        # Best-effort only; never break message capture.
                        pass
                # Keep all AI and tool messages
                result.append(m)

        return result

    def _message_to_dict(self, m: Any) -> dict[str, Any]:
        """Convert any LangChain message to a dict for storage."""
        # If already a dict, ensure it has required fields
        if isinstance(m, dict):
            result = dict(m)
            if "timestamp" not in result:
                result["timestamp"] = utc_now_iso_z()
            return result

        # Handle LangChain message objects
        msg_type = type(m).__name__
        content = getattr(m, "content", "")
        msg_id = getattr(m, "id", None)

        result: dict[str, Any] = {
            "type": msg_type,
            "content": content,
            "id": msg_id,
        }

        # Handle tool calls in AIMessage
        if isinstance(m, AIMessage):
            tool_calls = getattr(m, "tool_calls", None)
            if tool_calls:
                result["tool_calls"] = deepcopy(tool_calls)
            # Also copy other relevant fields
            for field in ["usage_metadata", "response_metadata", "name"]:
                val = getattr(m, field, None)
                if val is not None:
                    result[field] = deepcopy(val) if not isinstance(val, (str, int, float, bool)) else val
            inferred_um = infer_usage_metadata_for_ai_message(m)
            if inferred_um:
                result["usage_metadata"] = deepcopy(inferred_um)

        # Handle tool message fields
        if isinstance(m, ToolMessage):
            tool_call_id = getattr(m, "tool_call_id", None)
            if tool_call_id:
                result["tool_call_id"] = tool_call_id
            name = getattr(m, "name", None)
            if name:
                result["name"] = name
            # For tool results, also store the status if available
            status = getattr(m, "status", None)
            if status:
                result["status"] = status

        # Add timestamp
        result["timestamp"] = utc_now_iso_z()

        return result
