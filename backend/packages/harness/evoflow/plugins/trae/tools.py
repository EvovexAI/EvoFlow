"""Tools for calling a local Trae bridge service.

This module is packaged as an optional plugin under `evoflow.plugins.trae`.
The built-in tools layer may re-export these tools for backward compatibility.
"""

from __future__ import annotations

import json
import logging
import os
import shlex
import socket
import subprocess
import time
from collections.abc import Callable
from pathlib import Path
from urllib import error, request

from langchain.tools import tool
from langgraph.config import get_stream_writer

from evoflow.config import get_app_config

logger = logging.getLogger(__name__)

_DEFAULT_BASE_URL = "http://127.0.0.1:8787"
_DEFAULT_TIMEOUT_SECONDS = 20
_DEFAULT_START_WAIT_SECONDS = 20


def _get_trae_runtime_config() -> tuple[str, int, str | None, int, str | None, str | None, str | None, str]:
    config = get_app_config().model_dump(mode="json", exclude_none=True)
    trae_config = config.get("trae", {}) if isinstance(config, dict) else {}
    if not isinstance(trae_config, dict):
        trae_config = {}

    base_url = str(trae_config.get("base_url") or _DEFAULT_BASE_URL).strip()
    if base_url.endswith("/"):
        base_url = base_url[:-1]

    timeout = trae_config.get("timeout_seconds", _DEFAULT_TIMEOUT_SECONDS)
    try:
        timeout_seconds = int(timeout)
    except (TypeError, ValueError):
        timeout_seconds = _DEFAULT_TIMEOUT_SECONDS
    timeout_seconds = max(1, timeout_seconds)

    start_command_raw = trae_config.get("start_command")
    start_command = str(start_command_raw).strip() if start_command_raw else None
    start_wait = trae_config.get("start_wait_seconds", _DEFAULT_START_WAIT_SECONDS)
    try:
        start_wait_seconds = int(start_wait)
    except (TypeError, ValueError):
        start_wait_seconds = _DEFAULT_START_WAIT_SECONDS
    start_wait_seconds = max(1, start_wait_seconds)

    repo_path_raw = trae_config.get("repo_path")
    repo_path = str(repo_path_raw).strip() if repo_path_raw else None

    bin_path_raw = trae_config.get("bin_path")
    bin_path = str(bin_path_raw).strip() if bin_path_raw else None

    project_path_raw = trae_config.get("project_path")
    project_path = str(project_path_raw).strip() if project_path_raw else None

    send_trigger_raw = trae_config.get("send_trigger")
    send_trigger = str(send_trigger_raw).strip().lower() if send_trigger_raw else "enter"
    if send_trigger not in {"enter", "button"}:
        send_trigger = "enter"

    return base_url, timeout_seconds, start_command, start_wait_seconds, repo_path, bin_path, project_path, send_trigger


def _guess_trae_repo_path(config_repo_path: str | None) -> str | None:
    candidates: list[Path] = []
    if config_repo_path:
        candidates.append(Path(config_repo_path))

    cwd = Path.cwd()
    candidates.extend(
        [
            cwd / "Trae",
            cwd.parent / "Trae",
            Path.home() / "Trae",
            cwd / "TraeClaw",
            cwd.parent / "TraeClaw",
            Path.home() / "TraeClaw",
            Path.home() / "traeclaw",
        ]
    )

    for path in candidates:
        try:
            if (path / "start-traeapi.cmd").exists():
                return str(path)
        except Exception:
            continue
    return None


def _guess_npm_runtime_start_script() -> tuple[str, str] | None:
    cwd = Path.cwd()
    candidates = [
        cwd / "node_modules" / "traeclaw" / "runtime" / "traeapi" / "start-traeapi.cmd",
        cwd.parent / "node_modules" / "traeclaw" / "runtime" / "traeapi" / "start-traeapi.cmd",
    ]
    for script in candidates:
        try:
            if script.exists():
                return str(script), str(script.parent)
        except Exception:
            continue
    return None


def _build_start_candidates(explicit_command: str | None, repo_path: str | None) -> list[tuple[str, str | None]]:
    candidates: list[tuple[str, str | None]] = []
    if explicit_command:
        candidates.append((explicit_command, None))

    npm_runtime = _guess_npm_runtime_start_script()
    if npm_runtime:
        script, script_cwd = npm_runtime
        candidates.append((f'"{script}"', script_cwd))

    guessed_repo = _guess_trae_repo_path(repo_path)
    if guessed_repo:
        cmd_path = str(Path(guessed_repo) / "start-traeapi.cmd")
        candidates.append((f'"{cmd_path}"', guessed_repo))

    # Backward fallback; package has no bin, usually not sufficient alone.
    candidates.append(("npx -y traeclaw", None))

    # de-duplicate while preserving order
    seen: set[str] = set()
    unique: list[tuple[str, str | None]] = []
    for cmd, cwd in candidates:
        key = f"{cmd}|{cwd or ''}"
        if key not in seen:
            seen.add(key)
            unique.append((cmd, cwd))
    return unique


