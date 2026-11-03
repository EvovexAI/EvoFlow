"""Per-sentence tone inference for TTS — 轻量启发式，不依赖模型改动。

每句正文合成前推断语气，映射为火山 TTS 表现力参数：
  emotion        additions.emotion（音色不支持时服务端忽略，不报错）
  emotion_scale  1-5，默认 4；启发式统一用 3（克制的情绪，避免戏太多）
  rate_delta     audio_params.speech_rate 增量（基础值 DEFAULT_TTS_SPEECH_RATE=15，
                 范围 -50..100）；gentle 放慢 / urgent 加快对听感最直接

启发式优先级：惊讶 > 紧急 > 委婉 > 明亮（坏消息先于好消息匹配）。
LLM 内联标记 ``[[tone:xxx]]`` 的解析留待 agent prompt 侧启用——标记剥离已内置于
``aggregators.normalize_for_tts``，提前透出也不会念出来。
"""

from __future__ import annotations

import re
from typing import Any

# 语气线索（按句匹配）
_SURPRISED_RE = re.compile(r"竟然|居然|怎么会|没想到|难以置信|不可思议")
_URGENT_RE = re.compile(r"紧急|尽快|马上|立刻|立即|赶紧|尽快|注意|小心|警告|超时|失败|风险|别忘")
_GENTLE_RE = re.compile(r"抱歉|对不起|不好意思|别急|别担心|慢慢来|没关系|没关係|理解|辛苦|别灰心")
_BRIGHT_RE = re.compile(r"恭喜|太好了|成功|搞定|完成|通过|好消息|真棒|很不错|漂亮|顺利")

# 语速增量（volc speech_rate 基础 15，全范围 -50..100；克制的 ±10 内）
_RATE_URGENT = 10
_RATE_GENTLE = -8
_RATE_BRIGHT = 3

_MIN_TONE_CHARS = 6


def infer_tone(text: str) -> dict[str, Any] | None:
    """推断一句话的语气 → ``{"emotion": str|None, "emotion_scale": int, "rate_delta": int}``。

    无匹配/太短（确认短句等）返回 None —— 保持默认音色语速。
    """
    t = str(text or "").strip()
    if len(t) < _MIN_TONE_CHARS:
        return None
    if _SURPRISED_RE.search(t):
        return {"emotion": "surprised", "emotion_scale": 3, "rate_delta": 0}
    if _URGENT_RE.search(t):
        return {"emotion": None, "emotion_scale": 0, "rate_delta": _RATE_URGENT}
    if _GENTLE_RE.search(t):
        return {"emotion": None, "emotion_scale": 0, "rate_delta": _RATE_GENTLE}
    if _BRIGHT_RE.search(t):
        return {"emotion": "happy", "emotion_scale": 3, "rate_delta": _RATE_BRIGHT}
    return None


def tone_speech_rate(base_rate: int, tone: dict[str, Any] | None) -> int:
    """应用语速增量并夹紧到安全区间。"""
    delta = int((tone or {}).get("rate_delta") or 0)
    return max(0, min(60, int(base_rate) + delta))
