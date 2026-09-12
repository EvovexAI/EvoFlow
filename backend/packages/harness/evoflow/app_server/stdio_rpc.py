"""Newline-delimited JSON-RPC app-server (stdio or local TCP).

Desktop clients use this pipe; the web UI keeps HTTP/SSE to Gateway.
``turn/start`` proxies Gateway ``/runs/stream`` and emits structured
``stream/event`` notifications (event name + parsed data) — native-style
deltas over RPC — rather than re-wrapping raw SSE text.
"""

from __future__ import annotations

import asyncio
import json
import sys
from collections.abc import Awaitable, Callable, Iterable
from dataclasses import dataclass, field
from typing import Any, TextIO

from evoflow.app_server.chat_bridge import proxy_gateway_call, proxy_sse_stream, proxy_turn_stream

PROTOCOL_VERSION = 1

NotifyFn = Callable[[dict[str, Any]], Awaitable[None] | None]


@dataclass
class StdioAppServer:
    """Request router used by unit tests and the async serve loop."""

    initialized: bool = False
    client_name: str = ""
    gateway_base_url: str = ""
    authorization: str = ""
    # When set (serve loop), notifications flush to stdout immediately.
    on_notify: NotifyFn | None = None
    _writes: list[dict[str, Any]] = field(default_factory=list)
    _aborted_turns: set[str] = field(default_factory=set)
    _active_turn_ids: set[str] = field(default_factory=set)

    def write(self, message: dict[str, Any]) -> None:
        self._writes.append(message)

    def drain_writes(self) -> list[dict[str, Any]]:
        out = list(self._writes)
        self._writes.clear()
        return out

    async def notify(self, message: dict[str, Any]) -> None:
        """Prefer live stdout flush; fall back to buffered writes (unit tests)."""
        if self.on_notify is not None:
            maybe = self.on_notify(message)
            if maybe is not None and hasattr(maybe, "__await__"):
                await maybe
            return
        self.write(message)

    def _mark_abort(self, turn_id: str | None = None) -> None:
        tid = str(turn_id or "").strip()
        if tid:
            self._aborted_turns.add(tid)
            return
        # No turnId → abort every active stream (legacy)
        self._aborted_turns.update(self._active_turn_ids)

    def _is_aborted(self, turn_id: str) -> bool:
        return str(turn_id) in self._aborted_turns

    def _begin_turn(self, turn_id: str) -> None:
        tid = str(turn_id)
        self._aborted_turns.discard(tid)
        self._active_turn_ids.add(tid)

    def _end_turn(self, turn_id: str) -> None:
        tid = str(turn_id)
        self._active_turn_ids.discard(tid)
        self._aborted_turns.discard(tid)

    def handle_message(self, message: dict[str, Any]) -> list[asyncio.Task[Any]]:
        """Handle one JSON-RPC message. Returns background tasks (e.g. turn stream)."""
        method = message.get("method")
        msg_id = message.get("id")
        params = message.get("params") if isinstance(message.get("params"), dict) else {}
        tasks: list[asyncio.Task[Any]] = []

        if not isinstance(method, str) or not method:
            if msg_id is not None:
                self._error(msg_id, -32600, "Invalid Request: missing method")
            return tasks

        if msg_id is None:
            if method == "initialized":
                return tasks
            if method == "turn/interrupt":
                tid = params.get("turnId") or params.get("turn_id")
                self._mark_abort(str(tid).strip() if isinstance(tid, str) else None)
            return tasks

        if method == "initialize":
            if self.initialized:
                self._error(msg_id, -32000, "Already initialized")
                return tasks
            info = params.get("clientInfo") if isinstance(params.get("clientInfo"), dict) else {}
            name = info.get("name")
            self.client_name = str(name).strip() if isinstance(name, str) else ""
            gw = params.get("gatewayBaseUrl") or params.get("gateway_base_url")
            if isinstance(gw, str) and gw.strip():
                self.gateway_base_url = gw.strip().rstrip("/")
            auth = params.get("authorization") or params.get("Authorization")
            if isinstance(auth, str) and auth.strip():
                self.authorization = auth.strip()
            self.initialized = True
            self._result(
                msg_id,
                {
                    "protocolVersion": PROTOCOL_VERSION,
                    "serverInfo": {"name": "evoflow-app-server", "version": "1"},
                    "userAgent": f"EvoFlow-AppServer/{PROTOCOL_VERSION}",
                    "capabilities": {
                        "turnStart": True,
                        "streamSse": True,
                        "gatewayCall": True,
                        "gatewayStream": True,
                        "threadStart": True,
                        "threadResume": True,
                        "resourcesCall": True,
                    },
                },
            )
            return tasks

        if not self.initialized:
            self._error(msg_id, -32000, "Not initialized")
            return tasks

        if method == "server/configure":
            gw = params.get("gatewayBaseUrl") or params.get("gateway_base_url")
            if isinstance(gw, str) and gw.strip():
                self.gateway_base_url = gw.strip().rstrip("/")
            auth = params.get("authorization") or params.get("Authorization")
            if isinstance(auth, str):
                self.authorization = auth.strip()
            self._result(
                msg_id,
                {"ok": True, "gatewayBaseUrl": self.gateway_base_url or None},
            )
            return tasks

        if method == "server/ping":
            self._result(
                msg_id,
                {
                    "ok": True,
                    "client": self.client_name or None,
                    "gatewayBaseUrl": self.gateway_base_url or None,
                },
            )
            return tasks

        if method in ("gateway/call", "resources/call"):
            gateway = str(params.get("gatewayBaseUrl") or self.gateway_base_url or "").strip().rstrip("/")
            if not gateway:
                self._error(msg_id, -32000, "gatewayBaseUrl not configured")
                return tasks
            path = str(params.get("path") or "").strip()
            if not path:
                self._error(msg_id, -32602, "path required")
                return tasks
            http_method = str(params.get("method") or "GET")
            body = params.get("body")
            query = params.get("query") if isinstance(params.get("query"), dict) else None
            extra = params.get("headers") if isinstance(params.get("headers"), dict) else None
            auth = params.get("authorization") or params.get("Authorization") or self.authorization
            auth_s = str(auth).strip() if isinstance(auth, str) else self.authorization
            timeout_ms = params.get("timeoutMs") or params.get("timeout_ms")
            timeout_i = int(timeout_ms) if isinstance(timeout_ms, (int, float)) else None

            async def _run_call() -> None:
                try:
                    result = await proxy_gateway_call(
                        gateway_base=gateway,
                        method=http_method,
                        path=path,
                        body=body,
                        query=query,
                        authorization=auth_s or None,
                        headers={str(k): str(v) for k, v in (extra or {}).items()},
                        timeout_ms=timeout_i,
                    )
                    self.write({"id": msg_id, "result": result})
                except Exception as exc:  # noqa: BLE001
                    self.write(
                        {
                            "id": msg_id,
                            "error": {"code": -32000, "message": str(exc)},
                        }
                    )

            try:
                loop = asyncio.get_running_loop()
                tasks.append(loop.create_task(_run_call()))
            except RuntimeError:
                self._error(msg_id, -32000, f"{method} requires async serve loop")
            return tasks

        if method == "thread/start":
            gateway = str(params.get("gatewayBaseUrl") or self.gateway_base_url or "").strip().rstrip("/")
            if not gateway:
                self._error(msg_id, -32000, "gatewayBaseUrl not configured")
                return tasks
            session_key = str(params.get("sessionKey") or params.get("session_key") or "").strip()
            thread_id = str(params.get("threadId") or params.get("thread_id") or "").strip()
            metadata = params.get("metadata") if isinstance(params.get("metadata"), dict) else {}
            meta = dict(metadata)
            if session_key and "session_key" not in meta:
                meta["session_key"] = session_key
            body: dict[str, Any] = {"metadata": meta}
            if thread_id:
                body["thread_id"] = thread_id
            auth = params.get("authorization") or params.get("Authorization") or self.authorization
            auth_s = str(auth).strip() if isinstance(auth, str) else self.authorization

            async def _run_thread_start() -> None:
                try:
                    result = await proxy_gateway_call(
                        gateway_base=gateway,
                        method="POST",
                        path="/api/langgraph/threads",
                        body=body,
                        authorization=auth_s or None,
                    )
                    if not result.get("ok"):
                        # Retry without explicit thread_id (compat)
                        if thread_id:
                            result = await proxy_gateway_call(
                                gateway_base=gateway,
                                method="POST",
                                path="/api/langgraph/threads",
                                body={"metadata": meta},
                                authorization=auth_s or None,
                            )
                    payload = result.get("body") if isinstance(result.get("body"), dict) else {}
                    tid = str(
                        payload.get("thread_id")
                        or payload.get("threadId")
                        or (payload.get("thread") or {}).get("thread_id")
                        or ""
                    ).strip()
                    out = {
                        "threadId": tid or None,
                        "sessionKey": session_key or None,
                        "thread": payload,
                        "ok": bool(result.get("ok")),
                        "status": result.get("status"),
                    }
                    self.write({"id": msg_id, "result": out})
                    if tid:
                        self.write(
                            {
                                "method": "thread/started",
                                "params": {"threadId": tid, "sessionKey": session_key or None},
                            }
                        )
                except Exception as exc:  # noqa: BLE001
                    self.write(
                        {
                            "id": msg_id,
                            "error": {"code": -32000, "message": str(exc)},
                        }
                    )

            try:
                loop = asyncio.get_running_loop()
                tasks.append(loop.create_task(_run_thread_start()))
            except RuntimeError:
                self._error(msg_id, -32000, "thread/start requires async serve loop")
            return tasks

        if method == "thread/resume":
            thread_id = str(params.get("threadId") or params.get("thread_id") or "").strip()
            session_key = str(params.get("sessionKey") or params.get("session_key") or "").strip()
            if not thread_id:
                self._error(msg_id, -32602, "threadId required")
                return tasks
            self._result(
                msg_id,
                {"threadId": thread_id, "sessionKey": session_key or None, "ok": True},
            )
            self.write(
                {
                    "method": "thread/started",
                    "params": {"threadId": thread_id, "sessionKey": session_key or None, "resumed": True},
                }
            )
            return tasks

        if method == "demo/stream":
            text = params.get("text")
            chunk = str(text) if isinstance(text, str) and text else "hello"
            self._result(msg_id, {"accepted": True})
            self.write({"method": "demo/delta", "params": {"delta": chunk}})
            self.write({"method": "demo/completed", "params": {"text": chunk}})
            return tasks

        if method == "turn/interrupt":
            tid = params.get("turnId") or params.get("turn_id")
            self._mark_abort(str(tid).strip() if isinstance(tid, str) else None)
            self._result(msg_id, {"ok": True})
            return tasks

        if method == "turn/start":
            thread_id = str(params.get("threadId") or params.get("thread_id") or "").strip()
            body = params.get("body")
            if not thread_id:
                self._error(msg_id, -32602, "threadId required")
                return tasks
            if not isinstance(body, dict):
                self._error(msg_id, -32602, "body object required")
                return tasks
            gateway = str(params.get("gatewayBaseUrl") or self.gateway_base_url or "").strip().rstrip("/")
            if not gateway:
                self._error(msg_id, -32000, "gatewayBaseUrl not configured")
                return tasks
            auth = params.get("authorization") or params.get("Authorization") or self.authorization
            auth_s = str(auth).strip() if isinstance(auth, str) else self.authorization
            query = params.get("query") if isinstance(params.get("query"), dict) else None
            extra = params.get("headers") if isinstance(params.get("headers"), dict) else None
            turn_id = str(params.get("turnId") or params.get("clientRunId") or msg_id)
            self._begin_turn(turn_id)

            # Accept immediately; stream continues via notifications then final result.
            self._result(msg_id, {"accepted": True, "turnId": turn_id, "threadId": thread_id})
            self.write(
                {
                    "method": "turn/started",
                    "params": {"turnId": turn_id, "threadId": thread_id},
                }
            )

            async def _run_turn() -> None:
                try:

                    async def emit(message: dict[str, Any]) -> None:
                        # Stamped for client demux when multiple turns exist later.
                        params_obj = message.get("params")
                        if isinstance(params_obj, dict) and "turnId" not in params_obj:
                            params_obj = {**params_obj, "turnId": turn_id}
                            message = {**message, "params": params_obj}
                        await self.notify(message)

                    summary = await proxy_turn_stream(
                        gateway_base=gateway,
                        thread_id=thread_id,
                        body=body,
                        authorization=auth_s or None,
                        query=query,
                        extra_headers={str(k): str(v) for k, v in (extra or {}).items()},
                        emit=emit,
                        should_abort=lambda: self._is_aborted(turn_id),
                    )
                    await self.notify(
                        {
                            "method": "turn/result",
                            "params": {**summary, "turnId": turn_id},
                        }
                    )
                except Exception as exc:  # noqa: BLE001 — surface to client
                    await self.notify(
                        {
                            "method": "turn/error",
                            "params": {
                                "turnId": turn_id,
                                "threadId": thread_id,
                                "message": str(exc),
                            },
                        }
                    )
                finally:
                    self._end_turn(turn_id)

            try:
                loop = asyncio.get_running_loop()
                tasks.append(loop.create_task(_run_turn()))
            except RuntimeError:
                # Sync unit-test path without a loop: run demo-style failure.
                self.write(
                    {
                        "method": "turn/error",
                        "params": {
                            "turnId": turn_id,
                            "threadId": thread_id,
                            "message": "turn/start requires async serve loop",
                        },
                    }
                )
                self._end_turn(turn_id)
            return tasks

        if method == "gateway/stream":
            gateway = str(params.get("gatewayBaseUrl") or self.gateway_base_url or "").strip().rstrip("/")
            if not gateway:
                self._error(msg_id, -32000, "gatewayBaseUrl not configured")
                return tasks
            path = str(params.get("path") or "").strip()
            if not path:
                self._error(msg_id, -32602, "path required")
                return tasks
            http_method = str(params.get("method") or "GET")
            body = params.get("body")
            query = params.get("query") if isinstance(params.get("query"), dict) else None
            extra = params.get("headers") if isinstance(params.get("headers"), dict) else None
            auth = params.get("authorization") or params.get("Authorization") or self.authorization
            auth_s = str(auth).strip() if isinstance(auth, str) else self.authorization
            turn_id = str(params.get("turnId") or params.get("clientRunId") or msg_id)
            self._begin_turn(turn_id)
            self._result(msg_id, {"accepted": True, "turnId": turn_id, "path": path})

            async def _run_stream() -> None:
                try:

                    async def emit(message: dict[str, Any]) -> None:
                        params_obj = message.get("params")
                        if isinstance(params_obj, dict) and "turnId" not in params_obj:
                            params_obj = {**params_obj, "turnId": turn_id}
                            message = {**message, "params": params_obj}
                        await self.notify(message)

                    summary = await proxy_sse_stream(
                        gateway_base=gateway,
                        method=http_method,
                        path=path,
                        body=body if isinstance(body, dict) else None,
                        query=query,
                        authorization=auth_s or None,
                        extra_headers={str(k): str(v) for k, v in (extra or {}).items()},
                        emit=emit,
                        should_abort=lambda: self._is_aborted(turn_id),
                    )
                    await self.notify(
                        {
                            "method": "turn/result",
                            "params": {**summary, "turnId": turn_id},
                        }
                    )
                except Exception as exc:  # noqa: BLE001
                    await self.notify(
                        {
                            "method": "turn/error",
                            "params": {
                                "turnId": turn_id,
                                "path": path,
                                "message": str(exc),
                            },
                        }
                    )
                finally:
                    self._end_turn(turn_id)

            try:
                loop = asyncio.get_running_loop()
                tasks.append(loop.create_task(_run_stream()))
            except RuntimeError:
                self.write(
                    {
                        "method": "turn/error",
                        "params": {
                            "turnId": turn_id,
                            "path": path,
                            "message": "gateway/stream requires async serve loop",
                        },
                    }
                )
            return tasks

        self._error(msg_id, -32601, f"Method not found: {method}")
        return tasks

    def _result(self, msg_id: Any, result: Any) -> None:
        self.write({"id": msg_id, "result": result})

    def _error(self, msg_id: Any, code: int, message: str) -> None:
        self.write({"id": msg_id, "error": {"code": code, "message": message}})


