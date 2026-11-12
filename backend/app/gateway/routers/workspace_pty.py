"""Interactive workspace PTY over WebSocket (ZCode side-pane terminal parity).

Protocol (JSON text frames):
  Client → Server:
    {"op":"write","data":"..."}
    {"op":"resize","cols":80,"rows":24}
    {"op":"dispose"}
  Server → Client:
    {"op":"ready","id":"...","shell":"..."}
    {"op":"data","data":"..."}
    {"op":"exit","code":0}
    {"op":"error","message":"..."}
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
import signal
import struct
import uuid
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/workspaces", tags=["workspaces-pty"])

_MAX_WRITE_CHARS = 64_000
_DEFAULT_COLS = 80
_DEFAULT_ROWS = 24


def _json_msg(payload: dict[str, Any]) -> str:
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))


def _resolve_interactive_shell() -> tuple[str, list[str]]:
    """Shell for interactive PTY — no -NonInteractive / Hidden."""
    if os.name == "nt":
        for candidate in ("pwsh.exe", "powershell.exe", "cmd.exe"):
            full = shutil.which(candidate)
            if not full:
                continue
            base = os.path.basename(full).lower()
            if "powershell" in base or base == "pwsh.exe":
                return full, ["-NoLogo"]
            return full, []
        raise RuntimeError("No usable Windows shell found")
    for candidate in ("/bin/zsh", "/bin/bash", "/bin/sh"):
        if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate, ["-l"] if candidate.endswith(("zsh", "bash")) else []
    raise RuntimeError("No usable Unix shell found")


def _resolve_cwd(cwd: str | None, root: str | None, thread_id: str | None) -> str:
    from app.gateway.routers.workspaces import _resolve_workspace_root

    preferred = str(cwd or "").strip()
    if preferred:
        p = Path(preferred).expanduser()
        try:
            if p.is_dir():
                return str(p.resolve())
        except OSError:
            pass
    try:
        resolved = _resolve_workspace_root(root, thread_id)
        if resolved and Path(resolved).is_dir():
            return resolved
    except Exception:
        logger.debug("workspace_pty: resolve root failed", exc_info=True)
    home = Path.home()
    if home.is_dir():
        return str(home)
    return os.getcwd()


def _prepare_env() -> dict[str, str]:
    from evoflow.utils.subprocess_platform import prepare_shell_env, sanitize_child_process_env

    env = sanitize_child_process_env(prepare_shell_env(os.environ.copy()))
    env.setdefault("TERM", "xterm-256color")
    env.setdefault("COLORTERM", "truecolor")
    return env


class _PipePtySession:
    """Windows / fallback: interactive shell over stdin/stdout pipes."""

    def __init__(self, proc: asyncio.subprocess.Process, shell: str) -> None:
        self.proc = proc
        self.shell = shell
        self.id = uuid.uuid4().hex[:12]

    async def write(self, data: str) -> None:
        if self.proc.stdin is None or self.proc.stdin.is_closing():
            return
        self.proc.stdin.write(data.encode("utf-8", errors="replace"))
        await self.proc.stdin.drain()

    async def resize(self, cols: int, rows: int) -> None:
        # Pipe mode has no TTY size; ignore.
        return

    async def read_chunk(self) -> bytes | None:
        if self.proc.stdout is None:
            return None
        return await self.proc.stdout.read(4096)

    async def wait(self) -> int:
        return int(await self.proc.wait())

    def kill(self) -> None:
        try:
            if self.proc.returncode is None:
                self.proc.kill()
        except ProcessLookupError:
            pass


class _UnixPtySession:
    """POSIX real PTY via pty.openpty."""

    def __init__(
        self,
        proc: asyncio.subprocess.Process,
        master_fd: int,
        shell: str,
    ) -> None:
        self.proc = proc
        self.master_fd = master_fd
        self.shell = shell
        self.id = uuid.uuid4().hex[:12]
        self._closed = False

    async def write(self, data: str) -> None:
        if self._closed:
            return
        loop = asyncio.get_running_loop()
        payload = data.encode("utf-8", errors="replace")

        def _write() -> None:
            os.write(self.master_fd, payload)

        await loop.run_in_executor(None, _write)

    async def resize(self, cols: int, rows: int) -> None:
        try:
            import fcntl
            import termios
        except ImportError:
            return
        cols = max(2, min(int(cols), 512))
        rows = max(2, min(int(rows), 256))
        packed = struct.pack("HHHH", rows, cols, 0, 0)
        try:
            fcntl.ioctl(self.master_fd, termios.TIOCSWINSZ, packed)
        except OSError:
            logger.debug("workspace_pty: TIOCSWINSZ failed", exc_info=True)

    async def read_chunk(self) -> bytes | None:
        if self._closed:
            return None
        loop = asyncio.get_running_loop()

        def _read() -> bytes:
            try:
                return os.read(self.master_fd, 4096)
            except OSError:
                return b""

        return await loop.run_in_executor(None, _read)

    async def wait(self) -> int:
        return int(await self.proc.wait())

    def kill(self) -> None:
        self._closed = True
        try:
            if self.proc.returncode is None:
                self.proc.send_signal(signal.SIGHUP)
                self.proc.kill()
        except ProcessLookupError:
            pass
        try:
            os.close(self.master_fd)
        except OSError:
            pass


async def _spawn_session(
    *,
    cwd: str,
    cols: int,
    rows: int,
) -> _PipePtySession | _UnixPtySession:
    shell, args = _resolve_interactive_shell()
    env = _prepare_env()
    env["COLUMNS"] = str(cols)
    env["LINES"] = str(rows)

    if os.name != "nt":
        import pty as pty_mod

        master_fd, slave_fd = pty_mod.openpty()
        try:
            proc = await asyncio.create_subprocess_exec(
                shell,
                *args,
                cwd=cwd,
                env=env,
                stdin=slave_fd,
                stdout=slave_fd,
                stderr=slave_fd,
                start_new_session=True,
            )
        finally:
            try:
                os.close(slave_fd)
            except OSError:
                pass
        session = _UnixPtySession(proc, master_fd, shell)
        await session.resize(cols, rows)
        return session

    # Interactive shell needs a usable stdin pipe. Prefer SW_HIDE over
    # CREATE_NO_WINDOW so PowerShell still allocates a console host enough
    # to emit a prompt (full ConPTY can land later).
    creation: dict[str, Any] = {}
    try:
        import subprocess as _sp

        si = _sp.STARTUPINFO()
        si.dwFlags |= _sp.STARTF_USESHOWWINDOW
        si.wShowWindow = 0  # SW_HIDE
        creation["startupinfo"] = si
    except Exception:
        pass
    proc = await asyncio.create_subprocess_exec(
        shell,
        *args,
        cwd=cwd,
        env=env,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
        **creation,
    )
    return _PipePtySession(proc, shell)


@router.websocket("/pty")
async def workspace_pty_ws(
    websocket: WebSocket,
    cwd: str | None = Query(default=None),
    root: str | None = Query(default=None),
    thread_id: str | None = Query(default=None),
    cols: int = Query(default=_DEFAULT_COLS),
    rows: int = Query(default=_DEFAULT_ROWS),
) -> None:
    """Open one interactive shell bound to the workspace cwd."""
    await websocket.accept()
    cols_n = max(2, min(int(cols or _DEFAULT_COLS), 512))
    rows_n = max(2, min(int(rows or _DEFAULT_ROWS), 256))
    work_cwd = _resolve_cwd(cwd, root, thread_id)
    session: _PipePtySession | _UnixPtySession | None = None
    closed = False

    async def send(payload: dict[str, Any]) -> None:
        nonlocal closed
        if closed:
            return
        try:
            await websocket.send_text(_json_msg(payload))
        except Exception:
            closed = True

    try:
        session = await _spawn_session(cwd=work_cwd, cols=cols_n, rows=rows_n)
    except Exception as exc:
        logger.exception("workspace_pty: spawn failed cwd=%s", work_cwd)
        await send({"op": "error", "message": f"Failed to start terminal: {exc}"})
        await websocket.close(code=1011)
        return

    await send({"op": "ready", "id": session.id, "shell": session.shell, "cwd": work_cwd})

    async def pump_stdout() -> None:
        assert session is not None
        try:
            while True:
                chunk = await session.read_chunk()
                if not chunk:
                    break
                text = chunk.decode("utf-8", errors="replace")
                await send({"op": "data", "data": text})
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.debug("workspace_pty: stdout pump ended", exc_info=True)
        finally:
            try:
                code = await session.wait()
            except Exception:
                code = -1
            await send({"op": "exit", "code": int(code)})

    reader_task = asyncio.create_task(pump_stdout())
    try:
        while True:
            raw = await websocket.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if not isinstance(msg, dict):
                continue
            op = str(msg.get("op") or "").strip().lower()
            if op == "write":
                data = str(msg.get("data") or "")
                if len(data) > _MAX_WRITE_CHARS:
                    data = data[:_MAX_WRITE_CHARS]
                await session.write(data)
            elif op == "resize":
                await session.resize(
                    int(msg.get("cols") or cols_n),
                    int(msg.get("rows") or rows_n),
                )
            elif op == "dispose":
                break
    except WebSocketDisconnect:
        pass
    except Exception:
        logger.debug("workspace_pty: client loop ended", exc_info=True)
    finally:
        closed = True
        reader_task.cancel()
        try:
            await reader_task
        except asyncio.CancelledError:
            pass
        except Exception:
            pass
        if session is not None:
            session.kill()
