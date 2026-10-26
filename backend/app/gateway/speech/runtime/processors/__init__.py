"""Pipeline stations for Xiaomi voice."""

from app.gateway.speech.runtime.processors.asr import AsrProcessor
from app.gateway.speech.runtime.processors.energy_vad import EnergyVadProcessor
from app.gateway.speech.runtime.processors.tts import TtsProcessor
from app.gateway.speech.runtime.processors.xiaomi_bridge import XiaomiBridgeProcessor

# pipecat-ai is omitted on macOS Intel (onnxruntime wheel gap); keep package importable.
try:
    from app.gateway.speech.runtime.processors.pipecat_tts_bridge import PipecatTtsBridge
    from app.gateway.speech.runtime.processors.pipecat_voice_bridge import PipecatVoiceBridge
except ImportError:  # pragma: no cover - platform without pipecat wheels
    PipecatTtsBridge = None  # type: ignore[misc, assignment]
    PipecatVoiceBridge = None  # type: ignore[misc, assignment]

__all__ = [
    "AsrProcessor",
    "EnergyVadProcessor",
    "PipecatTtsBridge",
    "PipecatVoiceBridge",
    "TtsProcessor",
    "XiaomiBridgeProcessor",
]
