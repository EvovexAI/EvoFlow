"""HTTP client for EvoPanel main-window CDP (`/main-cdp/*`).

Reads the loopback port from ``~/.evoflow/browser-cdp-http-port`` (same bridge as
embed browser CDP). Optional auth: ``EVOFLOW_PANEL_CDP_TOKEN`` env or
``~/.evoflow/panel-cdp-token`` file → ``X-EvoFlow-Panel-Token`` header.
"""

from __future__ import annotations

import json
import logging
import os
import socket
import threading
from typing import Any

import httpx

logger = logging.getLogger(__name__)

_HTTP_TIMEOUT = float(os.getenv("EVOFLOW_PANEL_CDP_TIMEOUT", "60"))
_PORT_CACHE: dict[str, tuple[int, float]] = {}
_PORT_LOCK = threading.Lock()
_PORT_CACHE_TTL_SEC = 30.0


def _candidate_evoflow_dirs() -> list[str]:
    """Prefer a live bridge. Both ``~/.evoflow`` and ``~/.evoflow-dev`` may exist.

    Debug builds write under ``.evoflow-dev``; release under ``.evoflow``. If the
    leftover debug dir is preferred blindly, ``ui.panel`` misses the running
    release app (stale port file).
    """
    home = os.path.expanduser("~")
    release_dir = os.path.join(home, ".evoflow")
    debug_dir = os.path.join(home, ".evoflow-dev")
    out: list[str] = []
    for d in (release_dir, debug_dir):
        if os.path.isdir(d) and d not in out:
            out.append(d)
    return out


def _resolve_evoflow_dir() -> str:
    dirs = _candidate_evoflow_dirs()
    return dirs[0] if dirs else os.path.join(os.path.expanduser("~"), ".evoflow")


def _port_file_in(evo_dir: str) -> str:
    return os.path.join(evo_dir, "browser-cdp-http-port")


def _token_file() -> str:
    # Prefer token next to the live port when known; else first candidate dir.
    cached = _PORT_CACHE.get("dir")
    if isinstance(cached, str) and cached:
        return os.path.join(cached, "panel-cdp-token")
    return os.path.join(_resolve_evoflow_dir(), "panel-cdp-token")


def _probe_port(port: int, timeout: float = 0.4) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=timeout):
            return True
    except OSError:
        return False


def read_panel_cdp_http_port() -> int | None:
    """Read + TCP-probe the shared CDP HTTP bridge port (release or debug)."""
    with _PORT_LOCK:
        cached = _PORT_CACHE.get("port")
        if cached is not None:
            cached_port, _mtime = cached
            if _probe_port(cached_port):
                return cached_port
            _PORT_CACHE.pop("port", None)
            _PORT_CACHE.pop("dir", None)

    best: tuple[int, float, str] | None = None  # port, mtime, dir
    for evo_dir in _candidate_evoflow_dirs():
        path = _port_file_in(evo_dir)
        try:
            if not os.path.exists(path):
                continue
            with open(path, encoding="utf-8") as f:
                text = f.read().strip()
            port = int(text)
            if not _probe_port(port):
                continue
            try:
                mtime = os.path.getmtime(path)
            except OSError:
                mtime = 0.0
            if best is None or mtime >= best[1]:
                best = (port, mtime, evo_dir)
        except Exception:
            continue

    if best is None:
        return None
    port, mtime, evo_dir = best
    with _PORT_LOCK:
        existing = _PORT_CACHE.get("port")
        if existing is None or existing[1] <= mtime:
            _PORT_CACHE["port"] = (port, mtime)
            _PORT_CACHE["dir"] = evo_dir
    return port


def read_panel_cdp_token() -> str | None:
    env = (os.getenv("EVOFLOW_PANEL_CDP_TOKEN") or "").strip()
    if env:
        return env
    # Check token beside every candidate dir (live dir first after port resolve)
    dirs: list[str] = []
    cached_dir = _PORT_CACHE.get("dir")
    if isinstance(cached_dir, str) and cached_dir:
        dirs.append(cached_dir)
    for d in _candidate_evoflow_dirs():
        if d not in dirs:
            dirs.append(d)
    for evo_dir in dirs:
        path = os.path.join(evo_dir, "panel-cdp-token")
        try:
            if not os.path.exists(path):
                continue
            with open(path, encoding="utf-8") as f:
                tok = f.read().strip()
            if tok:
                return tok
        except Exception:
            continue
    return None


def _auth_headers() -> dict[str, str]:
    tok = read_panel_cdp_token()
    if not tok:
        return {}
    return {"X-EvoFlow-Panel-Token": tok}


def _unavailable(detail: str) -> dict[str, Any]:
    return {
        "ok": False,
        "error": detail,
        "code": "backend_unavailable",
        "hint": (
            "Start the EvoFlow desktop app and wait until it finishes booting. "
            "Port file: ~/.evoflow/browser-cdp-http-port (or ~/.evoflow-dev/…)."
        ),
    }


