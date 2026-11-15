"""Re-invoke the lead agent after a background task exits (ZCode task-notification turn).

Reliability layer (aligned with ZCode's notification pipeline):

- durable dedupe: every notification message_id is claimed in the persistent
  ``evoflow_session_inject_receipts`` table before scheduling — the in-memory
  LRU is only a fast path, so a gateway restart no longer lets duplicates through
  (the old ``_DEDUP.clear()`` bug);
- per-thread batching: notifications arriving within a short collection window
  are merged into ONE follow-up turn (one synthetic message, multiple
  <task-notification> blocks) instead of one turn per completion;
- anti-misread prefix: the merged body is wrapped with a
  ``[SYSTEM NOTIFICATION - NOT USER INPUT]`` preamble so the model never reads
  the notification as user acknowledgement.
"""

from __future__ import annotations

import hashlib
import json
import logging
import threading
from collections import OrderedDict

logger = logging.getLogger(__name__)

_NOTIFICATION_SOURCE_KIND = "task_notification_turn"

# ── fast-path dedupe: bounded LRU (evict oldest, never wholesale-clear) ──────
_DEDUP_MAX = 500
_DEDUP: OrderedDict[str, None] = OrderedDict()
_DEDUP_LOCK = threading.Lock()


def _dedup_seen_or_add(mid: str) -> bool:
    """True when ``mid`` was already seen; otherwise record it. Oldest entry evicted first."""
    with _DEDUP_LOCK:
        if mid in _DEDUP:
            _DEDUP.move_to_end(mid)
            return True
        _DEDUP[mid] = None
        while len(_DEDUP) > _DEDUP_MAX:
            _DEDUP.popitem(last=False)
        return False


def _dedup_discard(mid: str) -> None:
    with _DEDUP_LOCK:
        _DEDUP.pop(mid, None)


# ── durable ledger: claim-once in evoflow_session_inject_receipts ────────────
# Fail-open on any DB problem: notifications are low-frequency, and blocking
# every wake because the ledger is unavailable would strand finished work.
# The in-memory LRU above still guards the hot path.


def _ledger_claim(session_key: str, mid: str) -> bool:
    """True = caller may proceed (first claim or ledger unavailable).

    刻意不用 safe_try_claim_inject:它在 DB 故障时返回 False(fail-closed,
    语义是"不要 inject"),对通知意味着账本一挂所有完成事件都被吞掉。
    这里直接用 try_claim_inject 并自己 fail-open——账本不可用只损失
    去重强度,不能弄丢已完成的工作;热路径仍有内存 LRU 兜底。
    """
    try:
        from evoflow.persistence.session_runtime_repository import try_claim_inject

        return bool(try_claim_inject(session_key, _NOTIFICATION_SOURCE_KIND, mid))
    except Exception:
        logger.debug("notification ledger claim failed mid=%s", mid, exc_info=True)
        return True


def _ledger_release(session_key: str, mid: str) -> None:
    """Release a claim so a failed delivery can be retried by a later event."""
    try:
        from evoflow.persistence.session_runtime_repository import delete_inject_receipt

        delete_inject_receipt(session_key, _NOTIFICATION_SOURCE_KIND, mid)
    except Exception:
        logger.debug("notification ledger release failed mid=%s", mid, exc_info=True)


# ── per-thread batching: collect a short window, flush one merged turn ──────
_BATCH_WINDOW_SECONDS = 2.5
_BATCH_MAX_ITEMS = 20
_BATCH_LOCK = threading.Lock()
_PENDING: dict[str, list[tuple[str, str, str, str]]] = {}  # tid -> [(sk, src, text, mid)]
_COLLECTORS: dict[str, threading.Timer] = {}


def _merge_batch_text(texts: list[str]) -> str:
    """One synthetic message carrying one <task-notification> block each.

    刻意**不加**防误读前缀:转写与 wire 上的文本必须保持 `<task-notification>`
    裸块开头——前后端所有过滤(agui_mirror 落行丢弃、前端 isHiddenProviderContextUserInput、
    chat-normalize 历史归一)都按这个前缀判定;前缀一旦写进持久文本就会全部失配,
    通知会穿透到用户气泡区(E2E 已踩过)。防误读前缀由
    TaskNotificationProviderPrefixMiddleware 在 provider 请求层注入。
    """
    return "\n\n".join(texts)


def _batch_message_id(mids: list[str]) -> str:
    digest = hashlib.sha1("\n".join(sorted(mids)).encode("utf-8")).hexdigest()[:16]
    return f"task-notification-batch:{digest}"


def _dispatch_notification_turn(
    thread_id: str,
    session_key: str,
    notification_text: str,
    message_id: str,
    *,
    source: str,
) -> bool:
    """Schedule the follow-up turn on the detached loop. True = accepted."""
    from evoflow.subagents.detached_poll_scheduler import schedule_detached_poll

    schedule_detached_poll(
        _run_notification_turn(thread_id, session_key, notification_text, message_id, source=source),
        name=f"{source}-{message_id[-24:]}",
    )
    return True