def _extract_host_port(base_url: str) -> tuple[str, int] | None:
    try:
        from urllib.parse import urlparse

        parsed = urlparse(base_url)
        if not parsed.hostname or not parsed.port:
            return None
        return parsed.hostname, parsed.port
    except Exception:
        return None


def _is_port_open(host: str, port: int, timeout: float = 0.8) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(timeout)
        try:
            sock.connect((host, port))
            return True
        except OSError:
            return False


def _bridge_is_ready() -> bool:
    ok, raw = _request_json("/ready", method="GET")
    if not ok:
        return False
    try:
        data = json.loads(raw)
        status = data.get("data", {}).get("status")
        automation_ready = data.get("data", {}).get("automation", {}).get("ready")
        return status == "ready" and bool(automation_ready)
    except Exception:
        return False


def _kill_listener_on_port(port: int) -> None:
    if os.name != "nt":
        return
    try:
        completed = subprocess.run(
            ["netstat", "-ano", "-p", "tcp"],
            check=False,
            capture_output=True,
            text=True,
        )
        if completed.returncode != 0:
            return
        pids: set[str] = set()
        token = f":{port}"
        for line in completed.stdout.splitlines():
            parts = line.split()
            if len(parts) < 5:
                continue
            local_addr = parts[1]
            state = parts[3].upper()
            pid = parts[4]
            if token in local_addr and state == "LISTENING" and pid.isdigit():
                pids.add(pid)
        for pid in pids:
            subprocess.run(["taskkill", "/PID", pid, "/F"], check=False, capture_output=True, text=True)
    except Exception:
        return


def _request_json(
    path: str,
    payload: dict | None = None,
    method: str = "POST",
    timeout_seconds_override: int | None = None,
) -> tuple[bool, str]:
    base_url, timeout_seconds, _, _, _, _, _, _ = _get_trae_runtime_config()
    if timeout_seconds_override is not None:
        timeout_seconds = max(1, int(timeout_seconds_override))
    url = f"{base_url}{path}"
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8") if payload is not None else None
    req = request.Request(
        url,
        data=body,
        headers={"Content-Type": "application/json"},
        method=method,
    )
    try:
        with request.urlopen(req, timeout=timeout_seconds) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            return True, raw
    except error.HTTPError as e:
        raw = e.read().decode("utf-8", errors="replace")
        return False, f"HTTP {e.code}: {raw}"
    except error.URLError as e:
        return False, f"Network error: {e.reason}"
    except Exception as e:
        return False, f"Unexpected error: {e}"


def _request_sse(
    path: str,
    payload: dict,
    timeout_seconds_override: int | None = None,
    on_event: Callable[[str, object], None] | None = None,
) -> tuple[bool, str]:
    base_url, timeout_seconds, _, _, _, _, _, _ = _get_trae_runtime_config()
    if timeout_seconds_override is not None:
        timeout_seconds = max(1, int(timeout_seconds_override))
    url = f"{base_url}{path}"
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = request.Request(
        url,
        data=body,
        headers={
            "Content-Type": "application/json",
            "Accept": "text/event-stream",
        },
        method="POST",
    )
    raw_parts: list[str] = []
    current_event = "message"
    current_data_lines: list[str] = []

    def flush_event() -> None:
        nonlocal current_event, current_data_lines
        if not current_data_lines:
            return
        payload_str = "\n".join(current_data_lines).strip()
        parsed: object = payload_str
        try:
            parsed = json.loads(payload_str)
        except Exception:
            parsed = payload_str
        if on_event is not None:
            try:
                on_event(current_event, parsed)
            except Exception:
                logger.exception("trae sse event callback failed")
        current_event = "message"
        current_data_lines = []

    def consume_line(line: str) -> None:
        nonlocal current_event, current_data_lines
        raw_parts.append(line)
        stripped = line.strip()
        if not stripped:
            flush_event()
            return
        if stripped.startswith("event:"):
            current_event = stripped[6:].strip() or "message"
            return
        if stripped.startswith("data:"):
            current_data_lines.append(stripped[5:].strip())
            return

    try:
        with request.urlopen(req, timeout=timeout_seconds) as resp:
            while True:
                try:
                    line_bytes = resp.readline()
                except TimeoutError:
                    if raw_parts:
                        flush_event()
                        logger.warning("trae sse read timed out after partial data; returning partial stream")
                        return True, "".join(raw_parts)
                    raise
                if not line_bytes:
                    break
                consume_line(line_bytes.decode("utf-8", errors="replace"))
            flush_event()
            return True, "".join(raw_parts)
    except error.HTTPError as e:
        raw = e.read().decode("utf-8", errors="replace")
        return False, f"HTTP {e.code}: {raw}"
    except error.URLError as e:
        return False, f"Network error: {e.reason}"
    except Exception as e:
        return False, f"Unexpected error: {e}"


