"""Manual context compaction for Gateway API (same engine as model-call middleware)."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

from langchain_core.messages import BaseMessage

# 【self-evolution-bot · 2026-11-20 · 第94轮 · 模型:deepseek-v4.1-flash-1017】
# 改了什么：补 `get_compaction_trigger_cache` 导入。
# 为什么：自带摘要分支要持 `try_acquire_compress` 租约防与自动压缩并发，但它从没被
# import 过 —— 该分支一下去就 `NameError: name 'get_compaction_trigger_cache' is not
# defined`，等于新通路在"手工压缩"这个真实入口上**完全跑不起来**（本轮测试 8 红暴露）。
from evoflow.agents.compaction_trigger import get_compaction_trigger_cache
from evoflow.agents.context_compaction_core import compaction_token_snapshot, get_context_compaction_engine, is_conversation_summary_human
from evoflow.agents.middlewares.context_compaction_middleware import build_ephemeral_model_messages
from evoflow.agents.middlewares.session_transcript_hydration_middleware import (
    lead_transcript_rows_to_lc_messages,
)
from evoflow.config.summarization_config import get_compaction_settings, get_summarization_config
from evoflow.persistence.chat_message_repositories import (
    list_lead_chat_rows_for_model_hydration,
)
from evoflow.persistence.session_context_usage import build_context_usage_snapshot
from evoflow.utils.model_context_length import resolve_model_context_length

logger = logging.getLogger(__name__)


class ManualCompactionError(Exception):
    """User-facing manual compaction failure."""

    def __init__(self, message: str, *, status_code: int = 422) -> None:
        super().__init__(message)
        self.status_code = status_code


@dataclass(frozen=True)
class ManualCompactionResult:
    ok: bool
    changed: bool
    reason: str
    before_gate_tokens: int
    after_gate_tokens: int
    before_message_count: int
    after_message_count: int
    context_usage: dict[str, Any]
    persisted_summary: bool


class _ManualCompactionRuntime:
    """Minimal Runtime stand-in for compaction helpers."""

    __slots__ = ("context",)

    def __init__(self, *, thread_id: str, session_key: str, model_name: str | None) -> None:
        self.context = {
            "thread_id": thread_id,
            "session_key": session_key,
            "model_name": model_name,
        }


def _resolve_session_model_name(row: dict[str, Any] | None) -> str | None:
    if not row:
        return None
    for key in ("modelName", "model_name", "primaryModelName", "primary_model_name"):
        val = str(row.get(key) or "").strip()
        if val:
            return val
    ctx = row.get("context")
    if isinstance(ctx, dict):
        for key in ("model_name", "primary_model_name"):
            val = str(ctx.get(key) or "").strip()
            if val:
                return val
    return None


async def run_manual_context_compaction(
    session_key: str,
    *,
    session_row: dict[str, Any] | None = None,
    supplied_summary: str | None = None,
) -> ManualCompactionResult:
    sk = str(session_key or "").strip()
    if not sk:
        raise ManualCompactionError("session_key required")

    row = session_row
    if row is None:
        from evoflow.persistence.session_repositories import get_session_row_for_ui

        row = get_session_row_for_ui(sk)
    if not row:
        raise ManualCompactionError("session not found", status_code=404)

    if not get_summarization_config().enabled:
        raise ManualCompactionError("context compaction is disabled")

    thread_id = str(row.get("threadId") or row.get("thread_id") or "").strip()
    if not thread_id:
        raise ManualCompactionError("session has no bound thread_id")

    rows = list_lead_chat_rows_for_model_hydration(sk)
    messages: list[BaseMessage] = lead_transcript_rows_to_lc_messages(rows)
    if len(messages) < 2:
        raise ManualCompactionError("not enough messages to compact")

    model_name = _resolve_session_model_name(row)
    context_length = resolve_model_context_length(model_name)
    runtime = _ManualCompactionRuntime(
        thread_id=thread_id,
        session_key=sk,
        model_name=model_name,
    )

    before = compaction_token_snapshot(messages, context_length=context_length)
    if supplied_summary and supplied_summary.strip():
        # 【self-evolution-bot · 2026-11-20 · 第94轮 · 模型:deepseek-v4.1-flash-1017】
        # 改了什么：调用方自带摘要时走 `fold_with_supplied_summary`，**不调用压缩模型**。
        # 为什么：agent 自己就在这份上下文里，让它直接写摘要比另雇一个模型重读整段
        # transcript 省一次长上下文调用（`_generate_summary` 会把全部消息序列化成
        # 一个 prompt 再喂给 compress 模型）。
        # 另：全程持 `try_acquire_compress` 租约，防与自动压缩并发（两路同时折叠同
        # 一个 thread 会各插一条 summary 行、互相覆盖内存视图）。
        trigger_cache = get_compaction_trigger_cache()
        if not trigger_cache.try_acquire_compress(thread_id):
            raise ManualCompactionError(
                "压缩正在进行中（本对话已有另一路压缩在跑），请稍后重试",
                status_code=409,
            )
        try:
            settings = get_compaction_settings()
            folded, changed = get_context_compaction_engine().fold_with_supplied_summary(
                messages,
                summary=supplied_summary,
                thread_id=thread_id,
                context_length=context_length,
                threshold_ratio=settings.threshold_ratio,
                aggressive_ratio=settings.aggressive_ratio,
                protect_first_n=settings.protect_first_n,
                protect_tail_messages=settings.protect_tail_messages,
                protect_tail_tool_rounds=settings.protect_tail_tool_rounds,
                session_key=sk,
            )
        finally:
            trigger_cache.release_compress(thread_id)
        after_msgs = folded if changed else messages
        after = compaction_token_snapshot(after_msgs, context_length=context_length)
        reason = "manual_compact_supplied"
        # changed=False 时没有新落盘（fold_with_supplied_summary 在无效折叠时提前
        # 返回、不插 summary 行），不能谎报「已写入持久化摘要」。
        persisted_summary = bool(changed)

        saved = before["gate_tokens"] - after["gate_tokens"]
        context_usage = build_context_usage_snapshot(
            used_tokens=after["gate_tokens"],
            window_tokens=context_length,
            message_count=after["message_count"],
            before_tokens=before["gate_tokens"] if saved > 0 else None,
            compacted=saved > 0,
            note=reason,
        )
        if saved <= 0:
            from evoflow.persistence.session_context_usage import persist_session_context_usage

            persist_session_context_usage(sk, context_usage)
        logger.info(
            "[context-compaction] manual(supplied) session=%s thread=%s changed=%s before=%d after=%d msgs=%d→%d",
            sk[:24],
            thread_id[:16],
            changed,
            before["gate_tokens"],
            after["gate_tokens"],
            before["message_count"],
            after["message_count"],
        )
        return ManualCompactionResult(
            ok=True,
            changed=changed,
            reason=reason,
            before_gate_tokens=before["gate_tokens"],
            after_gate_tokens=after["gate_tokens"],
            before_message_count=before["message_count"],
            after_message_count=after["message_count"],
            context_usage=context_usage,
            persisted_summary=persisted_summary,
        )

    folded = await build_ephemeral_model_messages(messages, runtime, force=True, trigger_source="manual")
    after_msgs = folded if folded is not None else messages
    after = compaction_token_snapshot(after_msgs, context_length=context_length)
    changed = folded is not None and (after["gate_tokens"] < before["gate_tokens"] or after["message_count"] < before["message_count"])

    # 【self-evolution-bot · 2026-11-21 · 第110轮 · 模型:deepseek-v4.1-flash-1017】
    # 改了什么：手工压缩成功后**不再**二次调用 `set_previous_summary`。
    # 为什么（现网实证）：`build_ephemeral_model_messages` → compress_messages(_fast)
    # 里已经 `persist_compaction_summary_from_messages(..., force_write=True)` 插过一行；
    # 这里再 `set_previous_summary` 又 force INSERT 一条相同正文（实测 seq 10370/10371
    # 相隔 ~79ms、content 字节全等、message_id 各一个 uuid）。`persist_conversation_summary`
    # 是尾部 INSERT 不是 UPDATE，hydration 虽只取最新一行，磁盘会成对堆垃圾
    # （本会话已有 35 条 conversation_summary）。
    # 新口径：引擎落盘即权威；本处只探测 folded 里是否已有 summary 行来填回执字段。
    persisted_summary = False
    reason = "manual_compact"
    if changed and folded is not None:
        for msg in folded:
            if not is_conversation_summary_human(msg):
                continue
            content = getattr(msg, "content", None)
            if isinstance(content, str) and content.strip():
                persisted_summary = True
                break
    elif folded is None:
        reason = "no_op"

    saved = before["gate_tokens"] - after["gate_tokens"]
    context_usage = build_context_usage_snapshot(
        used_tokens=after["gate_tokens"],
        window_tokens=context_length,
        message_count=after["message_count"],
        before_tokens=before["gate_tokens"] if saved > 0 else None,
        compacted=saved > 0,
        note=reason,
    )

    if saved <= 0:
        from evoflow.persistence.session_context_usage import persist_session_context_usage

        persist_session_context_usage(sk, context_usage)

    logger.info(
        "[context-compaction] manual session=%s thread=%s changed=%s before=%d after=%d msgs=%d→%d persisted=%s",
        sk[:24],
        thread_id[:16],
        changed,
        before["gate_tokens"],
        after["gate_tokens"],
        before["message_count"],
        after["message_count"],
        persisted_summary,
    )

    return ManualCompactionResult(
        ok=True,
        changed=changed,
        reason=reason,
        before_gate_tokens=before["gate_tokens"],
        after_gate_tokens=after["gate_tokens"],
        before_message_count=before["message_count"],
        after_message_count=after["message_count"],
        context_usage=context_usage,
        persisted_summary=persisted_summary,
    )