def _flush_thread_batch(thread_id: str) -> None:
    with _BATCH_LOCK:
        _COLLECTORS.pop(thread_id, None)
        items = _PENDING.pop(thread_id, [])
    if not items:
        return

    session_key = items[0][0]
    source = items[0][1]
    texts = [it[2] for it in items]
    mids = [it[3] for it in items]
    merged_mid = _batch_message_id(mids)

    try:
        _dispatch_notification_turn(
            thread_id,
            session_key,
            _merge_batch_text(texts),
            merged_mid,
            source=source,
        )
        logger.info(
            "task-notification batch flushed thread=%s items=%d merged_mid=%s",
            thread_id,
            len(items),
            merged_mid,
        )
    except Exception:
        # Delivery failed before the turn was accepted — release the durable
        # claims so a later duplicate event can re-notify instead of stranding
        # the finished work. (At-least-once completion reconciliation arrives
        # with the persisted task registry; see outputs/ architecture doc §五.)
        for it in items:
            _ledger_release(it[0], it[3])
            _dedup_discard(it[3])
        logger.warning(
            "task-notification batch dispatch failed thread=%s items=%d — claims released",
            thread_id,
            len(items),
            exc_info=True,
        )


def schedule_task_notification_turn(
    *,
    thread_id: str,
    session_key: str,
    notification_text: str,
    message_id: str,
    source: str = "task-notification",
) -> bool:
    """Fire-and-forget: enqueue a follow-up LangGraph turn with a notification body.

    Used by background Bash and detached plain-chat subagents so the lead
    continues after the child finishes (``multitask_strategy=enqueue``).
    Notifications for the same thread are batched within
    ``_BATCH_WINDOW_SECONDS`` into one merged turn.

    Returns True when the notification was accepted (claimed + buffered — not
    when the turn finishes). False = deduped or invalid input — caller may
    retry later.
    """
    tid = str(thread_id or "").strip()
    text = str(notification_text or "").strip()
    mid = str(message_id or "").strip()
    if not tid or not text or not mid:
        return False
    sk = str(session_key or "").strip()
    src = str(source or "task-notification").strip() or "task-notification"

    if _dedup_seen_or_add(mid):
        return False
    if not _ledger_claim(sk, mid):
        # Durable ledger says this notification was already scheduled (possibly
        # in a previous process) — drop it.
        _dedup_discard(mid)
        return False

    flush_now = False
    with _BATCH_LOCK:
        buffer = _PENDING.setdefault(tid, [])
        buffer.append((sk, src, text, mid))
        if len(buffer) >= _BATCH_MAX_ITEMS:
            flush_now = True
        elif tid not in _COLLECTORS:
            timer = threading.Timer(
                _BATCH_WINDOW_SECONDS,
                _flush_thread_batch,
                args=(tid,),
            )
            timer.daemon = True
            _COLLECTORS[tid] = timer
            timer.start()

    if flush_now:
        _flush_thread_batch(tid)
    return True


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

    # Persist the wake input into the SSOT BEFORE posting the run.
    # lead_agent 的 provider payload 从 evoflow_chat_messages 重建(checkpoint 被
    # slim 中间件清空;hydrate 可能判 checkpoint 过期而改用 DB)——唤醒输入若只
    # 存在于 run input,会非确定性地从 payload 里消失,模型看到一段以 assistant
    # 结尾的历史,返回空(E2E 实测 output_tokens=0 + 空回退文案)。
    # persist_user_message 与面板发送同一条统一入口,幂等带 message_id。
    try:
        from evoflow.persistence.chat_session_service import persist_user_message

        persisted_tid = await persist_user_message(
            session_key or "",
            notification_text,
            message_id=message_id,
        )
        if persisted_tid:
            thread_id = persisted_tid
    except Exception:
        logger.debug(
            "persist task-notification user message failed tid=%s",
            thread_id,
            exc_info=True,
        )

    # langgraph 0.7+ 拒绝 configurable 与 context 并存(HTTP 400 "Cannot specify
    # both configurable and context")。此前 run_body 同时带两者,导致
    # StreamBackgroundWorker/SDK 路径的唤醒轮全部 400——通知被账本认领后搁浅,
    # detached 任务完成但主对话永远等不到唤醒。会话身份只放 context(现代机制,
    # 面板自身的 run 也是这么发的);recursion_limit 留在 config。
    run_config = {
        "recursion_limit": LONG_RUN_RECURSION_LIMIT,
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
                "task-notification turn started thread=%s message_id=%s",
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
                    "task-notification enqueued on busy thread=%s",
                    thread_id,
                )
            except Exception:
                logger.debug(
                    "task-notification enqueue on busy thread failed tid=%s",
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
            logger.info("task-notification SDK stream finished thread=%s", thread_id)
        except Exception:
            logger.warning(
                "task-notification turn failed thread=%s",
                thread_id,
                exc_info=True,
            )
