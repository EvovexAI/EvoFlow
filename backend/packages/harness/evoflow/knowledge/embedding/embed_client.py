"""Parent-process client for :mod:`embed_worker` (Windows Gateway local embed)."""

from __future__ import annotations

import json
import logging
import os
import subprocess
import sys
import threading
from typing import Any

logger = logging.getLogger(__name__)

_lock = threading.Lock()
_proc: subprocess.Popen[bytes] | None = None


def _spawn() -> subprocess.Popen[bytes]:
    from evoflow.utils.subprocess_platform import subprocess_hide_window_kwargs

    cmd = [sys.executable, "-m", "evoflow.knowledge.embedding.embed_worker"]
    env = os.environ.copy()
    env["EVOFLOW_LOCAL_EMBED_WORKER"] = "1"
    env["EVOFLOW_CODE_INDEX_BUILD_WORKER"] = "1"
    proc = subprocess.Popen(
        cmd,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=env,
        **subprocess_hide_window_kwargs(),
    )
    logger.info("local embed worker started pid=%s", proc.pid)
    return proc


def _alive(proc: subprocess.Popen[bytes] | None) -> bool:
    return proc is not None and proc.poll() is None


def _ensure_proc_locked() -> subprocess.Popen[bytes]:
    global _proc
    if _alive(_proc):
        assert _proc is not None
        return _proc
    if _proc is not None:
        try:
            _proc.kill()
        except Exception:
            pass
        _proc = None
    _proc = _spawn()
    return _proc


def shutdown_embed_worker() -> None:
    global _proc
    with _lock:
        proc = _proc
        _proc = None
    if proc is None:
        return
    try:
        if proc.poll() is None and proc.stdin:
            proc.stdin.write(
                (json.dumps({"op": "shutdown"}, ensure_ascii=False) + "\n").encode("utf-8")
            )
            proc.stdin.flush()
            proc.wait(timeout=5)
    except Exception:
        try:
            proc.kill()
        except Exception:
            pass


def embed_texts_via_worker(
    texts: list[str],
    *,
    model_id: str,
    device: str = "cpu",
    timeout_s: float = 120.0,
) -> list[list[float]]:
    """Embed ``texts`` in the sidecar worker. Thread-safe."""
    del timeout_s  # reserved; readline blocks until worker responds
    if not texts:
        return []
    req = {
        "op": "embed",
        "model": model_id,
        "device": device,
        "texts": [str(t) for t in texts],
    }
    line = (json.dumps(req, ensure_ascii=False) + "\n").encode("utf-8")
    with _lock:
        proc = _ensure_proc_locked()
        assert proc.stdin is not None and proc.stdout is not None
        try:
            proc.stdin.write(line)
            proc.stdin.flush()
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass
            globals_proc = _spawn()
            # rebind module global
            global _proc
            _proc = globals_proc
            proc = globals_proc
            assert proc.stdin is not None and proc.stdout is not None
            proc.stdin.write(line)
            proc.stdin.flush()

        raw = proc.stdout.readline()
        if not raw:
            raise RuntimeError("local embed worker closed stdout")
    try:
        payload: dict[str, Any] = json.loads(raw.decode("utf-8"))
    except Exception as exc:
        raise RuntimeError(f"local embed worker bad response: {exc}") from exc
    if not payload.get("ok"):
        raise RuntimeError(str(payload.get("error") or "embed worker failed"))
    vectors = payload.get("vectors")
    if not isinstance(vectors, list) or len(vectors) != len(texts):
        raise RuntimeError("local embed worker returned wrong vector count")
    return [list(map(float, row)) for row in vectors]
