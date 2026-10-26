"""Frame types for the Xiaomi voice pipeline.

Priority: system frames (interruptions, speaking state) outrank data/control so
barge-in can jump ahead of queued audio/text — the same idea as Pipecat.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import IntEnum
from time import monotonic
from typing import Any


class FramePriority(IntEnum):
    DATA = 10
    CONTROL = 20
    SYSTEM = 30
    START = 40


@dataclass(slots=True)
class Frame:
    """Base unit flowing through the pipeline."""

    interruptible: bool = True
    created_at: float = field(default_factory=monotonic)
    meta: dict[str, Any] = field(default_factory=dict)

    @property
    def priority(self) -> FramePriority:
        return FramePriority.DATA


@dataclass(slots=True)
class SystemFrame(Frame):
    interruptible: bool = False

    @property
    def priority(self) -> FramePriority:
        return FramePriority.SYSTEM


@dataclass(slots=True)
class ControlFrame(Frame):
    interruptible: bool = True

    @property
    def priority(self) -> FramePriority:
        return FramePriority.CONTROL


@dataclass(slots=True)
class StartFrame(SystemFrame):
    sample_rate: int = 16000
    tts_provider: str = "volcengine"
    asr_provider: str = "volcengine"
    speaker: str | None = None

    @property
    def priority(self) -> FramePriority:
        return FramePriority.START


@dataclass(slots=True)
class EndFrame(SystemFrame):
    interruptible: bool = False


@dataclass(slots=True)
class CancelFrame(SystemFrame):
    interruptible: bool = False


@dataclass(slots=True)
class InterruptionFrame(SystemFrame):
    reason: str = "barge_in"


@dataclass(slots=True)
class UserStartedSpeakingFrame(SystemFrame):
    pass


@dataclass(slots=True)
class UserStoppedSpeakingFrame(SystemFrame):
    pass


@dataclass(slots=True)
class BotStartedSpeakingFrame(SystemFrame):
    seq: int = 0
    text: str = ""


@dataclass(slots=True)
class BotStoppedSpeakingFrame(SystemFrame):
    seq: int = 0
    text: str = ""


@dataclass(slots=True)
class AudioRawFrame(Frame):
    audio: bytes = b""
    sample_rate: int = 16000
    num_channels: int = 1


@dataclass(slots=True)
class TranscriptionFrame(Frame):
    text: str = ""
    is_final: bool = False
    seg: str | None = None


@dataclass(slots=True)
class UserTurnCompleteFrame(ControlFrame):
    text: str = ""


@dataclass(slots=True)
class LLMTextFrame(Frame):
    text: str = ""
    turn: int = 0


@dataclass(slots=True)
class LLMResponseEndFrame(ControlFrame):
    """Marks end of one assistant reply stream (flush residual sentence)."""

    turn: int = 0


@dataclass(slots=True)
class TTSSpeakFrame(ControlFrame):
    """Imperative speak (ack / status) that bypasses LLM aggregation."""

    text: str = ""
    seq: int | None = None
    turn: int = 0


@dataclass(slots=True)
class TTSAudioRawFrame(Frame):
    audio: bytes = b""
    seq: int = 0
    sample_rate: int = 24000
    format: str = "mp3"


@dataclass(slots=True)
class TTSRequestFrame(ControlFrame):
    """One sentence ready for TTS synthesis."""

    text: str = ""
    seq: int = 0
    turn: int = 0
