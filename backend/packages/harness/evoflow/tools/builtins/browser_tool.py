"""Unified browser tool — in-process Playwright engine first, agent-browser CLI fallback.

Single tool, multi-action surface (unchanged for the agent):
``open | snapshot | click | fill | press | scroll | screenshot | back | close``.

Engine mode (default, ``EVOFLOW_BROWSER_ENGINE`` unset or ``playwright``) drives the
page through :mod:`evoflow.tools.builtins.browser_engine` — an in-process Playwright
executor speaking the ZCode-style browser command contract, with CDP screencast
served in-process so EvoPanel's live canvas and the gateway proxy stay unchanged.
CLI mode (``EVOFLOW_BROWSER_ENGINE=cli``) keeps the legacy bundled agent-browser CLI
subprocess path verbatim.

Deferred under agent mode: activate agent, then ``tool_search(query='select:browser')``.
"""

from __future__ import annotations

import contextlib
import json
import logging
import os
import subprocess
import sys
import tempfile
import threading
from pathlib import Path
from typing import Any, Literal

from langchain.tools import ToolRuntime, tool
from langgraph.typing import ContextT

from evoflow.tools.builtins.browser_screenshot_store import (
    format_screenshot_tool_result,
    save_screenshot_png,
)
from evoflow.utils.bundled_tools import bundled_agent_browser_cli
from evoflow.utils.subprocess_platform import subprocess_hide_window_kwargs, subprocess_text_io_kwargs

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
_CLI_TIMEOUT = int(os.getenv("EVOFLOW_BROWSER_CLI_TIMEOUT", "120"))
_OPEN_TIMEOUT = int(os.getenv("EVOFLOW_BROWSER_OPEN_TIMEOUT", "35"))
_OPEN_WAIT_MS = max(0, int(os.getenv("EVOFLOW_BROWSER_OPEN_WAIT_MS", "1200")))
_VIEWPORT_W = max(320, int(os.getenv("EVOFLOW_BROWSER_VIEWPORT_W", "1280")))
_VIEWPORT_H = max(240, int(os.getenv("EVOFLOW_BROWSER_VIEWPORT_H", "900")))
_VIEWPORT_SCALE = max(1, int(os.getenv("EVOFLOW_BROWSER_VIEWPORT_SCALE", "1")))
_last_page_url: dict[str, str] = {}
_state_lock = threading.Lock()


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
# Engine (Playwright, in-process)
# ---------------------------------------------------------------------------


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


def _engine_open(thread_id: str, url: str) -> str:
    _wait_for_embed_cdp(thread_id)
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
    from evoflow.tools.builtins.browser_contract import snapshot_to_text

    result = _engine_dispatch(thread_id, {"method": "snapshot"}, timeout=_CLI_TIMEOUT)
    if not result.get("ok"):
        return _engine_error_message(result) or "Error: snapshot failed"
    snapshot = result.get("snapshot") or {}
    if not snapshot:
        return "Error: empty snapshot"
    from evoflow.tools.builtins.browser_contract import BrowserSnapshot

    return snapshot_to_text(BrowserSnapshot.model_validate(snapshot))


def _engine_click(thread_id: str, ref: str) -> str:
    target = _normalize_ref(ref)
    result = _engine_dispatch(
        thread_id, {"method": "click", "ref": target}, timeout=_CLI_TIMEOUT
    )
    if not result.get("ok"):
        return _engine_error_message(result) or "Error: click failed"
    return _format_step_result("click", result, ref=target)


def _engine_fill(thread_id: str, ref: str, text: str) -> str:
    target = _normalize_ref(ref)
    result = _engine_dispatch(
        thread_id,
        {"method": "fill", "ref": target, "value": str(text or "")},
        timeout=_CLI_TIMEOUT,
    )
    if not result.get("ok"):
        return _engine_error_message(result) or "Error: fill failed"
    return _format_step_result("fill", result, ref=target)


