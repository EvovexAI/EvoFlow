"""Run one lead-agent step with gateway SSE mirror (hosted goal main_agent node)."""

from __future__ import annotations

import json
import logging
from typing import Any

logger = logging.getLogger(__name__)


async def stream_lead_agent_goal_step(
    *,
    lead_thread_id: str,
    session_key: str,
    continuation: str,
    lead_config: dict[str, Any],
    run_context: dict[str, Any] | None = None,
) -> str | None:
    """Stream lead agent via LangGraph SDK; mirror tokens for chat stream-resume."""
    from langgraph_sdk import get_client

    from app.gateway.sse_ui_normalize import UiStreamNormalizer
    from app.gateway.streaming.stream_mirror import enqueue_wire_text
    from evoflow.langgraph_run_config import (
        default_langgraph_thread_metadata,
        ensure_langgraph_thread_exists,
        is_thread_or_assistant_not_found_error,
        json_safe_run_dict,
        merge_configurable_into_context,
        resolve_langgraph_base_url,
    )
    from evoflow.session_execution.lifecycle import force_end_session_turn, start_session_turn

    client = get_client(url=resolve_langgraph_base_url())
    normalizer = UiStreamNormalizer(user_input=continuation, thread_id=lead_thread_id)
    run_id: str | None = None

    run_config = dict(lead_config)
    merged_context = dict(run_context or {})
    merged_context.setdefault("goal_automated", True)
    merged_context.setdefault("goal_mode", True)
    run_config, merged_context = merge_configurable_into_context(run_config, merged_context)
    run_config = json_safe_run_dict(run_config)
    merged_context = json_safe_run_dict(merged_context)

    thread_meta = default_langgraph_thread_metadata(
        source="hosted_goal_main_agent",
        session_key=session_key,
    )

    async def _ensure_lead_thread() -> None:
        await ensure_langgraph_thread_exists(client, lead_thread_id, metadata=thread_meta)

    async def _consume_stream() -> None:
        nonlocal run_id
        async for chunk in client.runs.stream(
            lead_thread_id,
            "lead_agent",
            input={"messages": []},
            config=run_config,
            context=merged_context,
            stream_mode=["messages-tuple", "values", "custom"],
            multitask_strategy="reject",
        ):
            event = str(getattr(chunk, "event", "") or "").strip()
            data = getattr(chunk, "data", None)
            if event == "metadata" and isinstance(data, dict):
                rid = str(data.get("run_id") or "").strip()
                if rid and rid != run_id:
                    run_id = rid
                    start_session_turn(
                        session_key=session_key,
                        thread_id=lead_thread_id,
                        run_id=run_id,
                        source="hosted_goal",
                    )
            if data is None:
                continue
            data_json = data
            if isinstance(data, (bytes, bytearray)):
                try:
                    data_json = json.loads(data.decode("utf-8", errors="ignore"))
                except (ValueError, TypeError, UnicodeDecodeError):
                    continue
            elif isinstance(data, str):
                try:
                    data_json = json.loads(data)
                except (ValueError, TypeError):
                    continue
            try:
                frames = normalizer.feed_frame(event, data_json)
            except Exception:
                logger.debug("goal main_agent feed_frame failed thread=%s", lead_thread_id, exc_info=True)
                continue
            for frame_bytes in frames:
                frame_str = (
                    frame_bytes.decode("utf-8")
                    if isinstance(frame_bytes, (bytes, bytearray))
                    else str(frame_bytes)
                )
                enqueue_wire_text(
                    lead_thread_id,
                    frame_str,
                    run_id=run_id,
                    session_key=session_key,
                )

    try:
        await _ensure_lead_thread()
        try:
            await _consume_stream()
        except Exception as exc:
            if not is_thread_or_assistant_not_found_error(exc):
                raise
            logger.warning(
                "goal main_agent thread/assistant missing, recreating thread=%s: %s",
                lead_thread_id,
                exc,
            )
            await _ensure_lead_thread()
            await _consume_stream()

        for frame_bytes in normalizer.finish():
            frame_str = (
                frame_bytes.decode("utf-8")
                if isinstance(frame_bytes, (bytes, bytearray))
                else str(frame_bytes)
            )
            enqueue_wire_text(
                lead_thread_id,
                frame_str,
                run_id=run_id,
                session_key=session_key,
            )
    finally:
        try:
            force_end_session_turn(session_key=session_key, thread_id=lead_thread_id, source="hosted_goal_finally")
        except Exception:
            logger.debug("goal main_agent mark run ended failed thread=%s", lead_thread_id, exc_info=True)

    return run_id