def panel_request(
    method: str,
    route: str,
    *,
    body: dict[str, Any] | None = None,
    timeout: float | None = None,
) -> dict[str, Any]:
    """Call ``/main-cdp/<route>`` and return the JSON envelope.

    Always returns a dict with at least ``ok`` (bool). Network / parse failures
    become ``ok=false`` envelopes — callers should not catch for control flow.
    """
    port = read_panel_cdp_http_port()
    if not port:
        return _unavailable(
            "Main-panel CDP bridge not running (port file missing or dead)."
        )

    route = str(route or "").strip().lstrip("/")
    if not route:
        return {"ok": False, "error": "missing route", "code": "execution_error"}

    url = f"http://127.0.0.1:{port}/main-cdp/{route}"
    headers = {"Content-Type": "application/json", **_auth_headers()}
    to = float(timeout if timeout is not None else _HTTP_TIMEOUT)
    method_u = str(method or "GET").strip().upper() or "GET"

    try:
        with httpx.Client(timeout=to) as client:
            if method_u == "GET":
                resp = client.get(url, headers=headers)
            else:
                payload = json.dumps(body or {}, ensure_ascii=False).encode("utf-8")
                resp = client.request(method_u, url, content=payload, headers=headers)
    except httpx.HTTPError as exc:
        logger.debug("panel_request HTTP error route=%s: %s", route, exc)
        return _unavailable(f"HTTP error talking to /main-cdp/{route}: {exc}")
    except Exception as exc:  # noqa: BLE001
        logger.debug("panel_request failed route=%s", route, exc_info=True)
        return _unavailable(f"panel CDP request failed: {exc}")

    if resp.status_code == 401:
        return {
            "ok": False,
            "error": "unauthorized (set EVOFLOW_PANEL_CDP_TOKEN or ~/.evoflow/panel-cdp-token)",
            "code": "unauthorized",
        }
    if resp.status_code != 200:
        text = (resp.text or "")[:400]
        return {
            "ok": False,
            "error": f"HTTP {resp.status_code}: {text}",
            "code": "execution_error",
        }

    try:
        data = resp.json()
    except Exception:
        return {
            "ok": False,
            "error": f"non-JSON response: {(resp.text or '')[:200]}",
            "code": "execution_error",
        }

    if not isinstance(data, dict):
        return {"ok": True, "result": data}
    if "ok" in data:
        return data
    return {"ok": True, "result": data}


def clear_panel_port_cache() -> None:
    """Test helper: drop cached port."""
    with _PORT_LOCK:
        _PORT_CACHE.clear()


def build_page_dump_evaluate_expr(
    *,
    max_turns: int = 30,
    max_chars_per_turn: int = 1200,
) -> str:
    """JS expression for ``POST /main-cdp/evaluate`` when ``page-dump`` is missing.

    Must keep ``\\n`` as two characters in the JS source — a real newline inside
    ``lines.join('...')`` makes ExecuteScript return null.
    """
    try:
        max_turns_i = int(max_turns)
    except (TypeError, ValueError):
        max_turns_i = 30
    try:
        max_chars_i = int(max_chars_per_turn)
    except (TypeError, ValueError):
        max_chars_i = 1200
    max_turns_i = max(1, max_turns_i)
    max_chars_i = max(80, max_chars_i)
    return (
        "(function(){var maxTurns=%d;var maxChars=%d;var turns=[];"
        "var nodes=[].slice.call(document.querySelectorAll('[data-turn-id]'));"
        "for(var i=0;i<nodes.length&&turns.length<maxTurns;i++){"
        "var el=nodes[i];var r=el.getBoundingClientRect();"
        "if(r.width<=0||r.height<=0)continue;"
        "if(r.bottom<=0||r.top>(window.innerHeight||0))continue;"
        "var text=String(el.innerText||'').trim();if(!text)continue;"
        "if(text.length>maxChars)text=text.slice(0,maxChars-1)+'...';"
        "turns.push({turnId:el.getAttribute('data-turn-id'),text:text,top:Math.round(r.top)});"
        "}"
        "var lines=[];for(var j=0;j<turns.length;j++){"
        "lines.push('--- turn '+(turns[j].turnId||'?')+' ---');lines.push(turns[j].text);}"
        "return {kind:'page_dump',fallback:true,"
        "selectedSessionKey:String(window.__evoflowSelectedSessionKey||'')||null,"
        "title:(window.__evoflowChatLayout&&window.__evoflowChatLayout.activeTitle)||document.title||'',"
        "turnCount:turns.length,turns:turns,transcript:lines.join('\\n')};})()"
    ) % (max_turns_i, max_chars_i)
