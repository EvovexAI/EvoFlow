"""Unified browser tool — in-process Playwright engine driving the panel's WebView2.

Single tool, multi-action surface (unchanged for the agent):
``open | snapshot | click | fill | press | scroll | screenshot | back | close``.

The tool drives the page through :mod:`evoflow.tools.builtins.browser_engine` —
the cross-process dispatcher speaking the ZCode browser command contract, with
the panel's WebView2 as the one and only browser (ZCode parity: the user and
the agent share the same rendered page; there is no second browser, no
screencast, and no bundled CLI).

Deferred under agent mode: activate agent, then ``tool_search(query='select:browser')``.
"""

from __future__ import annotations

import json
import logging
import os
import threading
from typing import Any, Literal

from langchain.tools import ToolRuntime, tool
from langgraph.typing import ContextT

from evoflow.tools.builtins.browser_screenshot_store import (
    format_screenshot_tool_result,
    save_screenshot_png,
)

logger = logging.getLogger(__name__)

BrowserAction = Literal[
    "open",
    "snapshot",
    "click",
    "fill",
    "press",
    "scroll",
    "screenshot",
    "back",
    "close",
]

_DEFAULT_SESSION = "evoflow"
_ACTION_TIMEOUT = float(os.getenv("EVOFLOW_BROWSER_CLI_TIMEOUT", "120"))
_OPEN_TIMEOUT = float(os.getenv("EVOFLOW_BROWSER_OPEN_TIMEOUT", "35"))
_state_lock = threading.Lock()
_last_page_url: dict[str, str] = {}


def _get_thread_id(runtime: ToolRuntime[ContextT, Any]) -> str:
    ctx = getattr(runtime, "context", None)
    tid = None
    if ctx is not None:
        # ``context`` may be a mapping or a dataclass-like runtime context.
        if isinstance(ctx, dict):
            tid = ctx.get("thread_id")
        else:
            tid = getattr(ctx, "thread_id", None)
    if not tid:
        config = getattr(runtime, "config", None)
        configurable = config.get("configurable", {}) if isinstance(config, dict) else {}
        if isinstance(configurable, dict):
            tid = configurable.get("thread_id")
    if not tid:
        state = getattr(runtime, "state", None)
        if isinstance(state, dict):
            tid = state.get("thread_id")
    if tid:
        from evoflow.tools.builtins.browser_screenshot_store import _safe_thread_segment

        return _safe_thread_segment(str(tid))
    logger.warning(
        "browser tool: no thread_id in runtime context/config — falling back to %s. "
        "The live preview WS path will not match the panel's thread.",
        _DEFAULT_SESSION,
    )
    return _DEFAULT_SESSION


def _session_name(thread_id: str) -> str:
    tid = str(thread_id or "").strip()
    if not tid or tid in {"default", "__default__"}:
        return _DEFAULT_SESSION
    return f"{_DEFAULT_SESSION}-{tid}"[:64]


def _normalize_ref(ref: str | None) -> str | None:
    """Accept both ``@e2`` (legacy CLI style) and ``e2`` (engine contract style)."""
    value = str(ref or "").strip().lstrip("@")
    return value or None


# ---------------------------------------------------------------------------
# Engine dispatch (ZCode command contract → WebView2)
# ---------------------------------------------------------------------------

_ENGINE_UNAVAILABLE = (
    "Error: [backend_unavailable] Browser engine is disabled "
    "(EVOFLOW_BROWSER_ENGINE). The browser tool drives the EvoPanel embedded "
    "WebView2 and cannot fall back to an external CLI anymore."
)


def _engine_dispatch(thread_id: str, command: dict[str, Any], *, timeout: float) -> dict[str, Any]:
    from evoflow.tools.builtins.browser_engine import get_browser_engine

    return get_browser_engine().execute(thread_id, command, timeout=timeout)


_BROWSER_STEP_LABELS = {
    "open": "打开网页",
    "snapshot": "读取页面",
    "click": "点击元素",
    "fill": "填写输入",
    "type": "输入文本",
    "press": "按键",
    "scroll": "滚动页面",
    "hover": "悬停元素",
    "screenshot": "页面截图",
    "back": "后退",
    "close": "关闭浏览器",
}


def _step_desc(action: str, ref: str | None, element: dict[str, Any] | None) -> str:
    label = _BROWSER_STEP_LABELS.get(action, action)
    target = ""
    if element:
        name = str(element.get("name") or "").strip()
        role = str(element.get("role") or element.get("tag") or "").strip()
        if ref:
            target += f" [{ref}]"
        if name:
            target += f' {role} "{name}"' if role else f' "{name}"'
        elif role:
            target += f" {role}"
    elif ref:
        target = f" [{ref}]"
    return f"{label}{target}".strip()