def _engine_press(thread_id: str, key: str) -> str:
    result = _engine_dispatch(thread_id, {"method": "press", "key": str(key or "")}, timeout=_CLI_TIMEOUT)
    if not result.get("ok"):
        return _engine_error_message(result) or "Error: press failed"
    return _format_step_result("press", result)


def _engine_scroll(thread_id: str, direction: str, amount: int) -> str:
    result = _engine_dispatch(
        thread_id,
        {"method": "scroll", "direction": str(direction or "down"), "amount": int(amount or 800)},
        timeout=_CLI_TIMEOUT,
    )
    if not result.get("ok"):
        return _engine_error_message(result) or "Error: scroll failed"
    return _format_step_result("scroll", result)


def _engine_back(thread_id: str) -> str:
    result = _engine_dispatch(thread_id, {"method": "back"}, timeout=_CLI_TIMEOUT)
    if not result.get("ok"):
        return _engine_error_message(result) or "Error: back failed"
    return _format_step_result("back", result)


def _engine_screenshot(thread_id: str, *, full_page: bool) -> str:
    result = _engine_dispatch(
        thread_id, {"method": "screenshot", "fullPage": bool(full_page)}, timeout=_CLI_TIMEOUT
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


# ---------------------------------------------------------------------------
# Legacy CLI path (fallback: EVOFLOW_BROWSER_ENGINE=cli, or engine unavailable)
# ---------------------------------------------------------------------------


def _resolve_agent_browser_cli() -> str | None:
    cli = bundled_agent_browser_cli()
    if not cli:
        return None
    if sys.platform == "win32":
        native_dir = Path(cli).resolve().parent.parent / "agent-browser" / "bin"
        for name in ("agent-browser-win32-x64.exe", "agent-browser.exe"):
            candidate = native_dir / name
            if candidate.is_file():
                return str(candidate)
    return cli


def _stop_hung_cli(proc: subprocess.Popen[str]) -> None:
    """Stop the CLI client only — never kill the agent-browser session daemon (/T kills Chrome stream)."""
    if proc.poll() is not None:
        return
    with contextlib.suppress(Exception):
        proc.terminate()
    try:
        proc.wait(timeout=2)
        return
    except subprocess.TimeoutExpired:
        pass
    with contextlib.suppress(Exception):
        proc.kill()
    with contextlib.suppress(Exception):
        proc.wait(timeout=3)


def _inject_json_flag(args: list[str]) -> list[str]:
    if "--json" in args:
        return list(args)
    out = list(args)
    if "--session" in out:
        idx = out.index("--session")
        if idx + 1 < len(out):
            return out[: idx + 2] + ["--json"] + out[idx + 2 :]
    return ["--json", *out]


def _parse_cli_json_blob(text: str) -> dict[str, Any] | None:
    blob = str(text or "").strip()
    if not blob:
        return None
    for line in reversed(blob.splitlines()):
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            parsed = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict) and "success" in parsed:
            return parsed
    return None


def _format_json_cli_result(code: int, stdout: str, stderr: str) -> str:
    payload = _parse_cli_json_blob(stdout) or _parse_cli_json_blob(stderr)
    if payload is None:
        return _format_cli_result(code, stdout, stderr)
    if not payload.get("success"):
        err = payload.get("error") or stderr or stdout or f"exit code {code}"
        if isinstance(err, dict):
            err = json.dumps(err, ensure_ascii=False)
        return f"Error: {err}"
    data = payload.get("data")
    if isinstance(data, str) and data.strip():
        return data.strip()
    if isinstance(data, dict):
        for key in ("snapshot", "text", "output", "content", "title"):
            val = data.get(key)
            if isinstance(val, str) and val.strip():
                return val.strip()
        if data.get("url"):
            title = str(data.get("title") or "").strip()
            url = str(data.get("url") or "").strip()
            return f"{title}\n{url}".strip() if title else url
        return json.dumps(data, ensure_ascii=False)
    return stdout or stderr or "OK"


