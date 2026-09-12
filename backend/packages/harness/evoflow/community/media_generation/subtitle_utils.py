from __future__ import annotations

import re
import shutil
import subprocess
from pathlib import Path


def audio_duration_seconds(path: Path) -> float:
    """Best-effort duration from mp3/wav/mp4 (ffprobe) file."""
    if shutil.which("ffprobe"):
        try:
            proc = subprocess.run(
                [
                    "ffprobe",
                    "-v",
                    "error",
                    "-show_entries",
                    "format=duration",
                    "-of",
                    "default=noprint_wrappers=1:nokey=1",
                    str(path),
                ],
                capture_output=True,
                text=True,
                timeout=30,
                check=False,
            )
            if proc.returncode == 0 and proc.stdout.strip():
                return float(proc.stdout.strip())
        except Exception:
            pass
    suffix = path.suffix.lower()
    if suffix == ".wav":
        return _wav_duration(path)
    try:
        from mutagen.mp3 import MP3  # type: ignore[import-untyped]

        return float(MP3(path).info.length)
    except Exception:
        pass
    try:
        import wave

        with wave.open(str(path), "rb") as w:
            return w.getnframes() / float(w.getframerate())
    except Exception:
        return 0.0


def _wav_duration(path: Path) -> float:
    import wave

    with wave.open(str(path), "rb") as w:
        return w.getnframes() / float(w.getframerate())


def split_sentences(text: str) -> list[str]:
    parts = re.split(r"(?<=[。！？.!?])\s*", text.strip())
    return [p.strip() for p in parts if p.strip()]


def _format_srt_time(seconds: float) -> str:
    ms = int(seconds * 1000)
    h, rem = divmod(ms, 3600_000)
    m, rem = divmod(rem, 60_000)
    s, ms = divmod(rem, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def build_srt_from_text(text: str, total_duration: float) -> str:
    """Evenly distribute sentences across total_duration (fallback)."""
    sentences = split_sentences(text)
    if not sentences:
        sentences = [text.strip() or "."]
    if total_duration <= 0:
        total_duration = max(3.0, len(sentences) * 2.0)
    per = total_duration / len(sentences)
    lines: list[str] = []
    t = 0.0
    for i, sent in enumerate(sentences, 1):
        start = t
        end = min(total_duration, t + per)
        lines.append(str(i))
        lines.append(f"{_format_srt_time(start)} --> {_format_srt_time(end)}")
        lines.append(sent)
        lines.append("")
        t = end
    return "\n".join(lines).strip() + "\n"


def build_vtt_from_srt(srt: str) -> str:
    body = srt.strip().replace(",", ".")
    return "WEBVTT\n\n" + body + "\n"


def whisper_transcribe_srt(audio_path: Path, *, locale: str = "zh") -> str | None:
    try:
        from faster_whisper import WhisperModel  # type: ignore[import-untyped]
    except ImportError:
        return None

    model_size = "small" if locale.startswith("zh") else "base"
    model = WhisperModel(model_size, device="cpu", compute_type="int8")
    segments, _ = model.transcribe(str(audio_path), language=locale[:2] if locale else None)
    lines: list[str] = []
    for i, seg in enumerate(segments, 1):
        lines.append(str(i))
        lines.append(f"{_format_srt_time(seg.start)} --> {_format_srt_time(seg.end)}")
        lines.append(seg.text.strip())
        lines.append("")
    return "\n".join(lines).strip() + "\n" if lines else None
