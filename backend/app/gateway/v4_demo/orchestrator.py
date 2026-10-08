"""H1 demo: per-session 内存态 + streaming。

简化为：用户 send_text 后，异步把 assistantText / reasoning 流式写入 writer。
后端 router 仅暴露 ``POST /v4/demo/send_text`` + ``GET /v4/demo/stream/{sid}``。
"""

from __future__ import annotations

import asyncio
import logging
import os
import uuid
from dataclasses import dataclass, field
from typing import Any

from .projection import ConversationProjectionWriter
from .writer_registry import get_or_create_writer  # H3-B-1

logger = logging.getLogger(__name__)


@dataclass
class _Session:
    """极简内存 session；只跑 H1 demo。"""
    session_id: str
    writer: ConversationProjectionWriter
    subscription_id: str
    turn_id: str
    user_input_row_id: int
    turn_header_row_id: int
    assistant_text_row_id: int = 0
    reasoning_row_id: int = 0
    assistant_text: str = ""
    reasoning: str = ""
    """early user input text for echoing."""
    user_text: str = ""
    """completion Future for the currently streaming turn."""
    done_event: asyncio.Event = field(default_factory=asyncio.Event)


class H1DemoOrchestrator:
    """极简 orchestrator：1 sender thread per session，对外暴露 per-session state。"""

    def __init__(self) -> None:
        self._sessions: dict[str, _Session] = {}
        self._lock = asyncio.Lock()

    async def new_session(self) -> tuple[str, str]:
        """新 session。返回 ``(session_id, subscription_id)``。"""
        session_id = f"demo-{uuid.uuid4().hex[:8]}"
        subscription_id = f"sub-{uuid.uuid4().hex[:8]}"
        # 初始 turn_header + user_input 是空的；让用户先 send_text
        sess = _Session(
            session_id=session_id,
            writer=get_or_create_writer(session_id),
            subscription_id=subscription_id,
            turn_id="",
            user_input_row_id=0,
            turn_header_row_id=0,
        )
        async with self._lock:
            self._sessions[session_id] = sess
        return session_id, subscription_id

    def get_session(self, session_id: str) -> _Session | None:
        return self._sessions.get(session_id)

    async def send_text(self, session_id: str, text: str) -> dict[str, Any]:
        """前端 send_command(sendText) 入口；写 turn_header + user_input，然后异步流式 assistant。"""
        sess = self._sessions.get(session_id)
        if not sess:
            raise KeyError(session_id)
        sess.writer._state.next_row_id = 1  # 重置 from 1
        rid_counter = 0

        def next_id() -> int:
            nonlocal rid_counter
            rid_counter += 1
            return rid_counter

        turn_header_rid = next_id()
        user_input_rid = next_id()
        assistant_rid = next_id()
        reasoning_rid = next_id()

        sess.turn_id = f"turn-{uuid.uuid4().hex[:8]}"
        sess.turn_header_row_id = turn_header_rid
        sess.user_input_row_id = user_input_rid
        sess.assistant_text_row_id = assistant_rid
        sess.reasoning_row_id = reasoning_rid
        sess.user_text = text
        sess.assistant_text = ""
        sess.reasoning = ""
        sess.done_event.clear()
        now_ms = int(asyncio.get_event_loop().time() * 1000)

        sess.writer.emit_row_appended(
            sess.subscription_id,
            {
                "rowId": turn_header_rid,
                "turnId": sess.turn_id,
                "kind": "turnHeader",
                "origin": "userInput",
                "state": "running",
                "startedAt": now_ms,
                "createdAt": now_ms,
                "createdAtSeq": 0,
            },
        )
        sess.writer.emit_row_appended(
            sess.subscription_id,
            {
                "rowId": user_input_rid,
                "turnId": sess.turn_id,
                "kind": "userInput",
                "text": text,
                "origin": "realUser",
                "createdAt": now_ms,
                "createdAtSeq": 1,
            },
        )
        # 启动流式 producer
        asyncio.create_task(self._stream_assistant(sess, reasoning_rid, assistant_rid))
        return {"turnId": sess.turn_id}

    async def _stream_assistant(
        self,
        sess: _Session,
        reasoning_rid: int,
        assistant_rid: int,
    ) -> None:
        """推进 assistantText / reasoning 流式；demo 用固定文本。"""
        # H1 demo：硬编码流式内容，不调真实 LLM。
        assistant_target = (
            f"Echo from H1 demo v4 protocol: 我收到了 ``{sess.user_text}``。"
            f"完整 v4 chat 在你面前，手写风格。"
        )
        reasoning_target = (
            "我需要先 echo 回 user。"
            "H1 是个 demo，全套 v4 spec 在 docs/protocol-evolution-spec.md。"
            "现在正在逐步写入 row.upserted..."
        )
        now_ms = int(asyncio.get_event_loop().time() * 1000)

        sess.writer.emit_row_appended(
            sess.subscription_id,
            {
                "rowId": reasoning_rid,
                "turnId": sess.turn_id,
                "kind": "reasoning",
                "state": "streaming",
                "text": "",
                "createdAt": now_ms,
                "createdAtSeq": 2,
            },
        )
        sess.writer.emit_row_appended(
            sess.subscription_id,
            {
                "rowId": assistant_rid,
                "turnId": sess.turn_id,
                "kind": "assistantText",
                "state": "streaming",
                "text": "",
                "createdAt": now_ms,
                "createdAtSeq": 3,
            },
        )

        # 流式 reasoning
        for i in range(0, len(reasoning_target), 4):
            chunk = reasoning_target[: i + 4]
            sess.writer.emit_row_upserted(
                sess.subscription_id,
                {
                    "rowId": reasoning_rid,
                    "turnId": sess.turn_id,
                    "kind": "reasoning",
                    "state": "streaming",
                    "text": chunk,
                    "createdAt": now_ms,
                    "createdAtSeq": 2,
                },
            )
            await asyncio.sleep(0.03)
        sess.writer.emit_row_upserted(
            sess.subscription_id,
            {
                "rowId": reasoning_rid,
                "turnId": sess.turn_id,
                "kind": "reasoning",
                "state": "complete",
                "text": reasoning_target,
                "createdAt": now_ms,
                "createdAtSeq": 2,
            },
        )

        # H3-A 可选真实 LLM 流（feature-flag）。默认 echo；设 ``EVOFLOW_V4_LLM=1`` 启用
        # 用 OpenAI 兼容 provider（``EVOFLOW_LLM_BASE_URL`` / ``EVOFLOW_LLM_API_KEY``）。
        if os.getenv("EVOFLOW_V4_LLM", "").strip() in ("1", "true", "yes"):
            await _stream_real_llm(sess, assistant_rid, sess.user_text, now_ms)
            sess.writer.emit_row_upserted(
                sess.subscription_id,
                {
                    "rowId": sess.turn_header_row_id,
                    "turnId": sess.turn_id,
                    "kind": "turnHeader",
                    "origin": "userInput",
                    "state": "completedSuccess",
                    "startedAt": now_ms,
                    "endedAt": int(asyncio.get_event_loop().time() * 1000),
                    "createdAt": now_ms,
                    "createdAtSeq": 0,
                },
            )
            sess.done_event.set()
            logger.info("[h1-demo] real LLM turn complete session=%s", sess.session_id)
            return

        # 流式 assistant text
        for i in range(0, len(assistant_target), 6):
            chunk = assistant_target[: i + 6]
            sess.writer.emit_row_upserted(
                sess.subscription_id,
                {
                    "rowId": assistant_rid,
                    "turnId": sess.turn_id,
                    "kind": "assistantText",
                    "state": "streaming",
                    "text": chunk,
                    "createdAt": now_ms,
                    "createdAtSeq": 3,
                },
            )
            await asyncio.sleep(0.04)
        sess.writer.emit_row_upserted(
            sess.subscription_id,
            {
                "rowId": assistant_rid,
                "turnId": sess.turn_id,
                "kind": "assistantText",
                "state": "complete",
                "text": assistant_target,
                "createdAt": now_ms,
                "createdAtSeq": 3,
            },
        )
        sess.writer.emit_row_upserted(
            sess.subscription_id,
            {
                "rowId": sess.turn_header_row_id,
                "turnId": sess.turn_id,
                "kind": "turnHeader",
                "origin": "userInput",
                "state": "completedSuccess",
                "startedAt": now_ms,
                "endedAt": now_ms + 1,
                "createdAt": now_ms,
                "createdAtSeq": 0,
            },
        )
        sess.done_event.set()
        logger.info("[h1-demo] turn complete session=%s", sess.session_id)