def serve_stdio(
    stdin: TextIO | None = None,
    stdout: TextIO | None = None,
    lines: Iterable[str] | None = None,
) -> int:
    """Sync helper for tests / simple CLI without an event loop."""
    return asyncio.run(serve_stdio_async(stdin=stdin, stdout=stdout, lines=lines))


async def serve_stdio_async(
    stdin: TextIO | None = None,
    stdout: TextIO | None = None,
    lines: Iterable[str] | None = None,
    gateway_base_url: str = "",
) -> int:
    server = StdioAppServer(gateway_base_url=gateway_base_url.strip().rstrip("/"))
    in_stream = stdin if stdin is not None else sys.stdin
    out_stream = stdout if stdout is not None else sys.stdout
    write_lock = asyncio.Lock()
    pending: set[asyncio.Task[Any]] = set()

    async def emit(message: dict[str, Any]) -> None:
        line = json.dumps(message, ensure_ascii=False, separators=(",", ":")) + "\n"
        async with write_lock:
            out_stream.write(line)
            out_stream.flush()

    # Live notify for turn streams — do not wait for the pump poll interval.
    server.on_notify = emit

    async def flush_server_writes() -> None:
        for msg in server.drain_writes():
            await emit(msg)

    async def pump_task(task: asyncio.Task[Any]) -> None:
        # Keep the poll tight: chat SSE shim buffers into self.write(); a 50ms
        # drain interval made token streaming feel much slower than direct HTTP.
        try:
            while not task.done():
                await flush_server_writes()
                await asyncio.wait({task}, timeout=0.005)
            await task
        finally:
            await flush_server_writes()
            pending.discard(task)

    source = lines if lines is not None else in_stream
    if lines is not None:
        for raw in source:
            line = raw.strip() if isinstance(raw, str) else str(raw).strip()
            if not line:
                continue
            await _dispatch_line(server, line, emit, flush_server_writes, pump_task, pending)
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)
            await flush_server_writes()
        return 0

    # Real stdin: read in a worker thread so we can interleave stream writes.
    loop = asyncio.get_running_loop()
    queue: asyncio.Queue[str | None] = asyncio.Queue()

    def _reader() -> None:
        try:
            for raw in in_stream:
                loop.call_soon_threadsafe(queue.put_nowait, raw)
        finally:
            loop.call_soon_threadsafe(queue.put_nowait, None)

    reader_fut = loop.run_in_executor(None, _reader)
    while True:
        raw = await queue.get()
        if raw is None:
            break
        line = raw.strip() if isinstance(raw, str) else str(raw).strip()
        if not line:
            continue
        await _dispatch_line(server, line, emit, flush_server_writes, pump_task, pending)
    await reader_fut
    if pending:
        await asyncio.gather(*pending, return_exceptions=True)
        await flush_server_writes()
    return 0