def _run_agent_browser(
    args: list[str],
    *,
    timeout: int = _CLI_TIMEOUT,
    thread_id: str | None = None,
) -> tuple[int, str, str]:
    import time

    from evoflow.utils.bundled_tools import find_chrome_executable

    cli = _resolve_agent_browser_cli()
    if not cli:
        return (
            127,
            "",
            _browser_cli_missing_message(),
        )

    # Do not auto-download Chromium here (silent install fails without Node/network
    # context and confuses users). Tell the agent how to install; it can run
    # `agent-browser install` via terminal when appropriate.
    if not find_chrome_executable():
        return 1, "", _browser_chromium_missing_message()

    cmd = [cli, *_inject_json_flag(args)]
    env = _build_agent_browser_env(thread_id)
    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
            **subprocess_hide_window_kwargs(),
            **subprocess_text_io_kwargs(),
        )
    except Exception as exc:
        return 1, "", f"agent-browser failed: {exc}"

    stdout_chunks: list[str] = []
    stderr_chunks: list[str] = []
    deadline = time.time() + max(1, int(timeout))

    while time.time() < deadline:
        if proc.poll() is not None:
            rest_out, rest_err = proc.communicate(timeout=2)
            if rest_out:
                stdout_chunks.append(rest_out)
            if rest_err:
                stderr_chunks.append(rest_err)
            break
        try:
            line = proc.stdout.readline() if proc.stdout else ""
        except Exception:
            line = ""
        if line:
            stdout_chunks.append(line)
            payload = _parse_cli_json_blob("".join(stdout_chunks))
            if payload is not None and payload.get("success"):
                logger.info(
                    "agent-browser command finished (json success, stopping CLI): %s",
                    " ".join(args[:4]),
                )
                _stop_hung_cli(proc)
                break
        else:
            time.sleep(0.05)
    else:
        partial_out = "".join(stdout_chunks)
        partial_err = "".join(stderr_chunks)
        payload = _parse_cli_json_blob(partial_out) or _parse_cli_json_blob(partial_err)
        if payload is not None and payload.get("success"):
            logger.warning(
                "agent-browser timed out after %ss but got success JSON; killing CLI (%s)",
                timeout,
                " ".join(args[:4]),
            )
            _stop_hung_cli(proc)
            return 0, partial_out, partial_err
        _stop_hung_cli(proc)
        return 124, partial_out, f"agent-browser timed out after {timeout}s"

    code = int(proc.returncode or 0)
    stdout = "".join(stdout_chunks).strip()
    stderr = "".join(stderr_chunks).strip()
    if code != 0:
        payload = _parse_cli_json_blob(stdout) or _parse_cli_json_blob(stderr)
        if payload is not None and payload.get("success"):
            code = 0
    return code, stdout, stderr


def _browser_cli_missing_message() -> str:
    return "agent-browser CLI not found. Dev: run `make setup-agent-browser` from repo root (installs backend/packaging/agent-browser-bundle). Or: npm install -g agent-browser && agent-browser install"


def _browser_chromium_missing_message() -> str:
    return (
        "浏览器引擎（Chromium）未安装，无法打开网页。"
        "请先安装后再重试：在终端执行 `agent-browser install`"
        "（约 400MB，需联网；装到用户目录 ~/.agent-browser/browsers，之后无需再装）。"
        "若 agent-browser 不在 PATH，可用打包目录下的 CLI："
        "tools/agent-browser/node_modules/.bin/agent-browser install"
    )


