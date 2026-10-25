"""Speech session manager — P1 首片：`/api/speech/session` 单 WS 的流式 TTS 通道。

设计（docs/design/xiaowei-voice-experience-upgrade.md §6）：
- 本片只承载 TTS 下行：客户端发 `speak(seq,text)`，网关进程内调火山流式合成，
  边合成边把 mp3 分片推回（`tts_start` → binary… → `tts_end`），
  省掉逐句 HTTP 的握手与整段等待（首句快 ~150-300ms）。
- 二进制上行（麦克风 PCM → 后端 VAD/ASR）为后续增量预留：收到即忽略。
- agent 内化 + 预测执行在下一片（需要 agent 运行管线的 speculative/cancel）。

协议：
  C→S {"type":"start","speaker":"..."}
  C→S {"type":"speak","seq":1,"text":"...","speaker":"..."}
  C→S {"type":"barge_in"}      # 打断：取消所有进行中的合成
  C→S {"type":"stop"}
  S→C {"type":"ready"}
  S→C {"type":"tts_start","seq":1} → <binary mp3 分片>… → {"type":"tts_end","seq":1}
  S→C {"type":"interrupted"}   # barge_in 生效
  S→C {"type":"error","message":"..."}
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

from fastapi import WebSocket, WebSocketDisconnect

from app.gateway.speech.volcengine_speech import (
    speech_configured,
    synthesize_speech_v3_stream,
)

logger = logging.getLogger("evoflow.speech.session")

# 同一会话并发行成的句子上限（客户端预取 2 句 + 余量）
_MAX_CONCURRENT_TTS = 3
# 单句合成的总时长上限（防止上游 hang 拖死会话）
_TTS_TIMEOUT_S = 60.0


class SpeechSession:
    """一个 /session WebSocket 连接的会话编排（TTS 通道片）。"""

    def __init__(self, ws: WebSocket) -> None:
        self._ws = ws
        self._default_speaker: str | None = None
        self._tasks: dict[int, asyncio.Task[None]] = {}
        self._closing = False

    async def run(self) -> None:
        await self._ws.accept()
        if not speech_configured():
            try:
                await self._ws.send_json({"type": "error", "message": "speech not configured"})
                await self._ws.close(code=1013, reason="speech not configured")
            except Exception:
                pass
            return

        await self._ws.send_json({"type": "ready"})
        try:
            while True:
                msg = await self._ws.receive()
                if msg.get("type") == "websocket.disconnect":
                    break
                if msg.get("bytes") is not None:
                    # 麦克风 PCM 上行位（后续增量接 VAD/ASR），本片忽略
                    continue
                text = msg.get("text")
                if not text:
                    continue
                try:
                    data: dict[str, Any] = json.loads(text)
                except Exception:
                    continue
                op = str(data.get("type") or "")
                if op == "start":
                    speaker = str(data.get("speaker") or "").strip()
                    self._default_speaker = speaker or None
                elif op == "speak":
                    await self._on_speak(data)
                elif op == "cancel":
                    self._cancel_seq(int(data.get("seq") or 0))
                elif op == "barge_in":
                    await self._on_barge_in()
                elif op == "stop":
                    break
        except WebSocketDisconnect:
            pass
        except Exception as e:  # noqa: BLE001 — 会话级兜底，避免裸异常打崩网关
            logger.warning("speech session loop error: %s", e)
        finally:
            await self._close()

    # ── speak ──

    async def _on_speak(self, data: dict[str, Any]) -> None:
        seq = int(data.get("seq") or 0)
        text = str(data.get("text") or "").strip()
        if not seq or not text:
            return
        speaker = str(data.get("speaker") or "").strip() or self._default_speaker
        # 复用同 seq：先取消旧任务（客户端不应重发，防御）
        old = self._tasks.pop(seq, None)
        if old and not old.done():
            old.cancel()
        if len(self._tasks) >= _MAX_CONCURRENT_TTS:
            # 退最旧的一句，保证最新（正在播的下一句）能进来
            oldest = min(self._tasks)
            t = self._tasks.pop(oldest)
            if not t.done():
                t.cancel()
            try:
                await self._ws.send_json({"type": "tts_drop", "seq": oldest})
            except Exception:
                pass
        self._tasks[seq] = asyncio.create_task(self._speak_task(seq, text, speaker))

    async def _speak_task(self, seq: int, text: str, speaker: str | None) -> None:
        try:
            await self._ws.send_json({"type": "tts_start", "seq": seq})
            sent = 0

            async def _pump() -> int:
                nonlocal sent
                gen = synthesize_speech_v3_stream(text, speaker=speaker or None)
                async for chunk in gen:
                    if not isinstance(chunk, (bytes, bytearray, memoryview)):
                        continue
                    # 二进制帧前 4 字节 = seq（小端）：并句预取时分片可能交错，客户端按头归属
                    frame = seq.to_bytes(4, "little") + bytes(chunk)
                    await self._ws.send_bytes(frame)
                    sent += len(chunk)
                return sent

            total = await asyncio.wait_for(_pump(), timeout=_TTS_TIMEOUT_S)
            await self._ws.send_json({"type": "tts_end", "seq": seq, "bytes": total})
        except asyncio.CancelledError:
            # barge_in / 顶替 / 会话关闭：尽力补一个 end，让客户端别等
            try:
                await self._ws.send_json({"type": "tts_end", "seq": seq, "bytes": 0, "cancelled": True})
            except Exception:
                pass
            raise
        except (TimeoutError, asyncio.TimeoutError):
            logger.warning("tts speak timeout seq=%s", seq)
            try:
                await self._ws.send_json({"type": "tts_error", "seq": seq, "message": "tts timeout"})
            except Exception:
                pass
        except Exception as e:  # noqa: BLE001
            logger.warning("tts speak failed seq=%s: %s", seq, e)
            try:
                await self._ws.send_json({"type": "tts_error", "seq": seq, "message": str(e)})
            except Exception:
                pass
        finally:
            self._tasks.pop(seq, None)

    # ── barge-in / teardown ──

    def _cancel_seq(self, seq: int) -> None:
        """单句取消（客户端回退 HTTP 时用，不影响其他进行中的句子）。"""
        if not seq:
            return
        task = self._tasks.get(seq)
        if task and not task.done():
            task.cancel()

    async def _on_barge_in(self) -> None:
        cancelled = False
        for seq, task in list(self._tasks.items()):
            if not task.done():
                task.cancel()
                cancelled = True
        if cancelled:
            try:
                await self._ws.send_json({"type": "interrupted"})
            except Exception:
                pass

    async def _close(self) -> None:
        if self._closing:
            return
        self._closing = True
        tasks = [t for t in self._tasks.values() if not t.done()]
        for task in tasks:
            task.cancel()
        if tasks:
            # 收敛取消（CancelledError 需 return_exceptions 吞掉），最长等 0.5s
            done, _ = await asyncio.wait(tasks, timeout=0.5)
        self._tasks.clear()
