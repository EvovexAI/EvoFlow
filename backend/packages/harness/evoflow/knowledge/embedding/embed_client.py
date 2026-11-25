"""Parent-process client for :mod:`embed_worker` (Windows Gateway local embed)."""

from __future__ import annotations

import json
import logging
import os
import subprocess
import threading
from typing import Any

logger = logging.getLogger(__name__)

_lock = threading.Lock()
_proc: subprocess.Popen[bytes] | None = None


def _spawn() -> subprocess.Popen[bytes]:
    from evoflow.utils.frozen_modules import python_module_argv
    from evoflow.utils.subprocess_platform import subprocess_hide_window_kwargs

    # 【self-evolution-bot · 2026-11-24 · 模型:deepseek-v4.1-flash】
    # 与 code_index 的 build_worker 同一个缺陷、同一个修法：冻结后 sys.executable 是
    # evoflow-gateway.exe，`-m evoflow.knowledge.embedding.embed_worker` 会被 gateway
    # argparse 拒绝 → embed worker 静默起不来 → 本地向量全部降级。
    cmd = python_module_argv("evoflow.knowledge.embedding.embed_worker")
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


def _kill_worker_for_timeout(proc: subprocess.Popen[bytes] | None) -> None:
    """超时看门狗回调：杀掉无响应的 worker，让阻塞的 readline 立即返回 EOF。"""
    if proc is None:
        return
    logger.warning(
        "[embed-client] worker timeout: killing pid=%s (readline 超时保护)",
        proc.pid,
    )
    try:
        proc.kill()
    except Exception:
        logger.debug("[embed-client] watchdog kill failed", exc_info=True)


def embed_texts_via_worker(
    texts: list[str],
    *,
    model_id: str,
    device: str = "cpu",
    timeout_s: float = 120.0,
) -> list[list[float]]:
    """Embed ``texts`` in the sidecar worker. Thread-safe.

    【2026-11-21 修复】原实现 ``del timeout_s`` 后直接 ``readline()``——worker 卡住
    （torch 冷 import / 模型缺失 / 崩溃前挂起）时**无限阻塞**调用线程，code_index
    的批量预算 + 二分重试会把整测套件/网关线程拖死（全量 pytest 22% 实锤）。
    现在用 kill 看门狗实现真正的超时：超时杀 worker → readline 返回 EOF → 抛
    RuntimeError → 调用方既有恢复路径（kill + 重spawn / 降级词法）接手，**有界**。
    """
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

        # kill 看门狗：超时杀 worker → readline 立即返回 EOF（有界），而不是永久阻塞。
        effective_timeout = max(1.0, float(timeout_s or 0))
        watchdog: threading.Timer | None = None
        if timeout_s and timeout_s > 0:
            watchdog = threading.Timer(
                effective_timeout,
                _kill_worker_for_timeout,
                args=(proc,),
            )
            watchdog.daemon = True
            watchdog.start()
        try:
            raw = proc.stdout.readline()
            if not raw:
                raise RuntimeError(
                    f"local embed worker closed stdout (timeout_s={effective_timeout}s 或 worker 退出)"
                )
        finally:
            if watchdog is not None:
                watchdog.cancel()
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
