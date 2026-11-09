"""Re-invoke the lead agent after a background Bash exits (ZCode task-notification turn)."""

from __future__ import annotations

import json
import logging
import threading

logger = logging.getLogger(__name__)

_DEDUP: set[str] = set()
_DEDUP_LOCK = threading.Lock()


def schedule_task_notification_turn(
    *,
    thread_id: str,
    session_key: str,
    notification_text: str,
    message_id: str,
    source: str = "task-notification",
) -> bool:
    """Fire-and-forget: enqueue a new LangGraph turn with a notification body.

    Used by background Bash and detached plain-chat subagents so the lead
    continues after the child finishes (``multitask_strategy=enqueue``).

    Returns True when the background poll was accepted (not when the turn
    finishes). False = deduped or failed to schedule — caller may retry later.
    """
    tid = str(thread_id or "").strip()
    text = str(notification_text or "").strip()
    mid = str(message_id or "").strip()
    if not tid or not text or not mid:
        return False
    with _DEDUP_LOCK:
        if mid in _DEDUP:
            return False
        _DEDUP.add(mid)
        if len(_DEDUP) > 500:
            _DEDUP.clear()
            _DEDUP.add(mid)

    sk = str(session_key or "").strip()
    src = str(source or "task-notification").strip() or "task-notification"

    try:
        from evoflow.subagents.detached_poll_scheduler import schedule_detached_poll

        schedule_detached_poll(
            lambda: _run_notification_turn(tid, sk, text, mid, source=src),
            name=f"{src}-{mid[-24:]}",
        )
        return True
    except Exception:
        with _DEDUP_LOCK:
            _DEDUP.discard(mid)
        logger.warning("schedule task-notification turn failed mid=%s", mid, exc_info=True)
        return False


def schedule_bash_task_notification_turn(
    *,
    thread_id: str,
    session_key: str,
    notification_text: str,
    task_id: str,
) -> None:
    """Fire-and-forget: enqueue a new LangGraph turn with the <task-notification> body."""
    schedule_task_notification_turn(
        thread_id=thread_id,
        session_key=session_key,
        notification_text=notification_text,
        message_id=f"bash-task-notification:{task_id}",
        source="bash_task_notification",
    )


async def _run_notification_turn(
    thread_id: str,
    session_key: str,
    notification_text: str,
    message_id: str,
    *,
    source: str = "bash_task_notification",
) -> None:
    from evoflow.langgraph_run_config import (
        default_langgraph_thread_metadata,
        ensure_langgraph_thread_exists,
        resolve_langgraph_base_url,
    )
    from evoflow.runtime.long_run_limits import LONG_RUN_RECURSION_LIMIT

    try:
        from langgraph_sdk import get_client
    except Exception:
        logger.warning("langgraph_sdk unavailable for task-notification")
        return

    src = str(source or "bash_task_notification").strip() or "bash_task_notification"
    client = get_client(url=resolve_langgraph_base_url())
    meta = default_langgraph_thread_metadata(
        source=src,
        session_key=session_key,
    )
    try:
        await ensure_langgraph_thread_exists(client, thread_id, metadata=meta)
    except Exception:
        logger.debug("ensure thread for task-notification failed tid=%s", thread_id, exc_info=True)

    run_config = {
        "recursion_limit": LONG_RUN_RECURSION_LIMIT,
        "configurable": {
            "session_key": session_key,
            "thread_id": thread_id,
            "triggered_by": "task-notification",
            "source": src,
        },
    }
    run_body = json.dumps(
        {
            "assistant_id": "lead_agent",
            "input": {"messages": [{"role": "human", "content": notification_text}]},
            "config": run_config,
            "context": {
                "session_key": session_key,
                "thread_id": thread_id,
                "triggered_by": "task-notification",
            },
            "stream_mode": ["messages-tuple", "values", "custom"],
            "multitask_strategy": "enqueue",
        },
        ensure_ascii=False,
    ).encode("utf-8")

    try:
        from evoflow.runtime.ports import get_stream_background_worker_cls

        WorkerCls = get_stream_background_worker_cls()
        if WorkerCls is None:
            raise RuntimeError("StreamBackgroundWorker adapter not registered")
        worker, is_new = await WorkerCls.get_or_create_with_langgraph(
            thread_id=thread_id,
            langgraph_path=f"threads/{thread_id}/runs/stream",
            request_method="POST",
            request_body=run_body,
            request_headers={"content-type": "application/json"},
        )
        if is_new:
            await worker.start()
            logger.info(
                "bash task-notification turn started thread=%s message_id=%s",
                thread_id,
                message_id,
            )
        else:
            # Worker already streaming this thread: enqueue a follow-up run.
            # Do not put this on the user steer queue — that surfaces as 纠偏 / 用户气泡.
            try:
                await client.runs.create(
                    thread_id,
                    "lead_agent",
                    input={"messages": [{"role": "human", "content": notification_text}]},
                    config=run_config,
                    multitask_strategy="enqueue",
                )
                logger.info(
                    "bash task-notification enqueued on busy thread=%s",
                    thread_id,
                )
            except Exception:
                logger.debug(
                    "bash task-notification enqueue on busy thread failed tid=%s",
                    thread_id,
                    exc_info=True,
                )
    except Exception:
        # Gateway process may not expose StreamBackgroundWorker (harness-only). Fall back to SDK stream.
        try:
            async for _ in client.runs.stream(
                thread_id,
                "lead_agent",
                input={"messages": [{"role": "human", "content": notification_text}]},
                config=run_config,
                stream_mode=["messages-tuple", "values"],
                multitask_strategy="enqueue",
            ):
                pass
            logger.info("bash task-notification SDK stream finished thread=%s", thread_id)
        except Exception:
            logger.warning(
                "bash task-notification turn failed thread=%s",
                thread_id,
                exc_info=True,
            )