def _parse_sse_text(raw_sse: str) -> tuple[str, list[dict[str, object]]]:
    events: list[dict[str, object]] = []
    current_event = "message"
    current_data_lines: list[str] = []

    def flush_event() -> None:
        nonlocal current_event, current_data_lines
        if not current_data_lines:
            return
        payload_str = "\n".join(current_data_lines).strip()
        parsed: object = payload_str
        try:
            parsed = json.loads(payload_str)
        except Exception:
            parsed = payload_str
        events.append({"event": current_event, "data": parsed})
        current_event = "message"
        current_data_lines = []

    for line in raw_sse.splitlines():
        stripped = line.strip()
        if not stripped:
            flush_event()
            continue
        if stripped.startswith("event:"):
            current_event = stripped[6:].strip() or "message"
            continue
        if stripped.startswith("data:"):
            current_data_lines.append(stripped[5:].strip())
            continue
    flush_event()

    chunks: list[str] = []
    final_text = ""
    for item in events:
        data = item.get("data")
        if isinstance(data, dict):
            maybe_chunk = data.get("chunk")
            if isinstance(maybe_chunk, str) and maybe_chunk.strip():
                chunks.append(maybe_chunk.strip())
            maybe_text = data.get("result", {}) if isinstance(data.get("result"), dict) else {}
            response = maybe_text.get("response", {}) if isinstance(maybe_text, dict) else {}
            text = response.get("text") if isinstance(response, dict) else None
            if isinstance(text, str) and text.strip():
                final_text = text.strip()
    merged = final_text or "\n".join(chunks).strip()
    if merged:
        filtered_lines: list[str] = []
        for line in merged.splitlines():
            text = line.strip()
            if not text:
                continue
            lowered = text.lower()
            if lowered in {"solo coder", "builder"}:
                continue
            if "思考中" in text or "思考过程" in text or "正在分析" in text or "分析中" in text:
                continue
            if text.endswith("%") and any(ch.isdigit() for ch in text):
                continue
            if text == "...":
                continue
            filtered_lines.append(text)
        if filtered_lines:
            merged = "\n".join(filtered_lines)
    return merged, events


@tool("trae_status", parse_docstring=False)
def trae_status_tool() -> str:
    """Check local Trae bridge status."""
    health_ok, health_raw = _request_json("/health", None, method="GET")
    ready_ok, ready_raw = _request_json("/ready", None, method="GET")

    if health_ok and ready_ok:
        return f"health={health_raw}\nready={ready_raw}"
    return f"Error: trae_status failed.\nhealth_ok={health_ok} health={health_raw}\nready_ok={ready_ok} ready={ready_raw}"


@tool("trae_new_chat", parse_docstring=False)
def trae_new_chat_tool() -> str:
    """Create a fresh chat session in Trae."""
    payload = {"metadata": {"caller": "EvoFlow"}, "prepare": True}
    ok, raw = _request_json("/v1/sessions", payload, method="POST")
    if ok:
        return raw
    return f"Error: trae_new_chat failed. {raw}"


@tool("trae_switch_mode", parse_docstring=False)
def trae_switch_mode_tool(mode: str) -> str:
    """Switch Trae mode between 'solo' and 'ide'."""
    normalized = (mode or "").strip().lower()
    if normalized not in {"solo", "ide"}:
        return 'Error: mode must be "solo" or "ide".'
    ok, raw = _request_json("/v1/mode", {"mode": normalized}, method="POST")
    if ok:
        return raw
    return f"Error: trae_switch_mode failed. {raw}"


