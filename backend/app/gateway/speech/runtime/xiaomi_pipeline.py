"""Build the Xiaomi voice pipeline — full Pipecat VAD/STT/Turn/TTS."""

from __future__ import annotations

from collections.abc import Awaitable, Callable

from app.gateway.speech.runtime.pipeline import Pipeline
from app.gateway.speech.runtime.processors.pipecat_voice_bridge import PipecatVoiceBridge

TurnHandler = Callable[[str], Awaitable[None]]


def build_xiaomi_voice_pipeline(
    *,
    asr_provider: str = "volcengine",
    tts_provider: str = "volcengine",
    speaker: str | None = None,
    on_user_turn: TurnHandler | None = None,
    silence_ms: float = 900.0,
    auto_ack: bool = True,
) -> tuple[Pipeline, PipecatVoiceBridge, PipecatVoiceBridge, None]:
    """Return (pipeline, bridge, asr_flush_target, vad).

    ``bridge`` and the ASR flush handle are the same ``PipecatVoiceBridge``.
    ``vad`` is ``None`` — Silero VAD lives inside the Pipecat mini-pipeline.
    """
    voice = PipecatVoiceBridge(
        asr_provider=asr_provider,
        tts_provider=tts_provider,
        speaker=speaker,
        on_user_turn=on_user_turn,
        silence_ms=silence_ms,
        auto_ack=auto_ack,
    )
    pipe = Pipeline([voice], name="XiaomiVoicePipeline")
    return pipe, voice, voice, None
