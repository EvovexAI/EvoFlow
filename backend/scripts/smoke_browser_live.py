#!/usr/bin/env python3
"""Live smoke: Gateway browser bridge + optional node_repl against a running desktop.

Usage (Gateway already up, e.g. isolated stack on :8070)::

    cd backend
    .venv\\Scripts\\python.exe scripts\\smoke_browser_live.py
    .venv\\Scripts\\python.exe scripts\\smoke_browser_live.py --base http://127.0.0.1:8070 --url https://www.baidu.com

Exit 0 = transport webview2 + navigate ok (+ node_repl open if --with-node-repl).
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path


def _candidate_tokens() -> list[Path]:
    home = Path.home()
    return [
        home / ".evoflow-dev" / "bridge-token",
        home / ".evoflow-dev" / "data" / "bridge-token",
        home / ".evoflow-dev" / "profiles" / "dev" / "bridge-token",
        home / ".evoflow" / "bridge-token",
        home / ".evoflow" / "profiles" / "default" / "bridge-token",
        home / ".evoflow" / "data" / "bridge-token",
    ]


def _load_token() -> str:
    env = (os.environ.get("EVOFLOW_BROWSER_BRIDGE_TOKEN") or "").strip()
    if env:
        return env
    for path in _candidate_tokens():
        try:
            if path.is_file():
                tok = path.read_text(encoding="utf-8").strip()
                if tok:
                    print(f"[smoke] token from {path}")
                    return tok
        except OSError:
            continue
    return ""


def _http_json(
    base: str,
    method: str,
    path: str,
    *,
    token: str = "",
    body: dict | None = None,
    timeout: float = 30.0,
) -> tuple[int, dict | str]:
    url = base.rstrip("/") + path
    data = None if body is None else json.dumps(body).encode("utf-8")
    headers = {"Accept": "application/json"}
    if token:
        headers["X-EvoFlow-Bridge-Token"] = token
    if data is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            try:
                return resp.status, json.loads(raw) if raw else {}
            except json.JSONDecodeError:
                return resp.status, raw
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        try:
            payload: dict | str = json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            payload = raw
        return int(exc.code), payload
    except urllib.error.URLError as exc:
        return 0, str(exc.reason if getattr(exc, "reason", None) else exc)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--base", default=os.environ.get("EVOFLOW_GATEWAY_URL", "http://127.0.0.1:8070"))
    ap.add_argument("--url", default="https://example.com/")
    ap.add_argument("--with-node-repl", action="store_true", help="Also run mcp__node_repl path via Python host")
    args = ap.parse_args()
    base = str(args.base).rstrip("/")
    print(f"[smoke] gateway={base}")

    code, live = _http_json(base, "GET", "/health/liveness", timeout=5)
    print(f"[smoke] liveness status={code} body={live!r}"[:240])
    if code != 200:
        print("[smoke] FAIL: Gateway not reachable")
        return 2

    token = _load_token()
    if not token:
        print("[smoke] FAIL: no bridge token (set EVOFLOW_BROWSER_BRIDGE_TOKEN or place bridge-token file)")
        return 3

    code, transport = _http_json(base, "GET", "/api/browser/transport", token=token, timeout=10)
    print(f"[smoke] transport status={code} body={transport!r}"[:300])
    if code != 200:
        print("[smoke] FAIL: /api/browser/transport (need matching bridge token + org local access)")
        return 4
    tr = (transport or {}).get("transport") if isinstance(transport, dict) else None
    if tr != "webview2":
        print(f"[smoke] FAIL: transport={tr!r} (need webview2; Edge fallback is rejected)")
        return 5

    nav = {"command": {"method": "navigate", "url": str(args.url)}}
    code, result = _http_json(base, "POST", "/api/browser/execute", token=token, body=nav, timeout=45)
    print(f"[smoke] navigate status={code} body={json.dumps(result, ensure_ascii=False)[:400]}")
    if code != 200 or not (isinstance(result, dict) and result.get("ok")):
        print("[smoke] FAIL: navigate via /api/browser/execute")
        print("        Tip: open the right-side browser panel in the desktop app first.")
        return 6
    print("[smoke] OK: Gateway navigate succeeded (panel should show the URL)")

    if not args.with_node_repl:
        return 0

    # Prefer the same home the isolated stack uses.
    os.environ.setdefault("EVOFLOW_CONFIG_DIR", str(Path.home() / ".evoflow-dev"))
    os.environ.setdefault("EVOFLOW_GATEWAY_URL", base)
    os.environ["EVOFLOW_BROWSER_BRIDGE_TOKEN"] = token
    # Plugin cache lives under EVOFLOW_HOME / data — isolated profile often uses
    # ~/.evoflow-dev as config + data root via EVOFLOW_HOME.
    if not os.environ.get("EVOFLOW_HOME"):
        os.environ["EVOFLOW_HOME"] = str(Path.home() / ".evoflow-dev")

    # Ensure ZCODE_PLUGIN_ROOT for auto-bootstrap when spawn reads env.
    cache = Path.home() / ".evoflow-dev" / "data" / "plugins" / "cache" / "evoflow-plugins-official" / "browser-use"
    if cache.is_dir():
        vers = sorted([p for p in cache.iterdir() if p.is_dir()], key=lambda p: p.name, reverse=True)
        if vers:
            os.environ.setdefault("ZCODE_PLUGIN_ROOT", str(vers[0]))
            print(f"[smoke] ZCODE_PLUGIN_ROOT={vers[0]}")

    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from evoflow.plugins.node_repl import call_node_repl_js, shutdown

    js = f"""
const tab = await browser.tabs.get("tab-0");
await tab.goto({json.dumps(str(args.url))});
await tab.playwright.waitForLoadState({{ state: "domcontentloaded" }});
let url = "";
try {{
  const st = await globalThis[Symbol.for("zcode.node-repl.browser-control-bridge")]
    .execute("evoflow-webview", 1, {{ method: "getState" }});
  url = String((st && st.state && st.state.url) || "");
}} catch (_) {{}}
JSON.stringify({{
  ok: true,
  hasBrowser: typeof browser !== "undefined",
  hasTabs: typeof tabs !== "undefined",
  requireOk: typeof require === "function" ? Boolean(require("browser-use")) : null,
  url,
}});
"""
    try:
        out = call_node_repl_js(js, timeout_ms=60_000)
        print(f"[smoke] node_repl out={out[:500]!r}")
        if "ok" not in out and "true" not in out.lower():
            print("[smoke] WARN: node_repl returned unexpected text (check panel / CDP)")
            return 7
        print("[smoke] OK: node_repl path ran (see panel)")
    except Exception as exc:
        print(f"[smoke] FAIL: node_repl: {exc}")
        return 8
    finally:
        try:
            shutdown()
        except Exception:
            pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