@tool("trae_start", parse_docstring=False)
def trae_start_tool(
    *,
    start_command: str | None = None,
    wait_seconds: int | None = None,
    workspace: str | None = None,
) -> str:
    """Start local Trae bridge process and wait for port readiness.

    Args:
        start_command: Optional override command to start bridge process.
        wait_seconds: Optional seconds to wait for port readiness.
        workspace: Optional project path to open in Trae quickstart.
    """
    base_url, _, configured_start_command, configured_wait, configured_repo_path, configured_bin_path, configured_project_path, configured_send_trigger = _get_trae_runtime_config()
    command = (start_command or configured_start_command or "").strip() or None
    timeout_seconds = max(1, int(wait_seconds if wait_seconds is not None else configured_wait))
    runtime_bin_path = (configured_bin_path or "").strip() or None
    runtime_project_path = (workspace or configured_project_path or "").strip() or None

    host_port = _extract_host_port(base_url)
    if host_port is None:
        return f"Error: Invalid trae.base_url '{base_url}', host/port required."
    host, port = host_port

    if _is_port_open(host, port):
        if _bridge_is_ready():
            return f"OK: Trae bridge already running at {base_url}."
        _kill_listener_on_port(port)
        time.sleep(0.8)

    attempted: list[str] = []
    for candidate_command, candidate_cwd in _build_start_candidates(command, configured_repo_path):
        try:
            kwargs: dict = {
                "stdout": subprocess.DEVNULL,
                "stderr": subprocess.DEVNULL,
                "stdin": subprocess.DEVNULL,
                "cwd": candidate_cwd,
            }
            env = os.environ.copy()
            if runtime_bin_path:
                env["TRAE_BIN"] = runtime_bin_path
            if runtime_project_path:
                env["TRAE_QUICKSTART_PROJECT_PATH"] = runtime_project_path
            env["TRAE_SEND_TRIGGER"] = configured_send_trigger
            env["TRAE_CDP_TARGET_TITLE_EXCLUDES"] = "会话日志,session log,conversation log"
            # Give Trae more time to finish long generations before bridge timeout.
            env["TRAE_RESPONSE_TIMEOUT_MS"] = env.get("TRAE_RESPONSE_TIMEOUT_MS", "180000")
            kwargs["env"] = env
            if hasattr(subprocess, "CREATE_NEW_PROCESS_GROUP"):
                kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.DETACHED_PROCESS
                subprocess.Popen(candidate_command, shell=True, **kwargs)
            else:
                kwargs["start_new_session"] = True
                subprocess.Popen(shlex.split(candidate_command), **kwargs)

            deadline = time.time() + timeout_seconds
            while time.time() < deadline:
                if _is_port_open(host, port):
                    wd = candidate_cwd or os.getcwd()
                    return f"OK: Trae bridge started and is listening at {base_url}.\n  command: {candidate_command}\n  cwd: {wd}"
                time.sleep(0.5)
            attempted.append(f"{candidate_command} (started but port not ready)")
        except Exception as e:
            attempted.append(f"{candidate_command} (failed: {e})")

    details = "\n".join(f"  - {item}" for item in attempted) if attempted else "  - (no command candidates)"
    return f"Error: Unable to start Trae bridge at {base_url}.\nTried commands:\n{details}\nTip: set trae.repo_path to your local Trae bridge directory that contains start-traeapi.cmd."


_TRAE_DELEGATE_DESCRIPTION = (
    "Delegate a prompt to Trae desktop via local bridge. "
    "Lead clarifies DoD and verifies results; use trae_start/trae_status if the bridge is down."
)


