"""EvoFlow browser engine — single Tauri-orchestrator (ZCode parity).

ZCode's architecture in one sentence: renderer creates a child ``<webview>``,
the main process attaches CDP to it, and the agent drives the *same* webview
through that single CDP channel. EvoFlow's twist is that the agent lives in a
separate Python gateway, so commands have to cross the process boundary — this
file is the cross-process dispatcher.

Architecture (post-mcp):
- The agent browser tool calls :func:`get_browser_engine().execute(...)` with
  the ZCode browser command contract (``open | snapshot | click | fill | ...``).
- Each command maps to a raw CDP method via :meth:`BrowserEngine._wv2_command`,
  which forwards it to ``_dispatch_run(...)`` → the Rust ``Tauri::CDP HTTP server``
  in ``browser_cdp_server.rs`` (the cross-process bridge) → WebView2.
- The panel's user-driven path (open / refresh / click) goes through the same
  WebView2 via ``browserEmbedUpsert`` (a direct Tauri invoke from the React
  frontend), so the user and the agent literally share one rendered page.
- There is no second browser, no metadata, no tab model, no streaming — the
  user looks at the WebView2 they can see; the agent drives that exact page.

The agent-browser CLI, the Playwright/WS broker, screencasts, and the
persistent Chromium were all removed when this file collapsed to the ZCode
shape. See ``git log packages/harness/evoflow/tools/builtins/browser_engine.py``
for the history.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import socket
import threading
import time
from collections.abc import Awaitable, Callable
from typing import Any

import httpx

from evoflow.tools.builtins.browser_contract import (
    DEFAULT_AGENT_BROWSER_VIEWPORT,
    BrowserSnapshot,
    CommandResult,
    DialogInfo,
    ErrorCode,
    PageState,
    SnapshotElement,
    TabSummary,
    fail,
)

logger = logging.getLogger(__name__)

_COMMAND_BUDGET_SEC = float(os.getenv("EVOFLOW_BROWSER_ENGINE_BUDGET", "30"))
_NAVIGATE_TIMEOUT_MS = int(os.getenv("EVOFLOW_BROWSER_NAVIGATE_TIMEOUT_MS", "25000"))
_SESSION_TTL_SEC = float(os.getenv("EVOFLOW_BROWSER_SESSION_TTL", "1800"))
_SNAPSHOT_MAX_ELEMENTS = int(os.getenv("EVOFLOW_BROWSER_SNAPSHOT_MAX_ELEMENTS", "150"))
_SNAPSHOT_MAX_DOM = int(os.getenv("EVOFLOW_BROWSER_SNAPSHOT_MAX_DOM", "400"))

# CDP Input.dispatchKeyEvent modifier bitmask.
# https://chromedevtools.github.io/devtools-protocol/tot/Input/#type-KeyEvent
def _cdp_modifier_mask(mod: str) -> int:
    """Map a keyboard modifier name to the CDP modifier bitmask."""
    return {
        "Alt": 1,
        "Control": 2,
        "Meta": 4,
        "Shift": 8,
    }.get(mod, 0)


# Virtual key codes for the modifier keys themselves (used when we synthesize
# keyDown/keyUp events for each modifier around a key press).
_MODIFIER_VK = {"Control": 17, "Alt": 18, "Shift": 16, "Meta": 91}


# Windows virtual key codes + DOM code names for Input.dispatchKeyEvent.
# Without windowsVirtualKeyCode most keys are inert in real pages (Chrome only
# synthesizes default actions for events carrying a real key code), and text
# input needs the ``text`` field on keyDown.
_KEY_SPECS: dict[str, tuple[str, int, str | None]] = {
    # name -> (code, windowsVirtualKeyCode, text-for-keyDown)
    "Enter": ("Enter", 13, "\r"),
    "Tab": ("Tab", 9, None),
    "Escape": ("Escape", 27, None),
    "Backspace": ("Backspace", 8, None),
    "Delete": ("Delete", 46, None),
    "ArrowUp": ("ArrowUp", 38, None),
    "ArrowDown": ("ArrowDown", 40, None),
    "ArrowLeft": ("ArrowLeft", 37, None),
    "ArrowRight": ("ArrowRight", 39, None),
    "Home": ("Home", 36, None),
    "End": ("End", 35, None),
    "PageUp": ("PageUp", 33, None),
    "PageDown": ("PageDown", 34, None),
    "Insert": ("Insert", 45, None),
    " ": ("Space", 32, " "),
}
for _vk, _name in ((112, "F1"), (113, "F2"), (114, "F3"), (115, "F4"), (116, "F5"),
                   (117, "F6"), (118, "F7"), (119, "F8"), (120, "F9"), (121, "F10"),
                   (122, "F11"), (123, "F12")):
    _KEY_SPECS[_name] = (_name, _vk, None)
for _char in "abcdefghijklmnopqrstuvwxyz":
    _KEY_SPECS[_char] = (f"Key{_char.upper()}", ord(_char.upper()), _char)
for _digit in "0123456789":
    _KEY_SPECS[_digit] = (f"Digit{_digit}", ord(_digit), _digit)


def _cdp_key_event(key: str, key_type: str) -> dict[str, Any]:
    """Build an Input.dispatchKeyEvent params dict for one key phase."""
    spec = _KEY_SPECS.get(key)
    if spec is None and len(key) == 1:
        # Printable ASCII punctuation: VK code is the uppercase ordinal, text
        # carries the character itself so the browser inserts it verbatim.
        spec = (f"Key_{key.upper()}" if not key.isalnum() else key.upper(), ord(key.upper()), key)
    if spec is None:
        # Unknown named key (Media*, etc.) — send as-is, Chrome may still map it.
        return {"type": key_type, "key": key, "code": key}
    code, vk, text = spec
    event: dict[str, Any] = {
        "type": key_type,
        "key": key,
        "code": code,
        "windowsVirtualKeyCode": vk,
        "nativeVirtualKeyCode": vk,
    }
    if key_type == "keyDown" and text is not None:
        event["text"] = text
    return event


# ---------------------------------------------------------------------------
# Cross-process CDP bridge: Tauri HTTP server
# ---------------------------------------------------------------------------
# Rust (`evopanel/src-tauri/src/commands/browser_cdp_server.rs`) starts a tiny
# localhost HTTP server on `127.0.0.1:0` when the browser panel first opens, and
# writes the bound port to a well-known file. We read that file once, cache the
# port, and call `POST /browser-cdp/command?thread_id=...&method=...` for every
# CDP request.


def _resolve_evoflow_dir() -> str:
    """Mirror the Rust ``commands::evoflow_dir`` logic.

    Rust honours ``EVOFLOW_CONFIG_DIR`` (dev/prod isolation); debug builds fall
    back to ``~/.evoflow-dev``, release builds to ``~/.evoflow``. Without this
    mirror the agent in debug mode can read a stale port file from an earlier
    release session and the desktop in debug builds can never be reached.
    """
    env = os.environ.get("EVOFLOW_CONFIG_DIR")
    if env:
        return env
    home = os.path.expanduser("~")
    # Mirror Rust's ``#[cfg(debug_assertions)]`` branch: debug build writes to
    # ``~/.evoflow-dev``. We can't read the Rust target from Python, so probe
    # both: prefer the debug variant when it exists, otherwise the release
    # variant. Both directories can coexist on the same machine (one per
    # build profile), so this is purely a "which one is the desktop using now
    # question."
    debug_dir = os.path.join(home, ".evoflow-dev")
    if os.path.isdir(debug_dir):
        return debug_dir
    return os.path.join(home, ".evoflow")


_EVOFLOW_DIR = _resolve_evoflow_dir()
_WV2_PORT_FILE = os.path.join(_EVOFLOW_DIR, "browser-cdp-http-port")
_WV2_PORT_CACHE: dict[str, tuple[int, float]] = {}
_WV2_PORT_LOCK = threading.Lock()
_WV2_PORT_CACHE_TTL_SEC = 30.0  # re-probe at most every 30s

# One AsyncClient per process, created lazily on the engine loop. Every CDP
# call used to build a fresh AsyncClient (new pool, new TLS contexts); with
# one shared client the keep-alive pool serves the whole session.
_HTTP_CLIENT: httpx.AsyncClient | None = None


def _get_http_client() -> httpx.AsyncClient:
    global _HTTP_CLIENT
    if _HTTP_CLIENT is None or _HTTP_CLIENT.is_closed:
        _HTTP_CLIENT = httpx.AsyncClient(timeout=90.0)
    return _HTTP_CLIENT


def _probe_cdp_bridge(port: int, timeout: float = 0.4) -> bool:
    """TCP-probe the bridge on 127.0.0.1:port.  We don't speak HTTP here, the
    bridge will reject the unknown request — but as long as the kernel hands
    the connection to a live socket, we know the bridge is up.  This stops the
    agent from hammering a port left behind by an earlier, now-dead desktop
    process (the file persists across restarts)."""
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=timeout):
            return True
    except OSError:
        return False


def _read_browser_cdp_http_port() -> int | None:
    """Read the CDP HTTP server port from the well-known file, with caching.

    Cache key is the file mtime so that a re-bind (new port + new file content)
    invalidates the cache; the TTL additionally bounds how stale the cache can
    get.  A cached port is verified with a quick TCP connect before being
    returned — if the cached port is dead we drop the cache entry and fall
    through to a fresh read."""
    with _WV2_PORT_LOCK:
        cached = _WV2_PORT_CACHE.get("port")
        if cached is not None:
            cached_port, cached_mtime = cached
            if _probe_cdp_bridge(cached_port):
                return cached_port
            # cached port is dead — drop it and continue
            _WV2_PORT_CACHE.pop("port", None)
    try:
        if not os.path.exists(_WV2_PORT_FILE):
            return None
        with open(_WV2_PORT_FILE) as f:
            text = f.read().strip()
        port = int(text)
        # use file mtime as cache key so a restart-of-evoflow gets a new key
        try:
            mtime = os.path.getmtime(_WV2_PORT_FILE)
        except OSError:
            mtime = 0.0
        # always verify with a TCP probe before honouring the file
        if not _probe_cdp_bridge(port):
            return None
        with _WV2_PORT_LOCK:
            # only cache if no fresher entry has been installed
            existing = _WV2_PORT_CACHE.get("port")
            if existing is None or existing[1] < mtime:
                _WV2_PORT_CACHE["port"] = (port, mtime)
        return port
    except Exception:
        return None


async def _read_browser_cdp_http_port_async(
    attempts: int = 3, interval: float = 0.3
) -> int | None:
    """Read the port with a small retry: the desktop app writes the file
    *after* it binds the loopback listener, and the agent may be called
    before that write has landed.  The retry is bounded so a real outage
    surfaces a clear error rather than hanging the agent thread."""
    for _ in range(attempts):
        port = _read_browser_cdp_http_port()
        if port:
            return port
        await asyncio.sleep(interval)
    return None


async def _dispatch_run(
    tid: str, method: str, params: dict[str, Any] | None = None
) -> Any:
    """Call a CDP command on the embedded WebView2 via the Rust HTTP bridge.

    The Rust side calls ``browser_cdp_command`` on the right child webview and
    returns the parsed CDP result. This is the single point where the Python
    gateway talks to the WebView2; everything else in :mod:`browser_engine`
    translates ZCode-style commands into one of these calls.
    """
    port = await _read_browser_cdp_http_port_async()
    if not port:
        raise RuntimeError(
            "WebView2 CDP bridge not running. "
            "Is the EvoFlow desktop app running and has it finished booting?"
        )

    url = f"http://127.0.0.1:{port}/browser-cdp/command"
    params_json = json.dumps(params or {})
    resp = await _get_http_client().post(
        url,
        params={"thread_id": tid, "method": method},
        content=params_json,
        headers={"Content-Type": "application/json"},
    )
    if resp.status_code != 200:
        raise RuntimeError(f"WebView2 CDP HTTP error {resp.status_code}: {resp.text}")
    data = resp.json()
    if isinstance(data, dict) and "error" in data:
        raise RuntimeError(data["error"])
    return data


# ---------------------------------------------------------------------------
# Snapshot injection — bounded semantic DOM + interactive elements with refs.
# Mirrors the ZCode `UnifiedBrowserView` ref model: each interactive element is
# given a stable `eN` ref + a `SnapshotElement` descriptor. The emitted shapes
# are the contract in :mod:`browser_contract` (SnapshotElement / BrowserSnapshot);
# tests pin this alignment.
# ---------------------------------------------------------------------------

_SNAPSHOT_JS = r"""
(() => {
    const opts = arguments[0] || {};
    const MAX_ELEMENTS = opts.maxElements ?? 150;
    const MAX_DOM = opts.maxDom ?? 400;
    const includeHidden = opts.includeHidden ?? false;
    function isVisible(el) {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        const style = getComputedStyle(el);
        return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0;
    }
    function viewportRect() {
        return { left: 0, top: 0, right: window.innerWidth || 0, bottom: window.innerHeight || 0 };
    }
    const vp = viewportRect();
    function inViewport(rect) {
        return rect.x < vp.right && rect.y < vp.bottom &&
               rect.x + rect.width > vp.left && rect.y + rect.height > vp.top;
    }
    function roleOf(el) {
        const explicit = el.getAttribute('role');
        if (explicit) return explicit;
        const t = el.tagName;
        if (t === 'A') return 'link';
        if (t === 'BUTTON' || t === 'SUMMARY') return 'button';
        if (t === 'SELECT') return 'combobox';
        if (t === 'TEXTAREA') return 'textbox';
        if (t === 'INPUT') {
            const ty = (el.getAttribute('type') || 'text').toLowerCase();
            if (ty === 'checkbox') return 'checkbox';
            if (ty === 'radio') return 'radio';
            if (ty === 'button' || ty === 'submit' || ty === 'reset') return 'button';
            return 'textbox';
        }
        if (el.isContentEditable) return 'textbox';
        return t.toLowerCase();
    }
    function accessibleName(el) {
        const aria = el.getAttribute('aria-label') || '';
        if (aria.trim()) return aria.trim().slice(0, 120);
        const title = el.getAttribute('title') || '';
        if (title.trim()) return title.trim().slice(0, 120);
        const placeholder = el.getAttribute('placeholder') || '';
        if (placeholder.trim()) return placeholder.trim().slice(0, 120);
        let text = '';
        try { text = (el.innerText || el.textContent || '').trim(); } catch (_) {}
        return text.slice(0, 120);
    }
    function isInteractive(el) {
        const t = el.tagName;
        if (t === 'A' || t === 'BUTTON' || t === 'INPUT' || t === 'SELECT' ||
            t === 'TEXTAREA' || t === 'SUMMARY') return true;
        if (el.hasAttribute('contenteditable') || el.isContentEditable) return true;
        const role = el.getAttribute('role');
        if (role === 'button' || role === 'link' || role === 'checkbox' ||
            role === 'radio' || role === 'tab' || role === 'switch' ||
            role === 'menuitem' || role === 'option' || role === 'slider') return true;
        return typeof el.onclick === 'function';
    }
    function cssSelector(el) {
        if (el.id) { try { return '#' + CSS.escape(el.id); } catch (e) { return '#' + el.id; } }
        const path = [];
        let cur = el;
        while (cur && cur !== document.body) {
            const parent = cur.parentElement;
            if (parent) {
                const siblings = Array.from(parent.children).filter(c => c.tagName === cur.tagName);
                const idx = siblings.indexOf(cur) + 1;
                path.unshift(cur.tagName.toLowerCase() + (idx > 1 ? ':nth-of-type(' + idx + ')' : ''));
            }
            cur = parent;
        }
        return 'body > ' + path.join(' > ');
    }
    function xpathOf(el) {
        const parts = [];
        let cur = el;
        while (cur && cur.nodeType === 1 && cur !== document.body) {
            let idx = 1;
            let sib = cur.previousElementSibling;
            while (sib) { if (sib.tagName === cur.tagName) idx++; sib = sib.previousElementSibling; }
            parts.unshift(cur.tagName.toLowerCase() + '[' + idx + ']');
            cur = cur.parentElement;
        }
        return '//body/' + parts.join('/');
    }
    function elementToDict(el, index) {
        const tag = el.tagName.toLowerCase();
        const role = roleOf(el);
        const name = accessibleName(el);
        let text = '';
        try { text = (el.innerText || '').trim().slice(0, 200); } catch (_) {}
        let value = '';
        try { value = (typeof el.value === 'string') ? el.value.slice(0, 200) : ''; } catch (_) {}
        const checked = (role === 'checkbox' || role === 'radio') ? Boolean(el.checked) : null;
        const disabled = Boolean(el.disabled || el.getAttribute('aria-disabled') === 'true');
        const rect = el.getBoundingClientRect();
        const attrs = {};
        let attrCount = 0;
        for (const a of el.attributes || []) {
            if (attrCount >= 8) break;
            if (a.value.length > 120) continue;
            attrs[a.name] = a.value;
            attrCount += 1;
        }
        return {
            ref: 'e' + (index + 1),
            tag,
            role,
            name,
            text,
            value,
            checked,
            disabled,
            selector: cssSelector(el),
            xpath: xpathOf(el),
            rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            inViewport: inViewport(rect),
            attributes: attrs,
        };
    }
    function interactiveElements() {
        const out = [];
        const walker = document.createTreeWalker(
            document.body || document.documentElement,
            NodeFilter.SHOW_ELEMENT,
            { acceptNode: (el) => {
                if (!isInteractive(el)) return NodeFilter.FILTER_SKIP;
                if (!includeHidden && !isVisible(el)) return NodeFilter.FILTER_SKIP;
                return NodeFilter.FILTER_ACCEPT;
            }}
        );
        let n;
        while ((n = walker.nextNode())) {
            out.push(n);
            if (out.length >= MAX_ELEMENTS) break;
        }
        return out;
    }
    // Compact outline of readable content, aligned with SnapshotDomNode.
    function domOutline() {
        const tags = new Set(['H1','H2','H3','H4','H5','H6','P','LI','BLOCKQUOTE','PRE','TH','TD','DT','DD','FIGCAPTION']);
        const out = [];
        const walker = document.createTreeWalker(
            document.body || document.documentElement,
            NodeFilter.SHOW_ELEMENT,
            null
        );
        let depth = 0;
        let node;
        while ((node = walker.nextNode()) && out.length < MAX_DOM) {
            depth = 0;
            let anc = node.parentElement;
            while (anc) { depth++; anc = anc.parentElement; }
            if (!tags.has(node.tagName)) continue;
            const text = (node.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 200);
            if (!text) continue;
            const rect = node.getBoundingClientRect();
            out.push({
                tag: node.tagName.toLowerCase(),
                depth: Math.max(0, depth - 2),
                inViewport: inViewport(rect),
                text,
            });
        }
        return out;
    }
    const elements = interactiveElements().map(elementToDict);
    const truncated = elements.length >= MAX_ELEMENTS;
    const outline = domOutline();
    return {
        url: window.location.href,
        title: document.title || '',
        elements,
        truncated,
        dom: outline,
        domTruncated: outline.length >= MAX_DOM,
    };
})()
"""

_INTERACTIVE_AT_POINT_JS = r"""
(() => {
    function isVisible(el) {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        const style = getComputedStyle(el);
        return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0;
    }
    const x = arguments[0]?.x ?? 0;
    const y = arguments[0]?.y ?? 0;
    const target = document.elementFromPoint(x, y);
    if (!target || !isVisible(target)) return null;
    let elInteractive = target;
    while (elInteractive && elInteractive !== document.body) {
        const t = elInteractive.tagName;
        const role = elInteractive.getAttribute && elInteractive.getAttribute('role');
        const interactive = (t === 'A' || t === 'BUTTON' || t === 'INPUT' ||
            t === 'SELECT' || t === 'TEXTAREA' ||
            (elInteractive.getAttribute && elInteractive.getAttribute('contenteditable')) ||
            typeof elInteractive.onclick === 'function' || role === 'button' || role === 'link');
        if (interactive) break;
        elInteractive = elInteractive.parentElement;
    }
    if (!elInteractive || elInteractive === document.body) return null;
    const tag = elInteractive.tagName.toLowerCase();
    const attrs = {};
    for (const a of elInteractive.attributes || []) attrs[a.name] = a.value;
    const role = elInteractive.getAttribute('role') || '';
    const name = elInteractive.getAttribute('name') || elInteractive.getAttribute('aria-label') || elInteractive.getAttribute('title') || '';
    let text = (elInteractive.textContent || '').trim().slice(0, 200);
    let selector = '';
    try {
        if (elInteractive.id) selector = '#' + CSS.escape(elInteractive.id);
    } catch (e) {}
    return { tag, role, name, text, attrs, selector, xpath: '' };
})()
"""

_PAGE_STATE_JS = (
    "({url: location.href, title: document.title || '', "
    "sx: window.scrollX || 0, sy: window.scrollY || 0, "
    "vw: window.innerWidth || 0, vh: window.innerHeight || 0, "
    "hl: history.length || 0})"
)


# ---------------------------------------------------------------------------
# Session — pure state, no Playwright objects. WebView2 lives in Tauri.
# ---------------------------------------------------------------------------


class _CommandError(Exception):
    """A command-level failure with a contract error code.

    Distinct from RuntimeError (bridge/transport problems, mapped to
    ``backend_unavailable``): command errors like an unknown ref surface with
    their own code, ZCode parity for ``ref_not_found``.
    """

    def __init__(self, code: ErrorCode, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


class _Session:
    """Per-thread state: refs for snapshot, last URL/title for getState.

    The actual browser lives in the Tauri-side WebView2 child window; the
    session here is just the agent's bookkeeping (ref dictionary, last dialog,
    last URL).
    """

    def __init__(self, key: str, tid: str) -> None:
        self.key = key
        self.tid = tid
        self.refs: dict[str, str] = {}
        self.ref_meta: dict[str, dict[str, Any]] = {}
        self.next_ref_index = 0
        self.last_dialog: dict[str, Any] | None = None
        self.last_url = ""
        self.last_used = time.time()


# ---------------------------------------------------------------------------
# BrowserEngine — single asyncio loop, all sessions live here.
# ---------------------------------------------------------------------------


class BrowserEngine:
    """Cross-process dispatcher for browser commands.

    The loop owns a dict of ``_Session`` keyed by thread_id.  ``execute()`` runs
    on the calling thread (a gateway worker thread); it submits work to the loop
    via ``_submit`` and returns the dict result.  No Playwright, no screencast,
    no persistent Chromium — see module docstring.
    """

    def __init__(self) -> None:
        self._loop: asyncio.AbstractEventLoop | None = None
        self._ready = threading.Event()
        self._thread: threading.Thread | None = None
        self._start_lock = threading.Lock()
        self._sessions: dict[str, _Session] = {}
        self._stopped = False

    # -- lifecycle ----------------------------------------------------------

    def _ensure_thread(self) -> None:
        if self._ready.is_set() and self._thread and self._thread.is_alive():
            return
        with self._start_lock:
            if self._ready.is_set() and self._thread and self._thread.is_alive():
                return
            if self._stopped:
                raise RuntimeError("browser engine stopped")
            self._thread = threading.Thread(
                target=self._thread_main, name="evoflow-browser-engine", daemon=True
            )
            self._thread.start()
            if not self._ready.wait(timeout=60):
                raise RuntimeError("browser engine failed to start")

    def _thread_main(self) -> None:
        try:
            if os.name == "nt":
                import asyncio as _asyncio

                try:
                    _asyncio.set_event_loop_policy(_asyncio.WindowsProactorEventLoopPolicy())
                except Exception:
                    pass
            asyncio.run(self._main())
        except Exception as exc:
            logger.error("browser engine loop crashed: %s", exc, exc_info=True)
        finally:
            self._ready.clear()

    async def _main(self) -> None:
        self._loop = asyncio.get_running_loop()
        self._ready.set()
        logger.info("browser engine ready (WebView2 mode)")
        reaper = asyncio.create_task(self._reap_loop())
        try:
            while True:
                await asyncio.sleep(3600)
        finally:
            reaper.cancel()

    def _submit(self, coro_factory: Callable[[], Awaitable[Any]], timeout: float) -> Any:
        self._ensure_thread()
        loop = self._loop
        if loop is None or loop.is_closed():
            raise RuntimeError("browser engine loop unavailable")
        future = asyncio.run_coroutine_threadsafe(coro_factory(), loop)
        return future.result(timeout=timeout + 5)

    # -- session lifecycle ---------------------------------------------------

    def _get_session(self, tid: str) -> _Session:
        """Return (creating if needed) the bookkeeping session for this thread.

        All threads share one underlying WebView2 (the panel's); we don't need
        to launch or attach anything. The only reason we still key by thread_id
        is to keep the ``refs`` map (snapshot/ref model) per chat session, so
        a long-running agent can take fresh snapshots without bleeding refs
        across threads.
        """
        from evoflow.tools.builtins.browser_screenshot_store import _safe_thread_segment

        key = _safe_thread_segment(tid)
        session = self._sessions.get(key)
        if session is not None:
            session.last_used = time.time()
            return session
        session = _Session(key, tid)
        self._sessions[key] = session
        return session

    async def _reap_loop(self) -> None:
        while True:
            await asyncio.sleep(60)
            now = time.time()
            for key, session in list(self._sessions.items()):
                if now - session.last_used > _SESSION_TTL_SEC:
                    logger.info("browser engine reaping idle session key=%s", key)
                    self._sessions.pop(key, None)

    # -- public API ----------------------------------------------------------

    def execute(self, thread_id: str, command: dict[str, Any], timeout: float) -> dict[str, Any]:
        """Dispatch one ZCode-style browser command.  See :mod:`browser_contract`."""
        started = time.time()
        method = str(command.get("method") or "")
        logger.info(
            "browser_engine.execute thread=%s method=%s timeout=%s",
            thread_id,
            method,
            timeout,
        )

        async def _run() -> dict[str, Any]:
            try:
                session = self._get_session(thread_id)
            except Exception as exc:
                logger.warning(
                    "browser_engine.execute session-acquire FAILED thread=%s method=%s: %s",
                    thread_id,
                    method,
                    exc,
                    exc_info=True,
                )
                result = fail(ErrorCode.BACKEND_UNAVAILABLE, f"browser session unavailable: {exc}")
                result.elapsedMs = round((time.time() - started) * 1000, 1)
                return result.model_dump(mode="json", by_alias=True, exclude_none=True)
            try:
                result = await self._wv2_command(session, command)
            except Exception as exc:
                logger.warning(
                    "browser_engine.execute dispatch FAILED thread=%s method=%s: %s",
                    thread_id,
                    method,
                    exc,
                    exc_info=True,
                )
                result = fail(ErrorCode.EXECUTION_ERROR, str(exc))
            result.elapsedMs = round((time.time() - started) * 1000, 1)
            payload = result.model_dump(mode="json", by_alias=True, exclude_none=True)
            logger.info(
                "browser_engine.execute DONE thread=%s method=%s ok=%s elapsed_ms=%s code=%s",
                thread_id,
                method,
                payload.get("ok"),
                payload.get("elapsedMs"),
                (payload.get("error") or {}).get("code"),
            )
            return payload

        return self._submit(_run, timeout or _COMMAND_BUDGET_SEC)

    def has_session(self, thread_id: str) -> bool:
        from evoflow.tools.builtins.browser_screenshot_store import _safe_thread_segment

        key = _safe_thread_segment(thread_id)
        return key in self._sessions

    def drop_session_if_not_embedded(self, thread_id: str, cdp_url: str) -> bool:
        """ZCode parity — discard any stale session so the next call rebinds.

        In ZCode this is a guard against a stale guest WebContents; in EvoFlow the
        underlying WebView2 is fixed, so there's nothing to rebind to. We still
        expose the method (panel-side ``registerBrowserEmbedCdp`` calls it as a
        safety net) and return ``False`` — there is no stale session to drop
        when the only browser is the panel's WebView2.
        """
        return False

    def close_session(self, thread_id: str) -> None:
        from evoflow.tools.builtins.browser_screenshot_store import _safe_thread_segment

        self._sessions.pop(_safe_thread_segment(thread_id), None)

    # -- WebView2 dispatch ---------------------------------------------------

    async def _wv2_command(
        self, session: _Session, command: dict[str, Any]
    ) -> CommandResult:
        tid = session.tid
        method = str(command.get("method") or "")
        try:
            handler = getattr(self, f"_wv2_{method}", None)
            if handler is not None:
                return await handler(session, command)
        except _CommandError as exc:
            return fail(exc.code, exc.message)
        except RuntimeError as exc:
            return fail(ErrorCode.BACKEND_UNAVAILABLE, str(exc))
        except Exception as exc:
            logger.warning("wv2 dispatch error method=%s thread=%s: %s", method, tid, exc, exc_info=True)
            return fail(ErrorCode.EXECUTION_ERROR, str(exc))
        return fail(ErrorCode.CAPABILITY_UNSUPPORTED, f"unsupported browser method '{method}'")

    def _resolve_ref(self, session: _Session, ref: str) -> str:
        selector = session.refs.get(ref)
        if not selector:
            raise _CommandError(
                ErrorCode.REF_NOT_FOUND,
                f"ref_not_found: unknown or stale ref '{ref}' (take a fresh snapshot)",
            )
        return selector

    def _element_of_ref(self, session: _Session, ref: str) -> SnapshotElement | None:
        meta = session.ref_meta.get(ref)
        if not meta:
            return None
        try:
            return SnapshotElement.model_validate(meta)
        except Exception:
            return None

    async def _page_state(self, session: _Session, tid: str) -> PageState:
        """Read the page state in one Runtime.evaluate round trip."""
        try:
            raw = await _dispatch_run(
                tid,
                "Runtime.evaluate",
                {"expression": _PAGE_STATE_JS, "returnByValue": True},
            )
            info = raw.get("result", {}).get("value", {}) if isinstance(raw, dict) else {}
        except Exception:
            info = {}
        return PageState(
            url=str(info.get("url") or session.last_url or ""),
            title=str(info.get("title", "")),
            canGoBack=bool(info.get("hl", 0) > 1),
            canGoForward=False,
            scrollX=float(info.get("sx") or 0),
            scrollY=float(info.get("sy") or 0),
            viewportWidth=float(info.get("vw") or 0) or None,
            viewportHeight=float(info.get("vh") or 0) or None,
        )

    async def _wait_document_ready(
        self, tid: str, timeout_ms: int = 5000
    ) -> None:
        """Wait until the document reaches 'complete' (ZCode: the explicit
        waitForLoadState after goto). Bounded — a hanging page never blocks the
        tool longer than the deadline."""
        deadline = time.monotonic() + max(0, timeout_ms) / 1000
        while True:
            try:
                raw = await _dispatch_run(
                    tid,
                    "Runtime.evaluate",
                    {"expression": "document.readyState", "returnByValue": True},
                )
                state = raw.get("result", {}).get("value") if isinstance(raw, dict) else None
                if state in ("complete", "interactive"):
                    return
            except Exception:
                return
            if time.monotonic() >= deadline:
                return
            await asyncio.sleep(0.15)

    async def _take_snapshot(
        self,
        session: _Session,
        tid: str,
        *,
        max_elements: int | None = None,
        include_hidden: bool = False,
    ) -> BrowserSnapshot:
        raw = await _dispatch_run(
            tid,
            "Runtime.evaluate",
            {
                "expression": _SNAPSHOT_JS,
                "arguments": [
                    {
                        "maxElements": max_elements or _SNAPSHOT_MAX_ELEMENTS,
                        "maxDom": _SNAPSHOT_MAX_DOM,
                        "includeHidden": bool(include_hidden),
                    }
                ],
                "returnByValue": True,
            },
        )
        result_val = raw.get("result", {}).get("value", {}) if isinstance(raw, dict) else {}
        if not result_val:
            return BrowserSnapshot(url="", title="", elements=[], truncated=False)
        # Validate each element through the contract so a WebView2/JS drift
        # surfaces as a per-element skip (logged) instead of a broken snapshot.
        elements: list[SnapshotElement] = []
        for el in result_val.get("elements", []):
            try:
                elements.append(SnapshotElement.model_validate(el))
            except Exception as exc:
                logger.warning("snapshot element dropped (contract drift): %s", exc)
        session.refs = {el.ref: el.selector for el in elements}
        session.ref_meta = {el.ref: el.model_dump() for el in elements}
        session.next_ref_index = len(session.refs)
        session.last_url = result_val.get("url") or session.last_url
        return BrowserSnapshot(
            url=str(result_val.get("url") or ""),
            title=str(result_val.get("title") or ""),
            elements=elements,
            truncated=bool(result_val.get("truncated")),
            dom=result_val.get("dom"),
            domTruncated=bool(result_val.get("domTruncated")),
        )

    # -- command handlers ----------------------------------------------------

    async def _wv2_navigate(self, session: _Session, command: dict[str, Any]) -> CommandResult:
        url = str(command.get("url") or "").strip()
        if not url:
            return fail(ErrorCode.EXECUTION_ERROR, "navigate requires url")
        if not url.startswith(("http://", "https://", "file://", "about:", "data:")):
            url = f"https://{url}"
        await _dispatch_run(session.tid, "Page.navigate", {"url": url})
        session.last_url = url
        await self._wait_document_ready(session.tid)
        return CommandResult(ok=True, state=await self._page_state(session, session.tid))

    async def _wv2_back(self, session: _Session, command: dict[str, Any]) -> CommandResult:
        tid = session.tid
        # CDP has no Page.goBack — walk the session history explicitly.
        history = await _dispatch_run(tid, "Page.getNavigationHistory", {})
        index = int(history.get("index", 0)) if isinstance(history, dict) else 0
        entries = history.get("entries") or [] if isinstance(history, dict) else []
        if index <= 0 or index >= len(entries):
            return CommandResult(ok=True, state=await self._page_state(session, tid))
        await _dispatch_run(
            tid, "Page.navigateToHistoryEntry", {"entryId": entries[index - 1]["id"]}
        )
        await self._wait_document_ready(tid)
        return CommandResult(ok=True, state=await self._page_state(session, tid))

    async def _wv2_forward(self, session: _Session, command: dict[str, Any]) -> CommandResult:
        tid = session.tid
        history = await _dispatch_run(tid, "Page.getNavigationHistory", {})
        index = int(history.get("index", 0)) if isinstance(history, dict) else 0
        entries = history.get("entries") or [] if isinstance(history, dict) else []
        if index + 1 >= len(entries) or index < 0:
            return CommandResult(ok=True, state=await self._page_state(session, tid))
        await _dispatch_run(
            tid, "Page.navigateToHistoryEntry", {"entryId": entries[index + 1]["id"]}
        )
        await self._wait_document_ready(tid)
        return CommandResult(ok=True, state=await self._page_state(session, tid))

    async def _wv2_reload(self, session: _Session, command: dict[str, Any]) -> CommandResult:
        await _dispatch_run(session.tid, "Page.reload", {})
        await self._wait_document_ready(session.tid)
        return CommandResult(ok=True, state=await self._page_state(session, session.tid))

    async def _wv2_snapshot(self, session: _Session, command: dict[str, Any]) -> CommandResult:
        snapshot = await self._take_snapshot(
            session,
            session.tid,
            max_elements=command.get("maxElements"),
            include_hidden=bool(command.get("includeHidden")),
        )
        return CommandResult(
            ok=True,
            snapshot=snapshot,
            state=await self._page_state(session, session.tid),
        )

    async def _wv2_click(self, session: _Session, command: dict[str, Any]) -> CommandResult:
        tid = session.tid
        ref = command.get("ref")
        x = command.get("x")
        y = command.get("y")
        element: SnapshotElement | None = None
        button_arg = command.get("button") or "left"
        if ref:
            selector = self._resolve_ref(session, str(ref))
            element = self._element_of_ref(session, str(ref))
            js = (
                "(function(){const el=document.querySelector(" + json.dumps(selector) + ");"
                "if(!el)throw new Error('element not found: " + selector.replace("'", "\\'") + "');"
                "el.scrollIntoView({block:'center'});el.click();return true;})()"
            )
            await _dispatch_run(tid, "Runtime.evaluate", {"expression": js, "returnByValue": True})
        elif x is not None and y is not None:
            xf, yf = float(x), float(y)
            for ev_type, clicks in (("mousePressed", 1), ("mouseReleased", 1)):
                await _dispatch_run(tid, "Input.dispatchMouseEvent", {
                    "type": ev_type, "x": xf, "y": yf, "button": button_arg, "clickCount": clicks,
                })
            if command.get("doubleClick"):
                for ev_type, clicks in (("mousePressed", 2), ("mouseReleased", 2)):
                    await _dispatch_run(tid, "Input.dispatchMouseEvent", {
                        "type": ev_type, "x": xf, "y": yf, "button": button_arg, "clickCount": clicks,
                    })
            try:
                raw = await _dispatch_run(tid, "Runtime.evaluate", {
                    "expression": _INTERACTIVE_AT_POINT_JS,
                    "arguments": [{"x": xf, "y": yf}],
                    "returnByValue": True,
                })
                val = raw.get("result", {}).get("value") if isinstance(raw, dict) else None
                if isinstance(val, dict) and val:
                    session.next_ref_index += 1
                    new_ref = f"e{session.next_ref_index}"
                    val["ref"] = new_ref
                    val["selector"] = val.get("selector") or ""
                    val["xpath"] = val.get("xpath") or ""
                    session.refs[new_ref] = val.get("selector") or ""
                    session.ref_meta[new_ref] = val
                    try:
                        element = SnapshotElement.model_validate(val)
                    except Exception:
                        element = None
            except Exception:
                pass
        else:
            return fail(ErrorCode.EXECUTION_ERROR, "click requires ref or x/y")
        return CommandResult(ok=True, element=element, state=await self._page_state(session, tid))

    async def _wv2_fill(self, session: _Session, command: dict[str, Any]) -> CommandResult:
        """Fill via focus + select-all + Input.insertText.

        Setting ``el.value`` directly bypasses React's value tracker — the
        controlled-component state never updates and the next render wipes
        the text. The keyboard path (insertText over a selection) produces
        real beforeinput/input events, which every framework sees.
        """
        ref = command.get("ref")
        if not ref:
            return fail(ErrorCode.EXECUTION_ERROR, "fill requires ref")
        selector = self._resolve_ref(session, str(ref))
        element = self._element_of_ref(session, str(ref))
        value = str(command.get("value") or "")
        focus_js = (
            "(function(){const el=document.querySelector(" + json.dumps(selector) + ");"
            "if(!el)throw new Error('element not found');"
            "el.scrollIntoView({block:'center'});el.focus();"
            "if(el.select){el.select();}"
            "else if(el.setSelectionRange){try{el.setSelectionRange(0, el.value.length);}catch(e){}}"
            "else if(el.isContentEditable){"
            "const r=document.createRange();r.selectNodeContents(el);"
            "const s=window.getSelection();s.removeAllRanges();s.addRange(r);}"
            "return true;})()"
        )
        await _dispatch_run(session.tid, "Runtime.evaluate", {"expression": focus_js, "returnByValue": True})
        if value:
            await _dispatch_run(session.tid, "Input.insertText", {"text": value})
        return CommandResult(ok=True, element=element, state=await self._page_state(session, session.tid))

    async def _wv2_type(self, session: _Session, command: dict[str, Any]) -> CommandResult:
        text = str(command.get("text") or "")
        ref = command.get("ref")
        element: SnapshotElement | None = None
        if ref:
            selector = self._resolve_ref(session, str(ref))
            element = self._element_of_ref(session, str(ref))
            js = (
                "(function(){const el=document.querySelector(" + json.dumps(selector) + ");"
                "if(el)el.focus();return true;})()"
            )
            await _dispatch_run(session.tid, "Runtime.evaluate", {"expression": js, "returnByValue": True})
        await _dispatch_run(session.tid, "Input.insertText", {"text": text})
        return CommandResult(ok=True, element=element, state=await self._page_state(session, session.tid))

    async def _wv2_press(self, session: _Session, command: dict[str, Any]) -> CommandResult:
        key = str(command.get("key") or "").strip()
        if not key:
            return fail(ErrorCode.EXECUTION_ERROR, "press requires key")
        modifiers = command.get("modifiers") or []
        tid = session.tid
        for mod in modifiers:
            mod_vk = _MODIFIER_VK.get(mod, 0)
            await _dispatch_run(tid, "Input.dispatchKeyEvent", {
                "type": "keyDown", "key": mod, "code": mod,
                "windowsVirtualKeyCode": mod_vk,
                "nativeVirtualKeyCode": mod_vk,
                "modifiers": _cdp_modifier_mask(mod),
            })
        await _dispatch_run(tid, "Input.dispatchKeyEvent", _cdp_key_event(key, "keyDown"))
        await _dispatch_run(tid, "Input.dispatchKeyEvent", _cdp_key_event(key, "keyUp"))
        for mod in reversed(modifiers):
            mod_vk = _MODIFIER_VK.get(mod, 0)
            await _dispatch_run(tid, "Input.dispatchKeyEvent", {
                "type": "keyUp", "key": mod, "code": mod,
                "windowsVirtualKeyCode": mod_vk,
                "nativeVirtualKeyCode": mod_vk,
            })
        return CommandResult(ok=True, state=await self._page_state(session, tid))

    async def _wv2_scroll(self, session: _Session, command: dict[str, Any]) -> CommandResult:
        # Direct wheel deltas when provided (panel route), direction/amount
        # fallback for the agent tool surface.
        scroll_x = command.get("scrollX")
        scroll_y = command.get("scrollY")
        if scroll_x is None and scroll_y is None:
            direction = str(command.get("direction") or "down").lower()
            amount = int(command.get("amount") or 800)
            scroll_x = amount if direction == "right" else (-amount if direction == "left" else 0)
            scroll_y = amount if direction in ("down", "right") else -amount
        delta_x = float(scroll_x or 0)
        delta_y = float(scroll_y or 0)
        await _dispatch_run(session.tid, "Input.dispatchMouseEvent", {
            "type": "mouseWheel", "x": 0, "y": 0, "deltaX": delta_x, "deltaY": delta_y,
        })
        return CommandResult(ok=True, state=await self._page_state(session, session.tid))

    async def _wv2_hover(self, session: _Session, command: dict[str, Any]) -> CommandResult:
        x = float(command.get("x", 0))
        y = float(command.get("y", 0))
        await _dispatch_run(session.tid, "Input.dispatchMouseEvent", {
            "type": "mouseMoved", "x": x, "y": y,
        })
        return CommandResult(ok=True, state=await self._page_state(session, session.tid))

    async def _wv2_screenshot(self, session: _Session, command: dict[str, Any]) -> CommandResult:
        params: dict[str, Any] = {"format": "png", "fromSurface": True}
        if command.get("fullPage"):
            params["captureBeyondViewport"] = True
        clip = command.get("clip")
        if clip:
            params["clip"] = {
                "x": float(clip["x"]),
                "y": float(clip["y"]),
                "width": float(clip["width"]),
                "height": float(clip["height"]),
                "scale": 1,
            }
        raw = await _dispatch_run(session.tid, "Page.captureScreenshot", params)
        data = raw.get("data", "") if isinstance(raw, dict) else ""
        if not data:
            return fail(ErrorCode.EXECUTION_ERROR, "screenshot returned no data")
        return CommandResult(
            ok=True,
            image={"base64": data, "mimeType": "image/png"},
            state=await self._page_state(session, session.tid),
        )

    async def _wv2_viewportSet(self, session: _Session, command: dict[str, Any]) -> CommandResult:
        width = int(command.get("width") or DEFAULT_AGENT_BROWSER_VIEWPORT["width"])
        height = int(command.get("height") or DEFAULT_AGENT_BROWSER_VIEWPORT["height"])
        await _dispatch_run(session.tid, "Emulation.setDeviceMetricsOverride", {
            "width": width, "height": height, "deviceScaleFactor": 1, "mobile": False,
        })
        return CommandResult(ok=True, state=await self._page_state(session, session.tid))

    async def _wv2_getState(self, session: _Session, command: dict[str, Any]) -> CommandResult:
        state = await self._page_state(session, session.tid)
        dialog = DialogInfo.model_validate(session.last_dialog) if session.last_dialog else None
        return CommandResult(ok=True, state=state, dialog=dialog)

    async def _wv2_getDialog(self, session: _Session, command: dict[str, Any]) -> CommandResult:
        dialog = DialogInfo.model_validate(session.last_dialog) if session.last_dialog else None
        return CommandResult(ok=True, dialog=dialog)

    async def _wv2_handleDialog(self, session: _Session, command: dict[str, Any]) -> CommandResult:
        session.last_dialog = None
        return CommandResult(ok=True, state=await self._page_state(session, session.tid))

    async def _wv2_evaluate(self, session: _Session, command: dict[str, Any]) -> CommandResult:
        expr = str(command.get("expression") or "")
        raw = await _dispatch_run(
            session.tid, "Runtime.evaluate", {"expression": expr, "returnByValue": True}
        )
        # Surface both the value and page-side errors (zcode parity: evaluate
        # results reach the model; a throwing page expression is an error, not
        # a silent ok).
        details = raw.get("exceptionDetails") if isinstance(raw, dict) else None
        if details:
            text = str(details.get("exception", {}).get("description") or details.get("text") or "page evaluate failed")
            return fail(ErrorCode.EXECUTION_ERROR, text)
        value = raw.get("result", {}).get("value") if isinstance(raw, dict) else None
        return CommandResult(
            ok=True,
            value=value,
            state=await self._page_state(session, session.tid),
        )

    async def _wv2_close(self, session: _Session, command: dict[str, Any]) -> CommandResult:
        # WebView2 has no engine-side close — the panel owns the window. Clear
        # the agent's bookkeeping session and let the user close the WebView2
        # via the panel's close button.
        self.close_session(session.tid)
        return CommandResult(ok=True)

    async def _wv2_open(self, session: _Session, command: dict[str, Any]) -> CommandResult:
        url = str(command.get("url") or "").strip()
        if not url:
            return fail(ErrorCode.EXECUTION_ERROR, "open requires url")
        return await self._wv2_navigate(session, {"url": url})

    async def _wv2_list(self, session: _Session, command: dict[str, Any]) -> CommandResult:
        # WebView2 is a single page per panel — list returns one tab.
        state = await self._page_state(session, session.tid)
        return CommandResult(
            ok=True,
            tabs=[TabSummary(
                tabId="tab-0",
                url=state.url,
                title=state.title,
                viewport={},
                active=True,
            )],
        )

    # -- ZCode parity: no multi-tab. These were left over from the Playwright
    # era and the gateway's tab routes still call them.  Map them onto the
    # single WebView2 so the toolbar / address bar never 500s.
    async def _wv2_tabList(self, session: _Session, command: dict[str, Any]) -> CommandResult:
        return await self._wv2_list(session, command)

    async def _wv2_tabSelect(self, session: _Session, command: dict[str, Any]) -> CommandResult:
        # Only one tab; selection is a no-op but we still echo the page state.
        return CommandResult(ok=True, state=await self._page_state(session, session.tid))

    async def _wv2_tabNew(self, session: _Session, command: dict[str, Any]) -> CommandResult:
        url = str(command.get("url") or "").strip()
        if url:
            return await self._wv2_navigate(session, {"url": url})
        return CommandResult(ok=True, state=await self._page_state(session, session.tid))

    async def _wv2_tabClose(self, session: _Session, command: dict[str, Any]) -> CommandResult:
        # No multi-tab — close is a no-op that returns the current page.
        return CommandResult(ok=True, state=await self._page_state(session, session.tid))


# ---------------------------------------------------------------------------
# Singleton + lifecycle guards
# ---------------------------------------------------------------------------

_engine: BrowserEngine | None = None
_engine_lock = threading.Lock()


def get_browser_engine() -> BrowserEngine:
    global _engine
    with _engine_lock:
        if _engine is None:
            _engine = BrowserEngine()
        return _engine


def browser_engine_enabled() -> bool:
    raw = str(os.getenv("EVOFLOW_BROWSER_ENGINE", "playwright")).strip().lower()
    return raw in ("", "playwright", "engine", "default")
