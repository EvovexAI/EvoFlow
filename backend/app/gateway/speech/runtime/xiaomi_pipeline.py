"""Build the Xiaomi voice pipeline — full Pipecat VAD/STT/Turn/TTS."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import TYPE_CHECKING, Any

from app.gateway.speech.runtime.pipeline import Pipeline

if TYPE_CHECKING:
    from app.gateway.speech.runtime.processors.pipecat_voice_bridge import PipecatVoiceBridge

TurnHandler = Callable[[str], Awaitable[None]]

_PIPECAT_UNAVAILABLE = (
    "Realtime Xiaomi voice requires pipecat-ai + onnxruntime>=1.24, which have "
    "no wheels on macOS Intel (x86_64). Use Apple Silicon, Windows, or Linux."
)


def build_xiaomi_voice_pipeline(
    *,
    asr_provider: str = "volcengine",
    tts_provider: str = "volcengine",
    speaker: str | None = None,
    on_user_turn: TurnHandler | None = None,
    silence_ms: float = 900.0,
    auto_ack: bool = True,
) -> tuple[Pipeline, Any, Any, None]:
    """Return (pipeline, bridge, asr_flush_target, vad).

    ``bridge`` and the ASR flush handle are the same ``PipecatVoiceBridge``.
    ``vad`` is ``None`` — Silero VAD lives inside the Pipecat mini-pipeline.
    """
    try:
        from app.gateway.speech.runtime.processors.pipecat_voice_bridge import (
            PipecatVoiceBridge,
        )
    except ImportError as e:
        raise RuntimeError(_PIPECAT_UNAVAILABLE) from e

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
