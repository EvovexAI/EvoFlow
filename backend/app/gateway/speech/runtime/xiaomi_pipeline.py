"""Build the standard Xiaomi voice Frame pipeline."""

from __future__ import annotations

from collections.abc import Awaitable, Callable

from app.gateway.speech.runtime.aggregators import SentenceAggregator, UserTurnAggregator
from app.gateway.speech.runtime.pipeline import Pipeline
from app.gateway.speech.runtime.processors.asr import AsrProcessor
from app.gateway.speech.runtime.processors.energy_vad import EnergyVadProcessor
from app.gateway.speech.runtime.processors.tts import TtsProcessor
from app.gateway.speech.runtime.processors.xiaomi_bridge import XiaomiBridgeProcessor

TurnHandler = Callable[[str], Awaitable[None]]


def build_xiaomi_voice_pipeline(
    *,
    asr_provider: str = "volcengine",
    tts_provider: str = "volcengine",
    speaker: str | None = None,
    on_user_turn: TurnHandler | None = None,
    silence_ms: float = 900.0,
    auto_ack: bool = True,
) -> tuple[Pipeline, XiaomiBridgeProcessor, AsrProcessor, EnergyVadProcessor]:
    vad = EnergyVadProcessor()
    asr = AsrProcessor(provider=asr_provider)
    turn = UserTurnAggregator(silence_ms=silence_ms, final_grace_ms=400.0)
    bridge = XiaomiBridgeProcessor(on_user_turn=on_user_turn, auto_ack=auto_ack)
    sentence = SentenceAggregator()
    tts = TtsProcessor(provider=tts_provider, speaker=speaker)
    pipe = Pipeline([vad, asr, turn, bridge, sentence, tts], name="XiaomiVoicePipeline")
    return pipe, bridge, asr, vad