def _format_step_result(action: str, result: dict[str, Any], *, ref: str | None = None) -> str:
    """Structured step output (ZCode parity): the chat UI renders this as a timeline step."""
    payload: dict[str, Any] = {
        "type": "browser_step",
        "ok": bool(result.get("ok")),
        "action": action,
    }
    if ref:
        payload["ref"] = ref
    if result.get("ok"):
        element = result.get("element") or {}
        slim_element = {
            key: element[key]
            for key in ("ref", "tag", "role", "name", "selector", "text")
            if element.get(key)
        }
        if slim_element:
            payload["element"] = slim_element
        state = result.get("state") or {}
        if state.get("url"):
            payload["url"] = state.get("url")
            payload["title"] = state.get("title") or ""
        payload["desc"] = _step_desc(action, ref, slim_element or None)
    else:
        error = result.get("error") or {}
        payload["error"] = {
            "code": str(error.get("code") or "execution_error"),
            "message": str(error.get("message") or ""),
        }
    return json.dumps(payload, ensure_ascii=False)


def _engine_error_message(result: dict[str, Any]) -> str | None:
    error = result.get("error") or {}
    message = str(error.get("message") or "").strip()
    code = str(error.get("code") or "").strip()
    if not message:
        return None
    return f"Error: [{code or 'execution_error'}] {message}"


def _remember_page_url(thread_id: str, url: str) -> None:
    page = str(url or "").strip()
    if not page:
        return
    with _state_lock:
        _last_page_url[thread_id] = page


def _current_page_url(thread_id: str) -> str:
    with _state_lock:
        return _last_page_url.get(thread_id, "")


# ---------------------------------------------------------------------------
# Actions — engine only
# ---------------------------------------------------------------------------


def _use_engine() -> bool:
    try:
        from evoflow.tools.builtins.browser_engine import browser_engine_enabled

        return browser_engine_enabled()
    except Exception:
        return False


def _engine_open(thread_id: str, url: str) -> str:
    result = _engine_dispatch(thread_id, {"method": "navigate", "url": url}, timeout=_OPEN_TIMEOUT)
    if not result.get("ok"):
        message = _engine_error_message(result)
        if message:
            logger.warning("browser open failed (engine) thread=%s: %s", thread_id, message)
        return message or "Error: browser open failed"
    _remember_page_url(thread_id, result["state"]["url"] if result.get("state") else url)
    from evoflow.tools.builtins.browser_stream import build_browser_live_metadata

    live = build_browser_live_metadata(thread_id, page_url=url)
    logger.info("browser open ok (engine) thread=%s url=%s", thread_id, url)
    return json.dumps(live, ensure_ascii=False)


def _engine_snapshot(thread_id: str) -> str:
    result = _engine_dispatch(thread_id, {"method": "snapshot"}, timeout=_ACTION_TIMEOUT)
    if not result.get("ok"):
        return _engine_error_message(result) or "Error: snapshot failed"
    snapshot = result.get("snapshot") or {}
    if not snapshot:
        return "Error: empty snapshot"
    from evoflow.tools.builtins.browser_contract import BrowserSnapshot, snapshot_to_text

    return snapshot_to_text(BrowserSnapshot.model_validate(snapshot))


def _engine_click(thread_id: str, ref: str) -> str:
    target = _normalize_ref(ref)
    result = _engine_dispatch(
        thread_id, {"method": "click", "ref": target}, timeout=_ACTION_TIMEOUT
    )
    if not result.get("ok"):
        return _engine_error_message(result) or "Error: click failed"
    return _format_step_result("click", result, ref=target)


def _engine_fill(thread_id: str, ref: str, text: str) -> str:
    target = _normalize_ref(ref)
    result = _engine_dispatch(
        thread_id,
        {"method": "fill", "ref": target, "value": str(text or "")},
        timeout=_ACTION_TIMEOUT,
    )
    if not result.get("ok"):
        return _engine_error_message(result) or "Error: fill failed"
    return _format_step_result("fill", result, ref=target)


def _engine_press(thread_id: str, key: str) -> str:
    result = _engine_dispatch(
        thread_id, {"method": "press", "key": str(key or "")}, timeout=_ACTION_TIMEOUT
    )
    if not result.get("ok"):
        return _engine_error_message(result) or "Error: press failed"
    return _format_step_result("press", result)