async def _stream_real_llm(
    sess: _Session,
    assistant_rid: int,
    user_text: str,
    now_ms: int,
) -> None:
    """H3-A: 用 OpenAI 兼容 provider 真实流式生成 assistantText。

    Env:
      EVOFLOW_LLM_BASE_URL  e.g. "http://127.0.0.1:11434/v1"
      EVOFLOW_LLM_API_KEY   optional (绝大多数本地 server 不需要)
      EVOFLOW_LLM_MODEL     e.g. "qwen2.5:7b" / "gpt-4o-mini"
    """
    import httpx  # 局部 import 避免硬依赖

    base_url = os.getenv("EVOFLOW_LLM_BASE_URL", "").rstrip("/")
    api_key = os.getenv("EVOFLOW_LLM_API_KEY", "").strip()
    model = os.getenv("EVOFLOW_LLM_MODEL", "echo-model")
    if not base_url:
        sess.writer.emit_row_upserted(
            sess.subscription_id,
            {
                "rowId": assistant_rid,
                "turnId": sess.turn_id,
                "kind": "assistantText",
                "state": "complete",
                "text": "EVOFLOW_V4_LLM=1 但 EVOFLOW_LLM_BASE_URL 未设置 — 退回 echo。",
                "createdAt": now_ms,
                "createdAtSeq": 3,
            },
        )
        return  # turn_header 终态由调用方（_stream_assistant real-LLM 分支）负责

    headers: dict[str, str] = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    payload: dict[str, Any] = {
        "model": model,
        "messages": [{"role": "user", "content": user_text}],
        "stream": True,
        "temperature": 0.7,
    }

    buf = ""
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(60.0)) as client:
            async with client.stream("POST", f"{base_url}/chat/completions", json=payload, headers=headers) as resp:
                resp.raise_for_status()
                async for line in resp.aiter_lines():
                    if not line:
                        continue
                    if line.startswith("data:"):
                        data = line[5:].strip()
                        if data == "[DONE]":
                            break
                        try:
                            obj = __import__("json").loads(data)
                            delta = obj.get("choices", [{}])[0].get("delta", {}).get("content") or ""
                            if delta:
                                buf += delta
                                sess.writer.emit_row_upserted(
                                    sess.subscription_id,
                                    {
                                        "rowId": assistant_rid,
                                        "turnId": sess.turn_id,
                                        "kind": "assistantText",
                                        "state": "streaming",
                                        "text": buf,
                                        "createdAt": now_ms,
                                        "createdAtSeq": 3,
                                    },
                                )
                        except Exception:
                            continue
        final_text = buf if buf else "(no content)"
    except Exception as e:  # 网络/解析失败 → echo
        logger.warning("[h1-demo] real LLM failed, falling back to echo: %s", e)
        final_text = f"⚠️ LLM 不可达，退回 echo：你说了 ``{user_text}``。"

    sess.writer.emit_row_upserted(
        sess.subscription_id,
        {
            "rowId": assistant_rid,
            "turnId": sess.turn_id,
            "kind": "assistantText",
            "state": "complete",
            "text": final_text,
            "createdAt": now_ms,
            "createdAtSeq": 3,
        },
    )


# 单例
ORCHESTRATOR = H1DemoOrchestrator()
