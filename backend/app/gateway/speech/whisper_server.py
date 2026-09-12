#!/usr/bin/env python3
"""
EvoFlow 本地 Whisper ASR 服务
- 流式 ASR：Whisper + VAD，每次停顿触发识别
- WebSocket 服务，接收二进制 PCM → 返回转录 JSON
- 离线降级：云端 ASR 不可用时自动启用

移植自既有语音模块 whisper_server.py，简化版（移除 YAMNet）

---
使用方式：
  pip install openai-whisper websockets numpy
  python whisper_server.py --model small

首次运行自动下载模型到 ~/.cache/whisper/（small ~500MB）。
国内如遇下载慢，可用 modelscope 镜像预下载：
  pip install modelscope
  python -c "from modelscope import snapshot_download; snapshot_download('AI-ModelScope/whisper-small', cache_dir='~/.cache/whisper')"
---

import asyncio
import json
import sys
import os
import struct
from concurrent.futures import ThreadPoolExecutor

import numpy as np

try:
    import websockets
except ImportError:
    print("[whisper] missing websockets, run: pip install websockets", flush=True)
    sys.exit(1)

try:
    import whisper as _whisper
except ImportError:
    print("[whisper] missing openai-whisper, run: pip install openai-whisper", flush=True)
    sys.exit(1)

SAMPLE_RATE = 16000
CHUNK_SAMPLES = 2048

# ── VAD thresholds ──
SILENCE_RMS_THRESHOLD = 0.005
NEAR_SPEECH_RMS_THRESHOLD = 0.010
MIN_UTTERANCE_PEAK_RMS = 0.015
MIN_UTTERANCE_VOICED_CHUNKS = 2

# ── Hallucination filters (Whisper known false positives) ──
_HALLUCINATION_FRAGMENTS = [
    "字幕", "翻译", "感谢收看", "感谢观看", "谢谢收看", "谢谢观看",
    "请订阅", "请关注", "点赞", "订阅", "转发", "打赏",
    "作词", "作曲", "制作人", "出品", "版权",
    "subtitles by", "captioned by", "transcribed by",
    "www.", ".com", ".org", ".net",
]
_SINGLE_CHAR_REPEAT_THRESHOLD = 6
_PHRASE_REPEAT_THRESHOLD = 3


def is_hallucination(text: str) -> bool:
    t = text.strip().lower()
    if not t:
        return True
    for frag in _HALLUCINATION_FRAGMENTS:
        if frag.lower() in t:
            return True
    # Single char repeat detection (e.g. "啊啊啊啊啊啊啊")
    for ch in set(t):
        if len(ch.strip()) == 1 and t.count(ch) >= _SINGLE_CHAR_REPEAT_THRESHOLD:
            return True
    # Phrase repeat detection
    words = t.split()
    if len(words) >= 6:
        for i in range(len(words) - 2):
            triplet = " ".join(words[i:i + 3])
            if t.count(triplet) >= _PHRASE_REPEAT_THRESHOLD:
                return True
    return False


class WhisperServer:
    def __init__(self, host="127.0.0.1", port=3723, model_name="small"):
        self.host = host
        self.port = port
        self.model_name = model_name
        self.model = None
        self._executor = ThreadPoolExecutor(max_workers=2)

    def load_whisper(self):
        print(f"[whisper] loading model: {self.model_name}...", flush=True)
        self.model = _whisper.load_model(self.model_name)
        print(f"[whisper] model {self.model_name} loaded", flush=True)

    def _transcribe(self, audio_f32: np.ndarray, lang: str) -> str:
        prompt = self._initial_prompt(lang)
        result = self.model.transcribe(
            audio_f32,
            language=lang if lang != "auto" else None,
            fp16=False,
            verbose=False,
            temperature=0.0,
            no_speech_threshold=0.6,
            initial_prompt=prompt if prompt else None,
            condition_on_previous_text=False,
        )
        return (result.get("text") or "").strip()

    @staticmethod
    def _initial_prompt(lang: str) -> str:
        prompts = {
            "zh": "以下是普通话对话。",
            "zh-cn": "以下是普通话对话。",
            "en": "The following is spoken English.",
            "ja": "以下は日本語の会話です。",
        }
        return prompts.get(lang.lower(), "")

    async def handle(self, websocket):
        lang = "zh"
        buf_pcm = []
        in_utterance = False
        voiced_chunks = 0
        peak_rms = 0.0

        async def _flush():
            nonlocal in_utterance, voiced_chunks, peak_rms
            if not buf_pcm or voiced_chunks < MIN_UTTERANCE_VOICED_CHUNKS or peak_rms < MIN_UTTERANCE_PEAK_RMS:
                buf_pcm.clear()
                in_utterance = False
                voiced_chunks = 0
                peak_rms = 0.0
                return

            audio = np.concatenate(buf_pcm).astype(np.float32)
            buf_pcm.clear()
            in_utterance = False
            voiced_chunks = 0
            peak_rms = 0.0

            loop = asyncio.get_running_loop()
            text = await loop.run_in_executor(self._executor, self._transcribe, audio, lang)
            if text and not is_hallucination(text):
                await websocket.send(json.dumps({
                    "type": "transcript",
                    "text": text,
                    "is_final": True,
                    "seg": "local",
                }))
            else:
                await websocket.send(json.dumps({
                    "type": "transcript", "text": "", "is_final": True, "seg": "local",
                }))

        silence_count = 0
        try:
            async for msg in websocket:
                if isinstance(msg, str):
                    try:
                        cfg = json.loads(msg)
                    except Exception:
                        continue
                    if cfg.get("type") == "config":
                        lang = str(cfg.get("lang", "zh")).lower()
                    elif cfg.get("type") == "flush":
                        await _flush()
                        silence_count = 0
                    continue

                # Binary PCM chunk (16-bit, 16kHz, mono)
                if len(msg) < CHUNK_SAMPLES * 2:
                    continue
                samples = np.frombuffer(msg, dtype=np.int16).astype(np.float32) / 32768.0
                rms = float(np.sqrt(np.mean(samples ** 2)))

                if rms > SILENCE_RMS_THRESHOLD:
                    buf_pcm.append(samples)
                    silence_count = 0
                    if not in_utterance:
                        in_utterance = True
                    if rms > NEAR_SPEECH_RMS_THRESHOLD:
                        voiced_chunks += 1
                    peak_rms = max(peak_rms, rms)
                elif in_utterance:
                    buf_pcm.append(samples)
                    silence_count += 1
                    if silence_count >= 8:
                        await _flush()
                        silence_count = 0
                # 25s max utterance → force flush
                if in_utterance and len(buf_pcm) * CHUNK_SAMPLES / SAMPLE_RATE > 25:
                    await _flush()
        except websockets.exceptions.ConnectionClosed:
            pass
        finally:
            buf_pcm.clear()

    async def start(self):
        self.load_whisper()
        print(f"[whisper] server starting on ws://{self.host}:{self.port}", flush=True)
        async with websockets.serve(self.handle, self.host, self.port):
            await asyncio.Future()


def main():
    import argparse
    parser = argparse.ArgumentParser(description="EvoFlow Whisper ASR Server")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=3723)
    parser.add_argument("--model", default="small", choices=["tiny", "base", "small", "medium", "turbo"])
    args = parser.parse_args()

    server = WhisperServer(host=args.host, port=args.port, model_name=args.model)
    asyncio.run(server.start())


if __name__ == "__main__":
    main()
