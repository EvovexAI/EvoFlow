"""Build the Xiaomi voice pipeline — full Pipecat VAD/STT/Turn/TTS."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import TYPE_CHECKING, Any

from app.gateway.speech.runtime.pipeline import Pipeline

if TYPE_CHECKING:
    from app.gateway.speech.runtime.processors.pipecat_voice_bridge import PipecatVoiceBridge

TurnHandler = Callable[[str], Awaitable[None]]

_PIPECAT_UNAVAILABLE = (
    "Realtime Xiaomi voice requires pipecat-ai + onnxruntime>=1.24. "
    "On macOS Intel (x86_64) those wheels are unavailable — use Apple Silicon, "
    "Windows, or Linux. On Windows/Linux packaged installs, also ensure "
    "PyInstaller copies pipecat-ai package metadata (copy_metadata)."
)

_PIPECAT_METADATA_MISSING = (
    "Realtime Xiaomi voice: pipecat code is present but pipecat-ai package "
    "metadata is missing (importlib.metadata PackageNotFoundError). "
    "Rebuild the desktop gateway with copy_metadata('pipecat-ai') in gateway.spec."
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
    except Exception as e:
        # PyInstaller 常漏打 *.dist-info：pipecat/__init__ 调 version("pipecat-ai") 直接炸
        name = type(e).__name__
        msg = str(e) or name
        if name == "PackageNotFoundError" or "pipecat-ai" in msg:
            raise RuntimeError(_PIPECAT_METADATA_MISSING) from e
        raise RuntimeError(f"{_PIPECAT_UNAVAILABLE} ({name}: {msg})") from e

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