def _engine_scroll(thread_id: str, direction: str, amount: int) -> str:
    result = _engine_dispatch(
        thread_id,
        {"method": "scroll", "direction": str(direction or "down"), "amount": int(amount or 800)},
        timeout=_ACTION_TIMEOUT,
    )
    if not result.get("ok"):
        return _engine_error_message(result) or "Error: scroll failed"
    return _format_step_result("scroll", result)


def _engine_back(thread_id: str) -> str:
    result = _engine_dispatch(thread_id, {"method": "back"}, timeout=_ACTION_TIMEOUT)
    if not result.get("ok"):
        return _engine_error_message(result) or "Error: back failed"
    return _format_step_result("back", result)


def _engine_screenshot(thread_id: str, *, full_page: bool) -> str:
    result = _engine_dispatch(
        thread_id, {"method": "screenshot", "fullPage": bool(full_page)}, timeout=_ACTION_TIMEOUT
    )
    if not result.get("ok"):
        return _engine_error_message(result) or "Error: screenshot failed"
    image = result.get("image") or {}
    base64_png = str(image.get("base64") or "")
    if not base64_png:
        return "Error: screenshot returned no image"
    import base64

    png_bytes = base64.b64decode(base64_png)
    if not png_bytes:
        return "Error: screenshot file empty"
    meta = save_screenshot_png(
        thread_id,
        png_bytes,
        page_url=_current_page_url(thread_id),
        full_page=full_page,
    )
    return format_screenshot_tool_result(thread_id, meta)


def _engine_close(thread_id: str) -> str | None:
    try:
        from evoflow.tools.builtins.browser_engine import get_browser_engine

        get_browser_engine().close_session(thread_id)
    except Exception as exc:
        logger.debug("engine close session failed thread=%s: %s", thread_id, exc)
    return None


@tool("browser", parse_docstring=True)
def browser_tool(
    runtime: ToolRuntime[ContextT, Any],
    action: BrowserAction,
    *,
    url: str | None = None,
    ref: str | None = None,
    text: str | None = None,
    key: str | None = None,
    direction: str | None = None,
    amount: int | None = None,
    full_page: bool = False,
) -> str:
    """Interactive browser automation (deferred under agent mode).

    Activate agent mode, then load this tool with tool_search(query="select:browser").

    Drives the EvoPanel embedded WebView2 (in-process engine + CDP): the agent
    controls the same page the user sees in the browser side panel. Actions
    return refs like ``e1, e2, …`` from the latest snapshot; use them to
    address elements.

    Prerequisite: the EvoFlow desktop app must be running. Do not invent
    alternate browsers.

    Args:
        action: open | snapshot | click | fill | press | scroll | screenshot | back | close.
        url: Target URL (required for open).
        ref: Element ref from snapshot, e.g. e2 or @e2 (required for click/fill).
        text: Input text (required for fill).
        key: Key name, e.g. Enter (required for press).
        direction: scroll direction, default down.
        amount: scroll pixels, default 800.
        full_page: For screenshot, capture full page when True.
    """
    thread_id = _get_thread_id(runtime)
    act = str(action or "").strip().lower()
    if not _use_engine():
        logger.warning("browser tool used with engine disabled thread=%s", thread_id)
        return _ENGINE_UNAVAILABLE

    if act == "open":
        page = str(url or "").strip()
        if not page:
            return "Error: action='open' requires url."
        return _engine_open(thread_id, page)
    if act == "snapshot":
        return _engine_snapshot(thread_id)
    if act == "click":
        target = _normalize_ref(str(ref or ""))
        if not target:
            return "Error: action='click' requires ref (e.g. e2 from snapshot)."
        return _engine_click(thread_id, target)
    if act == "fill":
        target = _normalize_ref(str(ref or ""))
        if not target:
            return "Error: action='fill' requires ref (e.g. e3 from snapshot)."
        return _engine_fill(thread_id, target, str(text or ""))
    if act == "press":
        pressed = str(key or "").strip()
        if not pressed:
            return "Error: action='press' requires key (e.g. Enter, Tab)."
        return _engine_press(thread_id, pressed)
    if act == "scroll":
        dir_norm = str(direction or "down").strip().lower() or "down"
        return _engine_scroll(thread_id, dir_norm, max(1, int(amount or 800)))
    if act == "screenshot":
        return _engine_screenshot(thread_id, full_page=bool(full_page))
    if act == "back":
        return _engine_back(thread_id)
    if act == "close":
        with _state_lock:
            _last_page_url.pop(thread_id, None)
        _engine_close(thread_id)
        return "OK"
    return f"Error: unsupported browser action '{action}'."