def _build_agent_browser_env(thread_id: str | None = None) -> dict[str, str]:
    from evoflow.tools.builtins.browser_embed_cdp import get_thread_cdp_url
    from evoflow.tools.builtins.browser_stream import browser_cdp_url, browser_headed_enabled
    from evoflow.utils.bundled_tools import apply_agent_browser_to_path, find_chrome_executable

    apply_agent_browser_to_path()
    env = dict(os.environ)
    embed_cdp = get_thread_cdp_url(str(thread_id or "").strip()) if thread_id else ""
    cdp = embed_cdp or browser_cdp_url()
    if cdp:
        env.setdefault("EVOFLOW_BROWSER_CDP_URL", cdp)
    elif browser_headed_enabled():
        env.setdefault("AGENT_BROWSER_HEADED", "1")
    if not str(env.get("AGENT_BROWSER_EXECUTABLE_PATH", "")).strip():
        chrome = find_chrome_executable()
        if chrome:
            env["AGENT_BROWSER_EXECUTABLE_PATH"] = chrome
    return env


def _format_cli_result(code: int, stdout: str, stderr: str) -> str:
    if code == 0:
        return stdout or stderr or "OK"
    detail = stderr or stdout or f"exit code {code}"
    return f"Error: {detail}"


def _run_browser_cli(thread_id: str, subcommand: list[str], *, timeout: int = _CLI_TIMEOUT) -> str:
    session = _session_name(thread_id)
    code, out, err = _run_agent_browser(
        ["--session", session, *subcommand],
        timeout=timeout,
        thread_id=thread_id,
    )
    return _format_json_cli_result(code, out, err)


def _prime_browser_viewport(thread_id: str) -> None:
    """Normalize viewport (scale=1) so screencast frames match layout pixels on Windows."""
    args = ["set", "viewport", str(_VIEWPORT_W), str(_VIEWPORT_H)]
    if _VIEWPORT_SCALE > 1:
        args.append(str(_VIEWPORT_SCALE))
    result = _run_browser_cli(thread_id, args, timeout=min(15, _OPEN_TIMEOUT))
    if result.startswith("Error:"):
        logger.warning(
            "browser viewport set skipped thread=%s: %s",
            thread_id,
            result,
        )
        return
    logger.info(
        "browser viewport set thread=%s size=%sx%s scale=%s",
        thread_id,
        _VIEWPORT_W,
        _VIEWPORT_H,
        _VIEWPORT_SCALE,
    )


def _remember_page_url(thread_id: str, url: str) -> None:
    page = str(url or "").strip()
    if not page:
        return
    with _state_lock:
        _last_page_url[thread_id] = page


def _current_page_url(thread_id: str) -> str:
    with _state_lock:
        return _last_page_url.get(thread_id, "")


def _wait_for_embed_cdp(thread_id: str, timeout_sec: float = 2.5) -> None:
    import time

    from evoflow.tools.builtins.browser_embed_cdp import get_thread_cdp_url

    deadline = time.time() + max(0.0, timeout_sec)
    while time.time() < deadline:
        if get_thread_cdp_url(thread_id):
            return
        time.sleep(0.12)


# ---------------------------------------------------------------------------
# Actions — engine first, CLI fallback
# ---------------------------------------------------------------------------


def _use_engine() -> bool:
    try:
        from evoflow.tools.builtins.browser_engine import browser_engine_enabled

        return browser_engine_enabled()
    except Exception:
        return False


def _action_open(thread_id: str, url: str) -> str:
    page = str(url or "").strip()
    if not page:
        return "Error: action='open' requires url."
    if _use_engine():
        try:
            return _engine_open(thread_id, page)
        except Exception as exc:
            logger.warning("browser engine open failed, falling back to CLI: %s", exc)
    _wait_for_embed_cdp(thread_id)
    session = _session_name(thread_id)
    logger.info("browser open start thread=%s session=%s url=%s", thread_id, session, page)
    result = _run_browser_cli(thread_id, ["open", page], timeout=_OPEN_TIMEOUT)
    if result.startswith("Error:"):
        logger.warning("browser open failed thread=%s: %s", thread_id, result)
        return result
    _remember_page_url(thread_id, page)
    logger.info("browser open ok thread=%s url=%s", thread_id, page)

    if _OPEN_WAIT_MS > 0:
        _run_browser_cli(thread_id, ["wait", str(_OPEN_WAIT_MS)], timeout=min(12, _OPEN_TIMEOUT))

    _prime_browser_viewport(thread_id)
    from evoflow.tools.builtins.browser_stream import (
        build_browser_live_metadata,
        restart_browser_stream,
    )

    restart_browser_stream(thread_id)

    live = build_browser_live_metadata(thread_id, page_url=page)
    logger.info(
        "browser open returning live metadata thread=%s stream=%s",
        thread_id,
        live.get("stream_ws"),
    )
    return json.dumps(live, ensure_ascii=False)