async def _dispatch_line(
    server: StdioAppServer,
    line: str,
    emit: Callable[[dict[str, Any]], Any],
    flush_server_writes: Callable[[], Any],
    pump_task: Callable[[asyncio.Task[Any]], Any],
    pending: set[asyncio.Task[Any]],
) -> None:
    try:
        parsed = json.loads(line)
    except json.JSONDecodeError:
        await emit({"id": None, "error": {"code": -32700, "message": "Parse error"}})
        return
    if not isinstance(parsed, dict):
        await emit({"id": None, "error": {"code": -32600, "message": "Invalid Request"}})
        return
    tasks = server.handle_message(parsed)
    await flush_server_writes()
    for task in tasks:
        pending.add(task)
        asyncio.create_task(pump_task(task))


async def _make_tcp_connection_handler(gateway_base_url: str = ""):
    base = gateway_base_url.strip().rstrip("/")

    async def handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        server = StdioAppServer(gateway_base_url=base)
        write_lock = asyncio.Lock()
        pending: set[asyncio.Task[Any]] = set()

        async def emit(message: dict[str, Any]) -> None:
            data = (json.dumps(message, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
            async with write_lock:
                writer.write(data)
                await writer.drain()

        server.on_notify = emit

        async def flush_server_writes() -> None:
            for msg in server.drain_writes():
                await emit(msg)

        async def pump_task(task: asyncio.Task[Any]) -> None:
            try:
                while not task.done():
                    await flush_server_writes()
                    await asyncio.wait({task}, timeout=0.005)
                await task
            finally:
                await flush_server_writes()
                pending.discard(task)

        try:
            while True:
                raw = await reader.readline()
                if not raw:
                    break
                line = raw.decode("utf-8", errors="replace").strip()
                if not line:
                    continue
                await _dispatch_line(server, line, emit, flush_server_writes, pump_task, pending)
        finally:
            if pending:
                await asyncio.gather(*pending, return_exceptions=True)
                await flush_server_writes()
            writer.close()
            try:
                await writer.wait_closed()
            except Exception:  # noqa: BLE001
                pass

    return handle


async def serve_tcp_server(host: str, port: int, gateway_base_url: str = "") -> asyncio.AbstractServer:
    """Bind TCP JSONL server and return it (caller runs serve_forever / owns lifecycle)."""
    handle = await _make_tcp_connection_handler(gateway_base_url)
    server = await asyncio.start_server(handle, host, port)
    sockets = server.sockets or []
    bound = sockets[0].getsockname() if sockets else (host, port)
    print(f"[evoflow-app-server] listening on {bound[0]}:{bound[1]}", file=sys.stderr, flush=True)
    return server


async def serve_tcp(host: str, port: int, gateway_base_url: str = "") -> None:
    """Local TCP JSONL server (Windows-friendly pipe equivalent)."""
    server = await serve_tcp_server(host, port, gateway_base_url=gateway_base_url)
    async with server:
        await server.serve_forever()


def main_argv(argv: list[str] | None = None) -> int:
    """CLI entry: stdio by default, or ``--listen HOST:PORT``."""
    args = list(sys.argv[1:] if argv is None else argv)
    gateway = ""
    listen = ""
    i = 0
    while i < len(args):
        if args[i] == "--gateway-url" and i + 1 < len(args):
            gateway = args[i + 1]
            i += 2
            continue
        if args[i].startswith("--gateway-url="):
            gateway = args[i].split("=", 1)[1]
            i += 1
            continue
        if args[i] == "--listen" and i + 1 < len(args):
            listen = args[i + 1]
            i += 2
            continue
        if args[i].startswith("--listen="):
            listen = args[i].split("=", 1)[1]
            i += 1
            continue
        i += 1

    if listen:
        listen_l = listen.strip().lower()
        if listen_l in ("stdio", "stdio://", "off", "-"):
            listen = ""
    if listen:
        host, _, port_s = listen.rpartition(":")
        host = host.strip() or "127.0.0.1"
        port = int(port_s or "0")
        asyncio.run(serve_tcp(host, port, gateway_base_url=gateway))
        return 0
    return asyncio.run(serve_stdio_async(gateway_base_url=gateway))
