"""In-process browser engine: Playwright(Chromium) executor + CDP screencast WS.

Replaces the external ``agent-browser`` CLI subprocess path. Command shapes follow
ZCode's ``@zcode/shared/browser-use`` contract (see :mod:`browser_contract`).

Architecture:
- One dedicated asyncio thread owns ``async_playwright`` and all session state
  (pages/refs/screencast). Callers marshal commands in via
  ``asyncio.run_coroutine_threadsafe`` — the async API keeps CDP events (screencast)
  dispatching continuously while the engine is idle.
- Sessions attach to an existing browser over CDP when available (EvoPanel WebView2
  embed first, then ``EVOFLOW_BROWSER_CDP_URL``), otherwise launch a managed
  Chromium (headed by default on desktop).
- Each session serves a screencast WebSocket (``websockets.serve``) emitting
  ``{"type":"frame","data":<base64>,"format":"jpeg","metadata":{...}}`` — the same
  wire format the agent-browser CLI stream produced, so the gateway proxy and
  EvoPanel live canvas work unchanged.
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import threading
import time
from typing import Any, Awaitable, Callable

from evoflow.tools.builtins.browser_contract import (
    DEFAULT_AGENT_BROWSER_VIEWPORT,
    ElementRect,
    ErrorCode,
    SnapshotDomNode,
    SnapshotElement,
    BrowserSnapshot,
    CommandResult,
    DialogInfo,
    PageState,
    TabSummary,
    fail,
)
from evoflow.tools.builtins.browser_screenshot_store import _safe_thread_segment

logger = logging.getLogger(__name__)

_COMMAND_BUDGET_SEC = float(os.getenv("EVOFLOW_BROWSER_ENGINE_BUDGET", "30"))
_NAVIGATE_TIMEOUT_MS = int(os.getenv("EVOFLOW_BROWSER_NAVIGATE_TIMEOUT_MS", "25000"))
_SESSION_TTL_SEC = float(os.getenv("EVOFLOW_BROWSER_SESSION_TTL", "1800"))
_STREAM_JPEG_QUALITY = int(os.getenv("EVOFLOW_BROWSER_STREAM_QUALITY", "55"))
_STREAM_MAX_W = int(os.getenv("EVOFLOW_BROWSER_STREAM_MAX_W", "1280"))
_STREAM_MAX_H = int(os.getenv("EVOFLOW_BROWSER_STREAM_MAX_H", "900"))
# everyNthFrame=1 was too aggressive on quiet pages; 2 cuts idle CPU ~50% with no visible lag.
# Set EVOFLOW_BROWSER_STREAM_EVERY=1 to opt back into the previous behavior.
_STREAM_EVERY_NTH_FRAME = int(os.getenv("EVOFLOW_BROWSER_STREAM_EVERY", "2"))
_SNAPSHOT_MAX_ELEMENTS = int(os.getenv("EVOFLOW_BROWSER_SNAPSHOT_MAX_ELEMENTS", "150"))
_SNAPSHOT_MAX_DOM = int(os.getenv("EVOFLOW_BROWSER_SNAPSHOT_MAX_DOM", "400"))

_BROWSER_OPTIONS_HINT = (
    "浏览器引擎未就绪。可在 EvoFlow 后端执行 "
    "`python -m playwright install chromium`，或设置 AGENT_BROWSER_EXECUTABLE_PATH 指向本地 Chrome。"
)

# ---------------------------------------------------------------------------
# Snapshot injection — bounded semantic DOM + interactive elements with refs
# ---------------------------------------------------------------------------

_SNAPSHOT_JS = r"""
(args) => {
  const maxElements = args.maxElements || 150;
  const maxDom = args.maxDom || 400;
  const W = window.innerWidth, H = window.innerHeight;
  const doc = document;

  function isVisible(el) {
    const s = window.getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width >= 1 && r.height >= 1;
  }
  function rectOf(el) {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
  }
  function inViewport(el) {
    const r = el.getBoundingClientRect();
    return r.bottom > 0 && r.right > 0 && r.top < H && r.left < W;
  }
  function roleOf(el) {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (tag === 'a' && el.hasAttribute('href')) return 'link';
    if (tag === 'button' || (tag === 'input' && ['button','submit','reset'].includes(type))) return 'button';
    if (tag === 'input' && (type === 'checkbox')) return 'checkbox';
    if (tag === 'input' && (type === 'radio')) return 'radio';
    if (tag === 'input' || tag === 'textarea' || el.isContentEditable) return 'textbox';
    if (tag === 'select') return 'combobox';
    if (tag === 'option') return 'option';
    if (tag === 'img') return 'img';
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (tag === 'nav') return 'navigation';
    if (tag === 'main') return 'main';
    if (tag === 'dialog') return 'dialog';
    if (tag === 'progress') return 'progressbar';
    return '';
  }
  function accName(el) {
    const aria = el.getAttribute('aria-label');
    if (aria) return aria.trim();
    const labelledby = el.getAttribute('aria-labelledby');
    if (labelledby) {
      const target = doc.getElementById(labelledby);
      if (target) return (target.textContent || '').trim();
    }
    const tag = el.tagName.toLowerCase();
    if (tag === 'img') return (el.getAttribute('alt') || '').trim();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      if (el.id) {
        const label = doc.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (label) return (label.textContent || '').trim();
      }
      const inner = el.getAttribute('placeholder') || el.getAttribute('title') || el.value;
      if (inner) return String(inner).trim();
      return '';
    }
    const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
    return text.slice(0, 160);
  }
  function cssPath(el) {
    if (el.id) return `#${CSS.escape(el.id)}`;
    const parts = [];
    let cur = el;
    let depth = 0;
    while (cur && cur.nodeType === 1 && depth < 6 && parts.length < 6) {
      let seg = cur.tagName.toLowerCase();
      if (cur.id) { parts.unshift(`#${CSS.escape(cur.id)} > ${seg}`.replace(` > ${seg}`, '')); break; }
      const parent = cur.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter((c) => c.tagName === cur.tagName);
        if (same.length > 1) seg += `:nth-of-type(${same.indexOf(cur) + 1})`;
      }
      parts.unshift(seg);
      cur = parent;
      depth += 1;
    }
    return parts.join(' > ');
  }
  function xpathOf(el) {
    const parts = [];
    let cur = el;
    let depth = 0;
    while (cur && cur.nodeType === 1 && depth < 8) {
      let seg = cur.tagName.toLowerCase();
      const parent = cur.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter((c) => c.tagName === cur.tagName);
        if (same.length > 1) seg += `[${same.indexOf(cur) + 1}]`;
      }
      parts.unshift(seg);
      cur = parent;
      depth += 1;
    }
    return '/' + parts.join('/');
  }
  const GENERIC = new Set(['div','span','section','article','main','header','footer','nav','ul','ol','li','form','label','p','tbody','tr','td','table','fieldset']);
  const INTERACTIVE = 'a[href],button,input,select,textarea,summary,details,[role],[onclick],[tabindex],[contenteditable="true"],[contenteditable=""]';
  let candidates = Array.from(doc.querySelectorAll(INTERACTIVE));
  candidates = candidates.filter((el) => isVisible(el) || args.includeHidden);
  candidates = candidates.filter((el) => {
    if (!GENERIC.has(el.tagName.toLowerCase())) return true;
    if (el.getAttribute('role') || el.hasAttribute('onclick') || el.hasAttribute('tabindex') || el.isContentEditable) return true;
    return !Array.from(el.querySelectorAll(INTERACTIVE)).some((child) => isVisible(child));
  });
  const elements = [];
  const refs = {};
  let idx = 0;
  for (const el of candidates) {
    if (elements.length >= maxElements) break;
    idx += 1;
    const ref = `e${idx}`;
    const role = roleOf(el);
    const tag = el.tagName.toLowerCase();
    const value = ('value' in el) ? String(el.value ?? '') : '';
    const descriptor = {
      ref,
      tag,
      role: role || undefined,
      name: accName(el) || undefined,
      text: undefined,
      value: value || undefined,
      disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true' || undefined,
      checked: ['checkbox','radio'].includes(role) ? !!el.checked : undefined,
      selector: cssPath(el),
      xpath: xpathOf(el),
      rect: rectOf(el),
      inViewport: inViewport(el),
      parentRef: undefined,
      framePath: undefined,
      attributes: undefined,
    };
    if (['h1','h2','h3','h4','h5','h6','p','li','td','th','span','strong','em','blockquote'].includes(tag)) {
      const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (t) descriptor.text = t.slice(0, 120);
    }
    refs[ref] = descriptor.selector;
    elements.push(descriptor);
  }
  // Parent refs: nearest collected interactive ancestor.
  const indexByEl = new Map();
  candidates.slice(0, elements.length).forEach((el, i) => indexByEl.set(el, i));
  for (const [el, i] of indexByEl) {
    let anc = el.parentElement;
    while (anc) {
      const ancIndex = indexByEl.get(anc);
      if (ancIndex !== undefined) { elements[i].parentRef = elements[ancIndex].ref; break; }
      anc = anc.parentElement;
    }
  }
  // Semantic DOM outline (visible, text-bearing leaves first).
  const dom = [];
  let domTruncated = false;
  const walker = doc.createTreeWalker(doc.body || doc.documentElement, NodeFilter.SHOW_ELEMENT);
  let node = walker.currentNode;
  while (node) {
    if (dom.length >= maxDom) { domTruncated = true; break; }
    const el = node;
    if (el instanceof Element && isVisible(el)) {
      const direct = Array.from(el.childNodes)
        .filter((n) => n.nodeType === 3)
        .map((n) => (n.textContent || '').replace(/\s+/g, ' ').trim())
        .join(' ')
        .trim();
      const tag = el.tagName.toLowerCase();
      const role = roleOf(el);
      if (direct || role) {
        dom.push({
          tag,
          depth: Math.min(depthOf(el), 12),
          inViewport: inViewport(el),
          role: role || undefined,
          name: role ? accName(el) || undefined : undefined,
          text: direct ? direct.slice(0, 200) : undefined,
        });
      }
    }
    node = walker.nextNode();
  }
  function depthOf(el) {
    let d = 0;
    let cur = el;
    while (cur && cur !== doc.body && cur.parentElement) { cur = cur.parentElement; d += 1; }
    return d;
  }
  return {
    url: location.href,
    title: doc.title || '',
    dom,
    domTruncated,
    elements,
    truncated: idx > elements.length,
  };
};
"""

_INTERACTIVE_AT_POINT_JS = r"""
(args) => {
  const el = document.elementFromPoint(args.x, args.y);
  if (!(el instanceof Element)) return null;
  let target = el;
  const interactive = target.closest('a[href],button,input,select,textarea,[role],[onclick],[tabindex]');
  if (interactive) target = interactive;
  const r = target.getBoundingClientRect();
  return {
    tag: target.tagName.toLowerCase(),
    role: target.getAttribute('role') || undefined,
    name: (target.getAttribute('aria-label') || target.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120) || undefined,
    rect: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
    selector: target.id ? `#${CSS.escape(target.id)}` : target.tagName.toLowerCase(),
    xpath: undefined,
    inViewport: true,
  };
};
"""


# ---------------------------------------------------------------------------
# Screencast server (wire-compatible with the agent-browser CLI stream)
# ---------------------------------------------------------------------------


class _StreamServer:
    """Per-session CDP screencast → WebSocket broadcaster."""

    def __init__(self) -> None:
        self.server: Any = None
        self.port: int = 0
        self.clients: set[Any] = set()

    async def start(self, session: "_Session", tid: str) -> None:
        import websockets

        async def handler(ws: Any) -> None:
            self.clients.add(ws)
            logger.info("browser engine stream client connected thread=%s total=%s", tid, len(self.clients))
            try:
                await ws.wait_closed()
            finally:
                self.clients.discard(ws)
                logger.info("browser engine stream client left thread=%s total=%s", tid, len(self.clients))
                await session.maybe_stop_screencast()

        self.server = await websockets.serve(handler, "127.0.0.1", 0, max_size=32 * 1024 * 1024)
        self.port = int(self.server.sockets[0].getsockname()[1])
        logger.info("browser engine stream server up thread=%s port=%s", tid, self.port)

    async def broadcast(self, payload: dict[str, Any]) -> None:
        if not self.clients:
            return
        message = json.dumps(payload, ensure_ascii=False)
        tasks = []
        for ws in list(self.clients):
            tasks.append(asyncio.create_task(self._send(ws, message)))
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    @staticmethod
    async def _send(ws: Any, message: str) -> None:
        try:
            await ws.send(message)
        except Exception:
            pass


class _Session:
    """State for one thread's browser. Only touched on the engine loop."""

    def __init__(self, key: str, tid: str) -> None:
        self.key = key
        self.tid = tid
        self.browser: Any = None
        self.context: Any = None
        self.page: Any = None
        self.attached = False  # True → connect_over_cdp (browser outlives the session)
        self.launched = False  # True → we own a persistent context (close it on dispose)
        self.refs: dict[str, str] = {}
        self.ref_meta: dict[str, dict[str, Any]] = {}
        self.next_ref_index = 0
        self.last_dialog: dict[str, Any] | None = None
        self.last_url = ""
        self.last_used = time.time()
        self.stream = _StreamServer()
        self.cdp: Any = None
        self.screencasting = False

    # -- screencast lifecycle ------------------------------------------------

    async def ensure_screencast(self) -> bool:
        if self.screencasting or self.page is None:
            return self.screencasting
        try:
            if self.cdp is None:
                self.cdp = await self.context.new_cdp_session(self.page)
            await self.cdp.send(
                "Page.startScreencast",
                {
                    "format": "jpeg",
                    "quality": _STREAM_JPEG_QUALITY,
                    "maxWidth": _STREAM_MAX_W,
                    "maxHeight": _STREAM_MAX_H,
                    "everyNthFrame": _STREAM_EVERY_NTH_FRAME,
                },
            )
            self.cdp.on("Page.screencastFrame", self._on_screencast_frame)
            self.screencasting = True
            return True
        except Exception as exc:
            logger.warning("screencast start failed thread=%s: %s", self.tid, exc)
            return False

    async def maybe_stop_screencast(self) -> None:
        if self.screencasting and not self.stream.clients:
            try:
                if self.cdp is not None:
                    await self.cdp.send("Page.stopScreencast")
                self.screencasting = False
            except Exception:
                self.screencasting = False

    def _on_screencast_frame(self, event: dict[str, Any]) -> None:
        metadata = event.get("metadata") or {}
        params = event.get("sessionId")
        payload = {
            "type": "frame",
            "data": event.get("data", ""),
            "format": "jpeg",
            "metadata": {
                "deviceWidth": metadata.get("deviceWidth"),
                "deviceHeight": metadata.get("deviceHeight"),
                "pageScaleFactor": metadata.get("pageScaleFactor"),
                "offsetTop": metadata.get("offsetTop"),
                "scrollOffsetX": metadata.get("scrollOffsetX"),
                "scrollOffsetY": metadata.get("scrollOffsetY"),
            },
        }
        asyncio.get_running_loop().create_task(self.stream.broadcast(payload))
        if self.cdp is not None and params is not None:
            asyncio.get_running_loop().create_task(
                self._ack_screencast(params)
            )

    async def _ack_screencast(self, session_id: Any) -> None:
        try:
            await self.cdp.send("Page.screencastFrameAck", {"sessionId": session_id})
        except Exception:
            pass


