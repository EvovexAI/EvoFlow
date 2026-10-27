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

_PIPECAT_ONNX_MISSING = (
    "Realtime Xiaomi voice is missing Silero/SmartTurn ONNX models inside the "
    "packaged gateway (silero_vad.onnx). Rebuild the desktop sidecar so "
    "PyInstaller collects pipecat **/*.onnx data files."
)


def _assert_pipecat_vad_assets() -> None:
    """Fail early with a clear message when packaged installs omit *.onnx datas."""
    try:
        try:
            from importlib import resources as importlib_resources
        except ImportError:  # pragma: no cover
            import importlib_resources  # type: ignore

        root = importlib_resources.files("pipecat.audio.vad.data")
        model = root.joinpath("silero_vad.onnx")
        ok = False
        try:
            ok = model.is_file()  # type: ignore[attr-defined]
        except Exception:
            ok = False
        if not ok:
            # Traversable may need as_file() on older layouts
            with importlib_resources.as_file(model) as path:
                ok = path.is_file()
        if not ok:
            raise RuntimeError(_PIPECAT_ONNX_MISSING)
    except RuntimeError:
        raise
    except Exception as e:
        raise RuntimeError(_PIPECAT_ONNX_MISSING) from e


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

    _assert_pipecat_vad_assets()

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