def _action_snapshot(thread_id: str) -> str:
    if _use_engine():
        try:
            return _engine_snapshot(thread_id)
        except Exception as exc:
            logger.warning("browser engine snapshot failed, falling back to CLI: %s", exc)
    return _run_browser_cli(thread_id, ["snapshot", "-c"])


def _action_click(thread_id: str, ref: str) -> str:
    target = _normalize_ref(ref)
    if not target:
        return "Error: action='click' requires ref (e.g. e2 from snapshot)."
    if _use_engine():
        try:
            return _engine_click(thread_id, target)
        except Exception as exc:
            logger.warning("browser engine click failed, falling back to CLI: %s", exc)
    return _run_browser_cli(thread_id, ["click", target])


def _action_fill(thread_id: str, ref: str, text: str) -> str:
    target = _normalize_ref(ref)
    value = str(text or "")
    if not target:
        return "Error: action='fill' requires ref (e.g. e3 from snapshot)."
    if _use_engine():
        try:
            return _engine_fill(thread_id, target, value)
        except Exception as exc:
            logger.warning("browser engine fill failed, falling back to CLI: %s", exc)
    return _run_browser_cli(thread_id, ["fill", target, value])


def _action_press(thread_id: str, key: str) -> str:
    pressed = str(key or "").strip()
    if not pressed:
        return "Error: action='press' requires key (e.g. Enter, Tab)."
    if _use_engine():
        try:
            return _engine_press(thread_id, pressed)
        except Exception as exc:
            logger.warning("browser engine press failed, falling back to CLI: %s", exc)
    return _run_browser_cli(thread_id, ["press", pressed])


def _action_scroll(thread_id: str, direction: str, amount: int) -> str:
    dir_norm = str(direction or "down").strip().lower() or "down"
    amt = max(1, int(amount or 800))
    if _use_engine():
        try:
            return _engine_scroll(thread_id, dir_norm, amt)
        except Exception as exc:
            logger.warning("browser engine scroll failed, falling back to CLI: %s", exc)
    return _run_browser_cli(thread_id, ["scroll", dir_norm, str(amt)])


def _action_back(thread_id: str) -> str:
    if _use_engine():
        try:
            return _engine_back(thread_id)
        except Exception as exc:
            logger.warning("browser engine back failed, falling back to CLI: %s", exc)
    return _run_browser_cli(thread_id, ["back"])


def _action_close(thread_id: str) -> str:
    if _use_engine():
        with _state_lock:
            _last_page_url.pop(thread_id, None)
        engine_message = _engine_close(thread_id)
        if engine_message is not None:
            return engine_message
    result = _run_browser_cli(thread_id, ["close"])
    with _state_lock:
        _last_page_url.pop(thread_id, None)
    return result