# ---------------------------------------------------------------------------
# Engine
# ---------------------------------------------------------------------------


class BrowserEngine:
    """Single asyncio-loop owner for all browser sessions."""

    def __init__(self) -> None:
        self._loop: asyncio.AbstractEventLoop | None = None
        self._ready = threading.Event()
        self._thread: threading.Thread | None = None
        self._start_lock = threading.Lock()
        self._pw: Any = None
        self._sessions: dict[str, _Session] = {}
        self._stopped = False

    # -- lifecycle -----------------------------------------------------------

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
        from playwright.async_api import async_playwright

        async with async_playwright() as pw:
            self._pw = pw
            self._loop = asyncio.get_running_loop()
            self._ready.set()
            logger.info("browser engine ready")
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

    # -- sessions ------------------------------------------------------------

    async def _get_session(self, tid: str) -> _Session:
        from evoflow.tools.builtins.browser_embed_cdp import get_thread_cdp_url
        from evoflow.tools.builtins.browser_stream import browser_cdp_url, browser_headed_enabled
        from evoflow.utils.bundled_tools import find_chrome_executable

        key = _safe_thread_segment(tid)
        session = self._sessions.get(key)
        if session and session.page and not session.page.is_closed():
            session.last_used = time.time()
            return session
        if session:
            await self._dispose_session(session)
            self._sessions.pop(key, None)

        session = _Session(key, tid)
        cdp_url = get_thread_cdp_url(tid) or browser_cdp_url()
        if cdp_url:
            browser = await self._pw.chromium.connect_over_cdp(cdp_url)
            context = browser.contexts[0] if browser.contexts else await browser.new_context()
            pages = [p for p in context.pages if not p.is_closed()]
            page = pages[-1] if pages else await context.new_page()
            session.browser = browser
            session.context = context
            session.page = page
            session.attached = True
            logger.info("browser engine attached over CDP thread=%s url=%s", tid, cdp_url)
        else:
            headed = browser_headed_enabled()
            executable = find_chrome_executable()
            launch_kwargs: dict[str, Any] = {
                "headless": not headed,
                "args": ["--disable-blink-features=AutomationControlled", "--no-first-run"],
            }
            if executable:
                launch_kwargs["executable_path"] = executable
            profile_root = os.getenv(
                "EVOFLOW_BROWSER_PROFILE_ROOT",
                str(os.path.expanduser("~/.evoflow/browser-profiles")),
            )
            profile_dir = os.path.join(profile_root, key)
            os.makedirs(profile_dir, exist_ok=True)
            try:
                context = await self._pw.chromium.launch_persistent_context(
                    profile_dir, **launch_kwargs
                )
            except Exception as exc:
                logger.warning("browser launch with bundled chrome failed: %s", exc)
                launch_kwargs.pop("executable_path", None)
                try:
                    context = await self._pw.chromium.launch_persistent_context(
                        profile_dir, **launch_kwargs
                    )
                except Exception as exc2:
                    raise RuntimeError(_BROWSER_OPTIONS_HINT) from exc2
            pages = [p for p in context.pages if not p.is_closed()]
            page = pages[0] if pages else await context.new_page()
            try:
                await page.set_viewport_size(
                    {"width": DEFAULT_AGENT_BROWSER_VIEWPORT["width"], "height": DEFAULT_AGENT_BROWSER_VIEWPORT["height"]}
                )
            except Exception:
                pass
            session.browser = None
            session.context = context
            session.page = page
            session.attached = False
            session.launched = True
            logger.info("browser engine launched chromium thread=%s headed=%s", tid, headed)

        await self._install_dialog_recorder(session)
        await self.stream_ensure(session)
        self._sessions[key] = session
        return session

    async def _install_dialog_recorder(self, session: _Session) -> None:
        async def _on_dialog(dialog: Any) -> None:
            session.last_dialog = {
                "type": dialog.type,
                "message": dialog.message,
                "defaultPrompt": dialog.default_value or None,
            }
            try:
                await dialog.accept()
            except Exception:
                pass

        try:
            session.page.on("dialog", _on_dialog)
        except Exception:
            pass

    async def _dispose_session(self, session: _Session) -> None:
        try:
            if session.cdp is not None:
                await session.cdp.detach()
        except Exception:
            pass
        try:
            if session.stream.server is not None:
                await session.stream.server.close()
        except Exception:
            pass
        try:
            if session.launched and session.context is not None:
                await session.context.close()  # persistent context owns the browser process
            elif session.attached and session.browser is not None:
                await session.browser.close()  # disconnects; the real browser stays alive
        except Exception:
            pass

    async def _reap_loop(self) -> None:
        while True:
            await asyncio.sleep(60)
            now = time.time()
            for key, session in list(self._sessions.items()):
                if now - session.last_used > _SESSION_TTL_SEC:
                    logger.info("browser engine reaping idle session key=%s", key)
                    await self._dispose_session(session)
                    self._sessions.pop(key, None)

    # -- public API (thread-safe) --------------------------------------------

    def execute(self, thread_id: str, command: dict[str, Any], timeout: float) -> dict[str, Any]:
        started = time.time()
        method = str(command.get("method") or "")
        logger.info(
            "browser_engine.execute thread=%s method=%s timeout=%s",
            thread_id,
            method,
            timeout,
        )

        async def _run() -> dict[str, Any]:
            session = await self._get_session(thread_id)
            result = await self._dispatch(session, command)
            if not result.ok and result.error and result.error.code in (
                ErrorCode.RENDERER_UNREACHABLE,
                ErrorCode.BACKEND_UNAVAILABLE,
            ):
                # One retry on a fresh session (crash recovery), side effect uncertain.
                key = session.key
                await self._dispose_session(session)
                self._sessions.pop(key, None)
                session = await self._get_session(thread_id)
                last_url = getattr(session, "last_url", "")
                result = await self._dispatch(session, command)
                if result.ok and last_url and command.get("method") != "navigate":
                    result.error = None
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

    def stream_port(self, thread_id: str) -> int | None:
        key = _safe_thread_segment(thread_id)
        session = self._sessions.get(key)
        return session.stream.port if session and session.stream.port else None

    def has_session(self, thread_id: str) -> bool:
        key = _safe_thread_segment(thread_id)
        session = self._sessions.get(key)
        return bool(session and session.page and not session.page.is_closed())

    def close_session(self, thread_id: str) -> None:
        async def _close() -> None:
            key = _safe_thread_segment(thread_id)
            session = self._sessions.pop(key, None)
            if session:
                await self._dispose_session(session)

        try:
            self._submit(_close, 15)
        except Exception as exc:
            logger.warning("browser engine close session failed: %s", exc)

    # -- command dispatch ----------------------------------------------------

    async def stream_ensure(self, session: _Session) -> None:
        if session.stream.server is None:
            await session.stream.start(session, session.tid)

    async def _dispatch(self, session: _Session, command: dict[str, Any]) -> CommandResult:
        from playwright.async_api import Error as PlaywrightError
        from playwright.async_api import TimeoutError as PlaywrightTimeoutError

        session.last_used = time.time()
        method = str(command.get("method") or "")
        try:
            handler = getattr(self, f"_cmd_{method}", None)
            if handler is None:
                return fail(ErrorCode.CAPABILITY_UNSUPPORTED, f"unsupported browser method '{method}'")
            return await handler(session, command)
        except PlaywrightTimeoutError as exc:
            return fail(ErrorCode.TIMEOUT, f"operation timed out: {exc}")
        except PlaywrightError as exc:
            msg = str(exc)
            lowered = msg.lower()
            if "target closed" in lowered or "browser has been closed" in lowered or "page.is_closed" in lowered:
                return fail(ErrorCode.RENDERER_UNREACHABLE, msg, side_effect="uncertain")
            if "ref_not_found" in lowered:
                return fail(ErrorCode.REF_NOT_FOUND, msg)
            return fail(ErrorCode.EXECUTION_ERROR, msg)
        except RuntimeError as exc:
            return fail(ErrorCode.BACKEND_UNAVAILABLE, str(exc))
        except Exception as exc:
            logger.warning("browser engine dispatch error method=%s: %s", method, exc, exc_info=True)
            return fail(ErrorCode.EXECUTION_ERROR, str(exc))

    # -- page helpers --------------------------------------------------------

    async def _page_state(self, session: _Session) -> PageState:
        page = session.page
        url = page.url or ""
        try:
            info = await page.evaluate(
                "() => ({title: document.title || '', sx: window.scrollX || 0, sy: window.scrollY || 0,"
                " vw: window.innerWidth || 0, vh: window.innerHeight || 0, hl: history.length || 0})"
            )
        except Exception:
            info = {"title": "", "sx": 0, "sy": 0, "vw": 0, "vh": 0, "hl": 0}
        return PageState(
            url=url,
            title=str(info.get("title", "")),
            canGoBack=bool(info.get("hl", 0) > 1),
            canGoForward=False,
            scrollX=float(info.get("sx") or 0),
            scrollY=float(info.get("sy") or 0),
            viewportWidth=float(info.get("vw") or 0) or None,
            viewportHeight=float(info.get("vh") or 0) or None,
        )

    def _resolve_ref(self, session: _Session, ref: str) -> str:
        selector = session.refs.get(ref)
        if not selector:
            raise RuntimeError(f"ref_not_found: unknown or stale ref '{ref}' (take a fresh snapshot)")
        return selector

    async def _element_of_ref(self, session: _Session, ref: str) -> SnapshotElement | None:
        """Element descriptor for a snapshot ref (ZCode parity: results carry what was acted on)."""
        meta = session.ref_meta.get(ref)
        if not meta:
            return None
        try:
            return SnapshotElement.model_validate(meta)
        except Exception:
            return None

    async def _element_at_point(self, session: _Session, x: float, y: float) -> SnapshotElement | None:
        try:
            raw = await session.page.evaluate(
                _INTERACTIVE_AT_POINT_JS, {"x": x, "y": y}
            )
        except Exception:
            return None
        if not raw:
            return None
        session.next_ref_index += 1
        ref = f"e{session.next_ref_index}"
        raw["ref"] = ref
        raw["xpath"] = raw.get("xpath") or ""
        selector = str(raw.get("selector") or "")
        session.refs[ref] = selector
        session.ref_meta[ref] = raw
        try:
            return SnapshotElement.model_validate(raw)
        except Exception:
            return None

    async def _take_snapshot(
        self, session: _Session, *, max_elements: int | None = None, include_hidden: bool = False
    ) -> BrowserSnapshot:
        raw = await session.page.evaluate(
            _SNAPSHOT_JS,
            {
                "maxElements": max_elements or _SNAPSHOT_MAX_ELEMENTS,
                "maxDom": _SNAPSHOT_MAX_DOM,
                "includeHidden": bool(include_hidden),
            },
        )
        session.refs = {el["ref"]: el["selector"] for el in raw.get("elements", [])}
        session.ref_meta = {el["ref"]: el for el in raw.get("elements", [])}
        session.next_ref_index = len(session.refs)
        session.last_url = raw.get("url") or session.page.url
        return BrowserSnapshot.model_validate(raw)

    # -- command handlers ----------------------------------------------------

    async def _cmd_navigate(self, session: _Session, command: dict[str, Any]) -> CommandResult:
        url = str(command.get("url") or "").strip()
        if not url:
            return fail(ErrorCode.EXECUTION_ERROR, "navigate requires url")
        if not url.startswith(("http://", "https://", "file://", "about:", "data:")):
            url = f"https://{url}"
        await session.page.goto(url, wait_until="load", timeout=_NAVIGATE_TIMEOUT_MS)
        session.last_url = session.page.url
        return CommandResult(ok=True, state=await self._page_state(session))

    async def _cmd_back(self, session: _Session, command: dict[str, Any]) -> CommandResult:
        await session.page.go_back(wait_until="load", timeout=_NAVIGATE_TIMEOUT_MS)
        return CommandResult(ok=True, state=await self._page_state(session))

    async def _cmd_forward(self, session: _Session, command: dict[str, Any]) -> CommandResult:
        await session.page.go_forward(wait_until="load", timeout=_NAVIGATE_TIMEOUT_MS)
        return CommandResult(ok=True, state=await self._page_state(session))

    async def _cmd_reload(self, session: _Session, command: dict[str, Any]) -> CommandResult:
        await session.page.reload(wait_until="load", timeout=_NAVIGATE_TIMEOUT_MS)
        return CommandResult(ok=True, state=await self._page_state(session))

    async def _cmd_snapshot(self, session: _Session, command: dict[str, Any]) -> CommandResult:
        snapshot = await self._take_snapshot(
            session,
            max_elements=command.get("maxElements"),
            include_hidden=bool(command.get("includeHidden")),
        )
        return CommandResult(ok=True, snapshot=snapshot, state=await self._page_state(session))

    async def _cmd_click(self, session: _Session, command: dict[str, Any]) -> CommandResult:
        page = session.page
        button = command.get("button") or "left"
        modifiers = command.get("modifiers") or []
        ref = command.get("ref")
        element: SnapshotElement | None = None
        if ref:
            selector = self._resolve_ref(session, str(ref))
            element = await self._element_of_ref(session, str(ref))
            locator = page.locator(selector).first
            if command.get("doubleClick"):
                await locator.dblclick(button=button, modifiers=modifiers)
            else:
                await locator.click(button=button, modifiers=modifiers)
        elif command.get("x") is not None and command.get("y") is not None:
            x, y = float(command["x"]), float(command["y"])
            await page.mouse.click(x, y, button=button, click_count=2 if command.get("doubleClick") else 1)
            element = await self._element_at_point(session, x, y)
        else:
            return fail(ErrorCode.EXECUTION_ERROR, "click requires ref or x/y")
        return CommandResult(ok=True, element=element, state=await self._page_state(session))

    async def _cmd_fill(self, session: _Session, command: dict[str, Any]) -> CommandResult:
        ref = command.get("ref")
        if not ref:
            return fail(ErrorCode.EXECUTION_ERROR, "fill requires ref")
        selector = self._resolve_ref(session, str(ref))
        element = await self._element_of_ref(session, str(ref))
        await session.page.locator(selector).first.fill(str(command.get("value") or ""))
        return CommandResult(ok=True, element=element, state=await self._page_state(session))

    async def _cmd_type(self, session: _Session, command: dict[str, Any]) -> CommandResult:
        text = str(command.get("text") or "")
        ref = command.get("ref")
        element: SnapshotElement | None = None
        if ref:
            selector = self._resolve_ref(session, str(ref))
            element = await self._element_of_ref(session, str(ref))
            await session.page.locator(selector).first.click()
        await session.page.keyboard.type(text)
        return CommandResult(ok=True, element=element, state=await self._page_state(session))

    async def _cmd_press(self, session: _Session, command: dict[str, Any]) -> CommandResult:
        key = str(command.get("key") or "").strip()
        if not key:
            return fail(ErrorCode.EXECUTION_ERROR, "press requires key")
        page = session.page
        ref = command.get("ref")
        element: SnapshotElement | None = None
        if ref:
            selector = self._resolve_ref(session, str(ref))
            element = await self._element_of_ref(session, str(ref))
            await page.locator(selector).first.focus()
        for mod in command.get("modifiers") or []:
            await page.keyboard.down("ControlOrMeta" if mod == "ControlOrMeta" else mod)
        await page.keyboard.press(key)
        for mod in reversed(command.get("modifiers") or []):
            await page.keyboard.up("ControlOrMeta" if mod == "ControlOrMeta" else mod)
        return CommandResult(ok=True, element=element, state=await self._page_state(session))

    async def _cmd_scroll(self, session: _Session, command: dict[str, Any]) -> CommandResult:
        page = session.page
        direction = str(command.get("direction") or "down").lower()
        amount = int(command.get("amount") or 800)
        ref = command.get("ref")
        element: SnapshotElement | None = None
        if ref:
            selector = self._resolve_ref(session, str(ref))
            element = await self._element_of_ref(session, str(ref))
            await page.locator(selector).first.hover()
        delta_y = amount if direction in ("down", "right") else -amount
        delta_x = amount if direction == "right" else (-amount if direction == "left" else 0)
        await page.mouse.wheel(delta_x, delta_y)
        return CommandResult(ok=True, element=element, state=await self._page_state(session))

    async def _cmd_hover(self, session: _Session, command: dict[str, Any]) -> CommandResult:
        page = session.page
        ref = command.get("ref")
        element: SnapshotElement | None = None
        if ref:
            selector = self._resolve_ref(session, str(ref))
            element = await self._element_of_ref(session, str(ref))
            await page.locator(selector).first.hover(modifiers=command.get("modifiers") or [])
        elif command.get("x") is not None and command.get("y") is not None:
            x, y = float(command["x"]), float(command["y"])
            await page.mouse.move(x, y)
            element = await self._element_at_point(session, x, y)
        else:
            return fail(ErrorCode.EXECUTION_ERROR, "hover requires ref or x/y")
        return CommandResult(ok=True, element=element, state=await self._page_state(session))

    async def _cmd_select(self, session: _Session, command: dict[str, Any]) -> CommandResult:
        ref = command.get("ref")
        values = command.get("values") or []
        if not ref:
            return fail(ErrorCode.EXECUTION_ERROR, "select requires ref")
        selector = self._resolve_ref(session, str(ref))
        element = await self._element_of_ref(session, str(ref))
        await session.page.locator(selector).first.select_option(values)
        return CommandResult(ok=True, element=element, state=await self._page_state(session))

    async def _cmd_check(self, session: _Session, command: dict[str, Any]) -> CommandResult:
        ref = command.get("ref")
        if not ref:
            return fail(ErrorCode.EXECUTION_ERROR, "check requires ref")
        selector = self._resolve_ref(session, str(ref))
        element = await self._element_of_ref(session, str(ref))
        await session.page.locator(selector).first.set_checked(bool(command.get("checked", True)))
        return CommandResult(ok=True, element=element, state=await self._page_state(session))

    async def _cmd_drag(self, session: _Session, command: dict[str, Any]) -> CommandResult:
        page = session.page
        start = None
        end = None
        if command.get("fromRef"):
            meta = session.ref_meta.get(str(command["fromRef"])) or {}
            rect = meta.get("rect") or {}
            start = (rect.get("x", 0) + rect.get("width", 0) / 2, rect.get("y", 0) + rect.get("height", 0) / 2)
        elif command.get("from"):
            start = (float(command["from_"]["x"]), float(command["from_"]["y"]))
        if command.get("toRef"):
            meta = session.ref_meta.get(str(command["toRef"])) or {}
            rect = meta.get("rect") or {}
            end = (rect.get("x", 0) + rect.get("width", 0) / 2, rect.get("y", 0) + rect.get("height", 0) / 2)
        elif command.get("to"):
            end = (float(command["to"]["x"]), float(command["to"]["y"]))
        if not start or not end:
            return fail(ErrorCode.EXECUTION_ERROR, "drag requires from/to (ref or coordinates)")
        await page.mouse.move(start[0], start[1])
        await page.mouse.down()
        await page.mouse.move(end[0], end[1], steps=12)
        await page.mouse.up()
        return CommandResult(ok=True, state=await self._page_state(session))

    async def _cmd_screenshot(self, session: _Session, command: dict[str, Any]) -> CommandResult:
        page = session.page
        kwargs: dict[str, Any] = {"type": "png", "timeout": 20000}
        if command.get("fullPage"):
            kwargs["full_page"] = True
        clip = command.get("clip")
        if clip:
            kwargs["clip"] = {
                "x": float(clip["x"]),
                "y": float(clip["y"]),
                "width": float(clip["width"]),
                "height": float(clip["height"]),
            }
        png = await page.screenshot(**kwargs)
        return CommandResult(
            ok=True,
            image={"base64": base64.b64encode(png).decode("ascii"), "mimeType": "image/png"},
            state=await self._page_state(session),
        )

    async def _cmd_getState(self, session: _Session, command: dict[str, Any]) -> CommandResult:
        state = await self._page_state(session)
        dialog = DialogInfo.model_validate(session.last_dialog) if session.last_dialog else None
        return CommandResult(ok=True, state=state, dialog=dialog)

    async def _cmd_getDialog(self, session: _Session, command: dict[str, Any]) -> CommandResult:
        dialog = DialogInfo.model_validate(session.last_dialog) if session.last_dialog else None
        return CommandResult(ok=True, dialog=dialog)

    async def _cmd_handleDialog(self, session: _Session, command: dict[str, Any]) -> CommandResult:
        session.last_dialog = None
        return CommandResult(ok=True, state=await self._page_state(session))

    async def _cmd_elementInfo(self, session: _Session, command: dict[str, Any]) -> CommandResult:
        if command.get("x") is None or command.get("y") is None:
            return fail(ErrorCode.EXECUTION_ERROR, "elementInfo requires x/y viewport coordinates")
        raw = await session.page.evaluate(
            _INTERACTIVE_AT_POINT_JS, {"x": float(command["x"]), "y": float(command["y"])}
        )
        if not raw:
            return fail(ErrorCode.REF_NOT_FOUND, f"no element at ({command['x']}, {command['y']})")
        session.next_ref_index += 1
        ref = f"e{session.next_ref_index}"
        session.refs[ref] = str(raw.get("selector") or "")
        session.ref_meta[ref] = raw
        raw["ref"] = ref
        raw["xpath"] = raw.get("xpath") or ""
        return CommandResult(ok=True, element=SnapshotElement.model_validate(raw))

    async def _cmd_evaluate(self, session: _Session, command: dict[str, Any]) -> CommandResult:
        expression = str(command.get("expression") or "").strip()
        if not expression:
            return fail(ErrorCode.EXECUTION_ERROR, "evaluate requires expression")
        value = await session.page.evaluate(expression)
        return CommandResult(ok=True, value=value)

    async def _cmd_waitFor(self, session: _Session, command: dict[str, Any]) -> CommandResult:
        page = session.page
        timeout_ms = int(command.get("timeoutMs") or 10000)
        selector = command.get("selector")
        text = command.get("text")
        text_gone = command.get("textGone")
        if selector:
            await page.wait_for_selector(selector, timeout=timeout_ms)
        deadline = time.time() + timeout_ms / 1000

        async def _text_present(target: str) -> bool:
            try:
                return bool(
                    await page.evaluate(
                        "(t) => (document.body ? document.body.innerText.includes(t) : false)", target
                    )
                )
            except Exception:
                return False

        while text and time.time() < deadline:
            if await _text_present(str(text)):
                break
            await asyncio.sleep(0.2)
        while text_gone and time.time() < deadline:
            if not await _text_present(str(text_gone)):
                break
            await asyncio.sleep(0.2)
        state = await self._page_state(session)
        if (text and not await _text_present(str(text))) or (
            text_gone and await _text_present(str(text_gone))
        ):
            return fail(ErrorCode.TIMEOUT, f"waitFor timed out after {timeout_ms}ms")
        return CommandResult(ok=True, state=state)

    async def _cmd_close(self, session: _Session, command: dict[str, Any]) -> CommandResult:
        if session.attached:
            # Embedded/shared browser: only disconnect the session — the page the
            # user sees in the panel must stay alive.
            self._sessions.pop(session.key, None)
            try:
                if session.cdp is not None:
                    await session.cdp.detach()
                if session.stream.server is not None:
                    await session.stream.server.close()
            except Exception:
                pass
            return CommandResult(ok=True)
        try:
            await session.context.close()
        except Exception:
            pass
        self._sessions.pop(session.key, None)
        return CommandResult(ok=True)

    async def _cmd_list(self, session: _Session, command: dict[str, Any]) -> CommandResult:
        tabs: list[TabSummary] = []
        if session.context is not None:
            for index, page in enumerate([p for p in session.context.pages if not p.is_closed()]):
                viewport = page.viewport_size or {}
                tabs.append(
                    TabSummary(
                        tabId=f"p{index}",
                        url=page.url or "",
                        title=await page.title() if not page.is_closed() else "",
                        viewport={
                            "width": int(viewport.get("width", 0)),
                            "height": int(viewport.get("height", 0)),
                        },
                        active=page is session.page,
                    )
                )
        return CommandResult(ok=True, tabs=tabs)

    async def _cmd_viewportSet(self, session: _Session, command: dict[str, Any]) -> CommandResult:
        width = int(command.get("width") or 0)
        height = int(command.get("height") or 0)
        if not width or not height:
            return fail(ErrorCode.EXECUTION_ERROR, "viewportSet requires width/height")
        if session.attached:
            return fail(
                ErrorCode.CAPABILITY_UNSUPPORTED,
                "viewport is controlled by the embedded panel for attached browsers",
            )
        await session.page.set_viewport_size({"width": width, "height": height})
        return CommandResult(ok=True, state=await self._page_state(session))


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
