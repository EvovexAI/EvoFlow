"""Run scenario handlers in a child process so Gateway's production DB is untouched."""

from __future__ import annotations

import json
import logging
import os
import subprocess
import sys
import tempfile
import time
from typing import Any

logger = logging.getLogger(__name__)


def run_handler_subprocess(handler: str, *, timeout_s: int = 180) -> dict[str, Any]:
    """Execute ``HANDLER_MAP[handler]`` in an isolated Python subprocess.

    Result is written to a temp file (not stdout) so import/log noise on Windows
    cannot break JSON parsing.
    """
    t0 = int(time.time() * 1000)
    harness_root = os.path.abspath(
        os.path.join(os.path.dirname(__file__), "..", "..", "..")
    )
    env = os.environ.copy()
    pp = env.get("PYTHONPATH", "")
    parts = [harness_root]
    if pp:
        parts.append(pp)
    env["PYTHONPATH"] = os.pathsep.join(parts)
    env["PYTHONUNBUFFERED"] = "1"
    # Keep child from inheriting parent eval isolation / inline flags incorrectly
    env.pop("EVOFLOW_EVAL_INLINE", None)
    # L3 live handlers talk to the running Gateway over HTTP. Auto-enable when
    # the UI kicks them off, so users need not pre-set EVOFLOW_EVAL_LIVE_LLM on
    # the Gateway process (still overridable via env).
    live_handlers = (
        "eval.scenario.employee_task_live_wake",
        "eval.scenario.workflow_task_live_run",
    )
    if handler in live_handlers:
        env.setdefault("EVOFLOW_EVAL_LIVE_LLM", "1")
        env.setdefault("EVOFLOW_EVAL_GATEWAY_URL", "http://127.0.0.1:8070")
        # Live wake / workflow can exceed the default 180s budget.
        timeout_s = max(int(timeout_s or 180), 360)
    # cwd is harness_root (no config.yaml); point at repo config for tool catalog.
    if not (env.get("EVOFLOW_CONFIG_PATH") or "").strip():
        try:
            from evoflow.eval.scenarios._harness import resolve_eval_config_yaml

            cfg = resolve_eval_config_yaml()
            if cfg is not None:
                env["EVOFLOW_CONFIG_PATH"] = str(cfg)
        except Exception:  # noqa: BLE001
            repo_cfg = os.path.abspath(
                os.path.join(harness_root, "..", "..", "..", "config.yaml")
            )
            if os.path.isfile(repo_cfg):
                env["EVOFLOW_CONFIG_PATH"] = repo_cfg

    fd, result_path = tempfile.mkstemp(prefix="evoflow_eval_", suffix=".json")
    os.close(fd)
    try:
        script = (
            "import json,os,sys,traceback\n"
            "from evoflow.eval.scenarios import HANDLER_MAP\n"
            f"h={handler!r}\n"
            f"out_path={result_path!r}\n"
            "def _write(obj, code=0):\n"
            "    with open(out_path, 'w', encoding='utf-8') as f:\n"
            "        json.dump(obj, f, ensure_ascii=False, default=str)\n"
            "    sys.exit(code)\n"
            "try:\n"
            "    if h not in HANDLER_MAP:\n"
            "        _write({'ok':False,'status':'error','score':0,"
            "'detail':f'unknown {h}','assertions':[],'metrics':{}}, 2)\n"
            "    r = HANDLER_MAP[h]()\n"
            "    if not isinstance(r, dict):\n"
            "        _write({'ok':False,'status':'error','score':0,"
            "'detail':'non-object result','assertions':[],'metrics':{}}, 3)\n"
            "    _write(r, 0)\n"
            "except SystemExit:\n"
            "    raise\n"
            "except Exception as exc:\n"
            "    _write({'ok':False,'status':'error','score':0,"
            "'detail':f'{type(exc).__name__}: {exc}',"
            "'assertions':[],'metrics':{'traceback':traceback.format_exc()[-1200:]}}, 1)\n"
        )
        try:
            proc = subprocess.run(
                [sys.executable, "-c", script],
                capture_output=True,
                text=True,
                timeout=timeout_s,
                env=env,
                cwd=harness_root,
            )
        except subprocess.TimeoutExpired:
            return {
                "ok": False,
                "status": "error",
                "score": 0,
                "detail": f"scenario subprocess timeout after {timeout_s}s",
                "assertions": [],
                "metrics": {},
                "duration_ms": int(time.time() * 1000) - t0,
            }
        except Exception as exc:  # noqa: BLE001
            return {
                "ok": False,
                "status": "error",
                "score": 0,
                "detail": f"subprocess spawn failed: {exc}",
                "assertions": [],
                "metrics": {},
                "duration_ms": int(time.time() * 1000) - t0,
            }

        if not os.path.isfile(result_path) or os.path.getsize(result_path) == 0:
            err = ((proc.stderr or "") + "\n" + (proc.stdout or ""))[-800:]
            return {
                "ok": False,
                "status": "error",
                "score": 0,
                "detail": f"empty subprocess result (code={proc.returncode}): {err}",
                "assertions": [],
                "metrics": {},
                "duration_ms": int(time.time() * 1000) - t0,
            }
        try:
            with open(result_path, encoding="utf-8") as f:
                result = json.load(f)
        except json.JSONDecodeError as exc:
            raw = ""
            try:
                with open(result_path, encoding="utf-8", errors="replace") as f:
                    raw = f.read()[-500:]
            except OSError:
                pass
            return {
                "ok": False,
                "status": "error",
                "score": 0,
                "detail": f"invalid json from subprocess: {exc}; {raw}",
                "assertions": [],
                "metrics": {},
                "duration_ms": int(time.time() * 1000) - t0,
            }
        if not isinstance(result, dict):
            return {
                "ok": False,
                "status": "error",
                "score": 0,
                "detail": "subprocess returned non-object",
                "assertions": [],
                "metrics": {},
                "duration_ms": int(time.time() * 1000) - t0,
            }
        result.setdefault("duration_ms", int(time.time() * 1000) - t0)
        if proc.stderr:
            logger.debug(
                "scenario subprocess stderr handler=%s: %s",
                handler,
                proc.stderr[-400:],
            )
        return result
    finally:
        try:
            os.unlink(result_path)
        except OSError:
            pass