@tool("trae_delegate", description=_TRAE_DELEGATE_DESCRIPTION, parse_docstring=False)
def trae_delegate_tool(
    prompt: str,
    *,
    workspace: str | None = None,
    timeout_seconds: int | None = None,
    verbose: bool = False,
    new_chat: bool = False,
    stream: bool = True,
    force_solo: bool = True,
    auto_recover: bool = True,
) -> str:
    """Delegate a prompt to Trae desktop through local bridge service."""
    if not prompt or not prompt.strip():
        return 'Error: "prompt" is required.'

    bridge_timeout = max(30, int(timeout_seconds)) if timeout_seconds is not None else 60

    payload: dict[str, object] = {"prompt": prompt.strip()}
    if workspace and workspace.strip():
        payload["workspace"] = workspace.strip()
    if timeout_seconds is not None:
        payload["timeout_seconds"] = max(1, int(timeout_seconds))

    stream_writer = None
    try:
        stream_writer = get_stream_writer()
    except Exception:
        stream_writer = None

    if force_solo:
        mode_ok, mode_raw = _request_json(
            "/v1/mode",
            {"mode": "solo"},
            method="POST",
            timeout_seconds_override=bridge_timeout,
        )
        if not mode_ok:
            logger.warning("trae_delegate pre-switch to solo failed: %s", mode_raw)

    session_id: str | None = None
    if new_chat:
        sess_ok, sess_raw = _request_json(
            "/v1/sessions",
            {"metadata": {"caller": "EvoFlow"}, "prepare": True},
            method="POST",
            timeout_seconds_override=bridge_timeout,
        )
        if not sess_ok:
            logger.warning("trae_delegate new_chat prepare failed; fallback to current session: %s", sess_raw)
        else:
            try:
                sess_data = json.loads(sess_raw)
                session_id = sess_data.get("data", {}).get("session", {}).get("sessionId")
            except Exception:
                session_id = None

    body: dict[str, object] = {
        "content": str(payload["prompt"]),
        "metadata": {"caller": "EvoFlow"},
    }
    if workspace and workspace.strip():
        body["sessionMetadata"] = {"workspace": workspace.strip()}
    if session_id:
        body["sessionId"] = session_id

    def _send_once(request_body: dict[str, object]) -> tuple[bool, str]:
        if stream:

            def on_sse_event(event_name: str, data_obj: object) -> None:
                if stream_writer is None:
                    return
                try:
                    if event_name == "delta" and isinstance(data_obj, dict):
                        chunk = data_obj.get("chunk")
                        if isinstance(chunk, str) and chunk:
                            stream_writer(
                                {
                                    "type": "trae_stream_delta",
                                    "delta_type": str(data_obj.get("type") or "delta"),
                                    "text": chunk,
                                }
                            )
                    elif event_name == "done":
                        stream_writer({"type": "trae_stream_done"})
                    elif event_name == "error":
                        message = data_obj if isinstance(data_obj, str) else json.dumps(data_obj, ensure_ascii=False)
                        stream_writer({"type": "trae_stream_error", "error": message})
                except Exception:
                    logger.exception("failed to emit trae stream custom event")

            return _request_sse(
                "/v1/chat/stream",
                request_body,
                timeout_seconds_override=bridge_timeout,
                on_event=on_sse_event,
            )
        return _request_json(
            "/v1/chat",
            request_body,
            method="POST",
            timeout_seconds_override=bridge_timeout,
        )

    ok, raw = _send_once(body)
    response_is_sse = bool(stream)

    if not ok and auto_recover:
        lowered = raw.lower()
        may_be_stuck = "automation_response_pending" in lowered or "still processing" in lowered or "正在分析" in raw or "分析中" in raw or "cdp_socket_closed" in lowered or "socket closed" in lowered or '"code":1006' in lowered
        if may_be_stuck:
            logger.warning("trae_delegate detected stuck analyzing state, attempting one-shot recovery")
            if force_solo:
                mode_ok, mode_raw = _request_json(
                    "/v1/mode",
                    {"mode": "solo"},
                    method="POST",
                    timeout_seconds_override=bridge_timeout,
                )
                if not mode_ok:
                    logger.warning("trae_delegate recovery switch to solo failed: %s", mode_raw)
            rec_ok, rec_raw = _request_json(
                "/v1/sessions",
                {"metadata": {"caller": "EvoFlow"}, "prepare": True},
                method="POST",
                timeout_seconds_override=bridge_timeout,
            )
            if rec_ok:
                try:
                    rec_data = json.loads(rec_raw)
                    recovered_session_id = rec_data.get("data", {}).get("session", {}).get("sessionId")
                    if recovered_session_id:
                        body["sessionId"] = recovered_session_id
                except Exception:
                    pass
            time.sleep(1.0)
            ok, raw = _send_once(body)

    if not ok and not stream:
        lowered = raw.lower()
        if "timed out" in lowered or "timeout" in lowered:
            logger.warning("trae_delegate non-stream timed out, fallback to stream")
            ok, raw = _request_sse(
                "/v1/chat/stream",
                body,
                timeout_seconds_override=bridge_timeout,
            )
            response_is_sse = ok

    if ok:
        if verbose:
            return raw
        if response_is_sse:
            try:
                merged, events = _parse_sse_text(raw)
                if merged:
                    return merged
                if events:
                    return json.dumps(events, ensure_ascii=False)
                return raw
            except Exception:
                return raw
        try:
            data = json.loads(raw)
            text = data.get("data", {}).get("result", {}).get("response", {}).get("text")
            if isinstance(text, str) and text.strip():
                return text.strip()
            chunks = data.get("data", {}).get("result", {}).get("chunks", [])
            if isinstance(chunks, list):
                merged = "\n".join(str(item).strip() for item in chunks if str(item).strip()).strip()
                if merged:
                    return merged
            return raw
        except Exception:
            return raw
    logger.warning("trae_delegate call failed: %s", raw)
    return f"Error: trae_delegate failed. {raw}"