def _action_screenshot(thread_id: str, *, full_page: bool) -> str:
    if _use_engine():
        try:
            return _engine_screenshot(thread_id, full_page=full_page)
        except Exception as exc:
            logger.warning("browser engine screenshot failed, falling back to CLI: %s", exc)
    tmp_path = ""
    try:
        with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as tmp:
            tmp_path = tmp.name
        subcommand = ["screenshot", tmp_path]
        if full_page:
            subcommand.append("--full-page")
        cli_result = _run_browser_cli(thread_id, subcommand)
        if cli_result.startswith("Error:"):
            return cli_result
        path = Path(tmp_path)
        if not path.is_file():
            return f"Error: screenshot file missing after CLI: {cli_result or '(no output)'}"
        png_bytes = path.read_bytes()
        if not png_bytes:
            return "Error: screenshot file empty"
        meta = save_screenshot_png(
            thread_id,
            png_bytes,
            page_url=_current_page_url(thread_id),
            full_page=full_page,
        )
        result = format_screenshot_tool_result(thread_id, meta)
        return result
    finally:
        if tmp_path:
            Path(tmp_path).unlink(missing_ok=True)


def _ensure_live_stream(thread_id: str, *, force_restart: bool = False) -> None:
    """Keep screencast running so EvoPanel shows agent actions in real time."""
    try:
        from evoflow.tools.builtins.browser_stream import (
            ensure_browser_stream_port,
            invalidate_browser_stream_cache,
            resolve_browser_stream_port,
            restart_browser_stream,
        )

        if force_restart:
            invalidate_browser_stream_cache(thread_id)
            port = restart_browser_stream(thread_id)
            if not port:
                _restore_live_stream(thread_id)
            return

        port = resolve_browser_stream_port(thread_id)
        if port:
            return

        port = ensure_browser_stream_port(thread_id)
        if port:
            logger.info("browser live stream ensured thread=%s port=%s", thread_id, port)
            return

        _restore_live_stream(thread_id)
    except Exception as exc:
        logger.warning("browser live stream ensure error thread=%s: %s", thread_id, exc)


def _restore_live_stream(thread_id: str) -> None:
    """Screenshot and some CLI actions stop screencast — bring live stream back."""
    import time

    from evoflow.tools.builtins.browser_stream import (
        invalidate_browser_stream_cache,
        restart_browser_stream,
    )

    invalidate_browser_stream_cache(thread_id)
    for attempt in range(3):
        try:
            port = restart_browser_stream(thread_id)
            if port:
                logger.info(
                    "browser live stream restored thread=%s port=%s attempt=%s",
                    thread_id,
                    port,
                    attempt + 1,
                )
                return
        except Exception as exc:
            logger.warning(
                "browser live stream restore error thread=%s attempt=%s: %s",
                thread_id,
                attempt + 1,
                exc,
            )
        time.sleep(0.35 * (attempt + 1))
    logger.warning("browser live stream restore failed thread=%s after retries", thread_id)


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

    Drives a Chromium engine in-process (Playwright + CDP). When EvoPanel's embedded
    browser is open, the agent controls that same visible WebView; otherwise a shared
    Chrome window is launched. Actions return refs like ``e1, e2, …`` from the latest
    snapshot; use them to address elements.

    Prerequisite: Chromium must be available locally (bundle, ``AGENT_BROWSER_EXECUTABLE_PATH``,
    or ``python -m playwright install chromium``). Do not invent alternate browsers.

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
    if act == "open":
        result = _action_open(thread_id, str(url or ""))
    elif act == "snapshot":
        result = _action_snapshot(thread_id)
    elif act == "click":
        result = _action_click(thread_id, str(ref or ""))
    elif act == "fill":
        result = _action_fill(thread_id, str(ref or ""), str(text or ""))
    elif act == "press":
        result = _action_press(thread_id, str(key or ""))
    elif act == "scroll":
        result = _action_scroll(thread_id, str(direction or "down"), int(amount or 800))
    elif act == "screenshot":
        result = _action_screenshot(thread_id, full_page=bool(full_page))
    elif act == "back":
        result = _action_back(thread_id)
    elif act == "close":
        return _action_close(thread_id)
    else:
        return f"Error: unsupported browser action '{action}'."

    if not result.startswith("Error:") and act != "close":
        if act == "screenshot":
            _ensure_live_stream(thread_id, force_restart=True)
        else:
            _ensure_live_stream(thread_id)
    return result
