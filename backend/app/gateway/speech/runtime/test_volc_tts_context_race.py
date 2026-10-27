"""Volcengine async speak must not close a fresh audio context on turn-complete.

Regression: after 「收到」 sets `_is_yielding_frames_synchronously`, the next
TTSSpeak's `on_turn_context_completed` removed the new context before first
audio → synth finished with no 「首包音频下发」(2026-10-27 17:00 FE/BE logs).
"""

from __future__ import annotations

import pytest

from app.gateway.speech.runtime.pipecat_volc_tts import VolcengineTTSService


@pytest.mark.asyncio
async def test_on_turn_context_completed_keeps_open_context_for_async_speak() -> None:
    tts = VolcengineTTSService(provider="volcengine", speaker="test")
    # Simulate prior utterance finishing sync-style bookkeeping
    tts._is_yielding_frames_synchronously = True
    ctx = "ctx-body-after-ack"
    await tts.create_audio_context(ctx)
    tts._turn_context_id = ctx

    await tts.on_turn_context_completed()

    assert tts.audio_context_available(ctx), (
        "async speak owns lifetime via _bg.finally; turn-complete must not remove"
    )
    assert tts._is_yielding_frames_synchronously is False
    assert tts._turn_context_id is None
