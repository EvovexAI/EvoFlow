"""Live Gateway HTTP helpers for L3 eval (real LLM, same routes as EvoPanel).

Gated by ``EVOFLOW_EVAL_LIVE_LLM=1``. Does not inject outcomes.
"""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any, Callable


DEFAULT_GATEWAY_URL = "http://127.0.0.1:8012"
LIVE_ENV = "EVOFLOW_EVAL_LIVE_LLM"
URL_ENV = "EVOFLOW_EVAL_GATEWAY_URL"
TOKEN_ENV = "EVOFLOW_EVAL_TOKEN"


@dataclass
class LiveGate:
    ok: bool
    reason: str = ""
    base_url: str = ""
    primary_model: str = ""


def gateway_base_url() -> str:
    raw = (os.environ.get(URL_ENV) or "").strip() or DEFAULT_GATEWAY_URL
    return raw.rstrip("/")


def live_llm_enabled() -> bool:
    return (os.environ.get(LIVE_ENV) or "").strip().lower() in ("1", "true", "yes")


def employee_timeout_s() -> float:
    try:
        return float(os.environ.get("EVOFLOW_EVAL_LIVE_EMPLOYEE_TIMEOUT_S") or 180)
    except ValueError:
        return 180.0


def workflow_timeout_s() -> float:
    try:
        return float(os.environ.get("EVOFLOW_EVAL_LIVE_WORKFLOW_TIMEOUT_S") or 300)
    except ValueError:
        return 300.0


def _headers() -> dict[str, str]:
    h = {"Accept": "application/json", "Content-Type": "application/json"}
    token = (os.environ.get(TOKEN_ENV) or "").strip()
    if token:
        h["Authorization"] = f"Bearer {token}"
    return h


class GatewayHttpError(RuntimeError):
    def __init__(self, method: str, path: str, status: int, body: str):
        self.method = method
        self.path = path
        self.status = status
        self.body = body
        super().__init__(f"{method} {path} -> {status}: {body[:400]}")


def http_json(
    method: str,
    path: str,
    body: dict[str, Any] | list[Any] | None = None,
    *,
    timeout_s: float = 60.0,
    base_url: str | None = None,
) -> Any:
    """Call Gateway HTTP API; ``path`` starts with ``/api/...`` or ``/health``."""
    base = (base_url or gateway_base_url()).rstrip("/")
    if not path.startswith("/"):
        path = "/" + path
    url = base + path
    data = None
    headers = _headers()
    if body is not None:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers=headers, method=method.upper())
    try:
        with urllib.request.urlopen(req, timeout=timeout_s) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            if not raw.strip():
                return {}
            return json.loads(raw)
    except urllib.error.HTTPError as exc:
        err_body = exc.read().decode("utf-8", errors="replace") if exc.fp else ""
        raise GatewayHttpError(method.upper(), path, int(exc.code), err_body) from exc
    except urllib.error.URLError as exc:
        raise GatewayHttpError(method.upper(), path, 0, str(exc.reason)) from exc


def require_live_llm() -> LiveGate:
    """Gate L3: env + health + primary model available."""
    base = gateway_base_url()
    if not live_llm_enabled():
        return LiveGate(
            ok=False,
            reason=f"set {LIVE_ENV}=1 to run live LLM scenarios against Gateway",
            base_url=base,
        )
    try:
        health = http_json("GET", "/health", timeout_s=8.0, base_url=base)
    except Exception as exc:  # noqa: BLE001
        return LiveGate(
            ok=False,
            reason=f"Gateway health failed at {base}: {exc}",
            base_url=base,
        )
    status = str((health or {}).get("status") or "").lower()
    if status not in ("healthy", "ok", "alive"):
        return LiveGate(
            ok=False,
            reason=f"Gateway unhealthy: {health!r}",
            base_url=base,
        )
    primary = ""
    try:
        models = http_json("GET", "/api/models/primary", timeout_s=15.0, base_url=base)
        if isinstance(models, dict):
            primary = str(models.get("primary_model") or "").strip()
    except Exception:
        try:
            listed = http_json("GET", "/api/models", timeout_s=15.0, base_url=base)
            if isinstance(listed, dict):
                arr = listed.get("models") or listed.get("items") or []
                if isinstance(arr, list) and arr:
                    first = arr[0]
                    if isinstance(first, dict):
                        primary = str(first.get("name") or first.get("id") or "").strip()
                    else:
                        primary = str(first).strip()
        except Exception as exc:  # noqa: BLE001
            return LiveGate(
                ok=False,
                reason=f"no usable model from Gateway: {exc}",
                base_url=base,
            )
    if not primary:
        return LiveGate(
            ok=False,
            reason="Gateway has no primary/configured chat model",
            base_url=base,
        )
    return LiveGate(ok=True, reason="", base_url=base, primary_model=primary)


def skipped_live_result(reason: str, *, base_url: str = "") -> dict[str, Any]:
    return {
        "ok": True,
        "status": "skipped",
        "score": 0.0,
        "detail": f"skipped live LLM: {reason}",
        "assertions": [],
        "metrics": {
            "eval_scope": "live_llm",
            "runner": "gateway_http",
            "skip_reason": reason,
            "gateway_url": base_url or gateway_base_url(),
        },
        "steps": [],
        "provenance": {
            "mock": False,
            "runner": "gateway_http",
            "eval_scope": "live_llm",
            "skipped": True,
        },
    }


def poll_until(
    predicate: Callable[[], tuple[bool, dict[str, Any]]],
    *,
    timeout_s: float,
    interval_s: float = 2.0,
) -> dict[str, Any]:
    """Poll until predicate returns (True, evidence) or timeout.

    Returns ``{"ok": bool, "timed_out": bool, "elapsed_s": float, "evidence": dict}``.
    """
    t0 = time.monotonic()
    last: dict[str, Any] = {}
    while True:
        done, evidence = predicate()
        last = dict(evidence or {})
        elapsed = time.monotonic() - t0
        if done:
            return {"ok": True, "timed_out": False, "elapsed_s": elapsed, "evidence": last}
        if elapsed >= timeout_s:
            return {"ok": False, "timed_out": True, "elapsed_s": elapsed, "evidence": last}
        time.sleep(max(0.2, interval_s))


def live_metrics(
    *,
    gate: LiveGate,
    task_id: str | None = None,
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    out: dict[str, Any] = {
        "eval_scope": "live_llm",
        "runner": "gateway_http",
        "gateway_url": gate.base_url,
        "primary_model": gate.primary_model,
    }
    if task_id:
        out["task_id"] = task_id
    if extra:
        out.update(extra)
    return out


def qs(path: str, **params: Any) -> str:
    clean = {k: v for k, v in params.items() if v is not None}
    if not clean:
        return path
    return path + "?" + urllib.parse.urlencode(clean)


__all__ = [
    "DEFAULT_GATEWAY_URL",
    "GatewayHttpError",
    "LiveGate",
    "employee_timeout_s",
    "gateway_base_url",
    "http_json",
    "live_llm_enabled",
    "live_metrics",
    "poll_until",
    "qs",
    "require_live_llm",
    "skipped_live_result",
    "workflow_timeout_s",
]
