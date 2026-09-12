"""
Whisper local ASR fallback — lifecycle manager.

Manages the ``whisper_server`` process:
- Starts on gateway startup if binary exists
- Auto-downloads model on first run (Whisper does this internally)
- Health-checks the WebSocket
- Provides asr_transcribe_local() fallback for speech router

The binary is at ``tools/whisper/whisper_server.exe`` (Windows) or
``tools/whisper/whisper_server`` (macOS/Linux), bundled by build-whisper.*.
If missing, the module logs a note and local ASR is unavailable — cloud ASR
remains the primary path.
"""

from __future__ import annotations

import asyncio
import logging
import os
import subprocess
import sys
import time
from pathlib import Path

logger = logging.getLogger(__name__)

WHISPER_PORT = 3723
WHISPER_HOST = "127.0.0.1"
WHISPER_WS_URL = f"ws://{WHISPER_HOST}:{WHISPER_PORT}"

_process: subprocess.Popen | None = None
_available: bool | None = None  # tri-state: None=unchecked, True/False
_startup_attempted: bool = False


def _binary_path() -> Path | None:
    """Locate the whisper_server binary bundled with the gateway."""
    # Gateway root (where evoflow-gateway.exe lives)
    base = Path(sys.executable).parent if getattr(sys, "frozen", False) else Path(__file__).resolve().parents[5]

    candidates = [
        base / "tools" / "whisper" / "whisper_server.exe",  # Windows
        base / "tools" / "whisper" / "whisper_server",      # macOS/Linux
        base / "whisper-dist" / "whisper_server.exe",
        base / "whisper-dist" / "whisper_server",
    ]
    for p in candidates:
        if p.exists():
            return p
    return None


def _is_running() -> bool:
    """Check if whisper_server WebSocket is accepting connections."""
    if _process is None:
        return False
    if _process.poll() is not None:
        return False

    import socket
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.settimeout(1)
        result = s.connect_ex((WHISPER_HOST, WHISPER_PORT))
        s.close()
        return result == 0
    except Exception:
        return False


def start_whisper(model: str = "small") -> bool:
    """Start the whisper_server process. Returns True if started successfully."""
    global _process, _available, _startup_attempted
    _startup_attempted = True

    binary = _binary_path()
    if binary is None:
        logger.info("[whisper] binary not found, local ASR unavailable")
        _available = False
        return False

    if _is_running():
        logger.info("[whisper] already running on port %s", WHISPER_PORT)
        _available = True
        return True

    try:
        logger.info("[whisper] starting %s --model %s --port %s", binary, model, WHISPER_PORT)
        _process = subprocess.Popen(
            [str(binary), "--model", model, "--port", str(WHISPER_PORT)],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        # Wait for server to be ready (model download may take time on first run)
        for _ in range(60):  # up to 60s for model download
            time.sleep(1)
            if _is_running():
                logger.info("[whisper] server ready on port %s", WHISPER_PORT)
                _available = True
                _start_stdout_reader()
                return True
            if _process.poll() is not None:
                stderr = _process.stderr.read() if _process.stderr else ""
                logger.warning("[whisper] process exited early: %s", stderr[:200])
                _available = False
                return False

        logger.warning("[whisper] startup timed out after 60s")
        _available = False
        return False

    except Exception as e:
        logger.warning("[whisper] failed to start: %s", e)
        _available = False
        return False


def _start_stdout_reader():
    """Background reader to drain stdout/stderr."""
    if _process is None:
        return

    def _reader(stream, label):
        try:
            for line in stream:
                line = line.strip()
                if line:
                    logger.debug("[whisper:%s] %s", label, line)
        except Exception:
            pass

    import threading
    if _process.stdout:
        threading.Thread(target=_reader, args=(_process.stdout, "out"), daemon=True).start()
    if _process.stderr:
        threading.Thread(target=_reader, args=(_process.stderr, "err"), daemon=True).start()


def stop_whisper():
    """Stop the whisper_server process."""
    global _process, _available
    if _process is not None:
        try:
            _process.terminate()
            _process.wait(timeout=5)
            logger.info("[whisper] stopped")
        except Exception:
            try:
                _process.kill()
            except Exception:
                pass
        _process = None
    _available = None


def is_available() -> bool:
    """Check if local ASR is available (lazy-init, cached)."""
    global _available

    if _available is not None:
        return _available

    if not _startup_attempted:
        start_whisper()

    return bool(_available)


async def transcribe_local(pcm_bytes: bytes, lang: str = "zh") -> str:
    """Transcribe audio using local Whisper. Returns empty string on failure."""
    if not is_available():
        return ""

    try:
        import websockets
        async with websockets.connect(WHISPER_WS_URL) as ws:
            await ws.send(json.dumps({"type": "config", "lang": lang}))
            await ws.send(pcm_bytes)
            await ws.send(json.dumps({"type": "flush"}))
            # Wait for transcription result
            async for msg in ws:
                data = json.loads(msg)
                if data.get("type") == "transcript" and data.get("is_final"):
                    return str(data.get("text", "")).strip()
    except Exception as e:
        logger.debug("[whisper] transcribe failed: %s", e)
        return ""

    return ""


# Auto-start on module import (best-effort, non-blocking)
def _auto_start():
    if _binary_path() and not _startup_attempted:
        logger.info("[whisper] auto-starting local ASR fallback...")
        start_whisper()


import json as _json  # noqa: E402 (needed in transcribe_local above)
import threading as _threading

_auto_thread = _threading.Thread(target=_auto_start, daemon=True)
_auto_thread.start()
