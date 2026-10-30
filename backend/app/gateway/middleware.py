"""Gateway middleware."""

from __future__ import annotations

import asyncio
import json
import logging
import time
from collections.abc import Callable
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import ValidationError
from starlette.datastructures import URL, Headers
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.middleware.cors import CORSMiddleware

from app.gateway.routers.errors import (
    ErrorCode,
    ErrorDetail,
    create_error_response,
)
from app.gateway.hang_diagnostics import (
    register_inflight_request,
    unregister_inflight_request,
    update_inflight_request,
    is_event_loop_overloaded,
)

logger = logging.getLogger(__name__)

_BODY_SAMPLE_LIMIT = 4096
_BODY_READ_LIMIT = 65536
_GATEWAY_JSON_LIMIT = 512
_SENSITIVE_KEY_PARTS = ("authorization", "cookie", "password", "passwd", "token", "secret", "api_key", "apikey", "x-api-key", "private_key", "client_secret", "access_key", "secret_key", "credentials")
_EXCLUDED_OBS_PATHS = (
    "/api/observability",
    "/health",
    "/docs",
    "/redoc",
    "/openapi.json",
    "/api/session-notifications",
)
_EXCLUDED_OBS_PREFIXES = ("/api/proactive/roles/",)


def _is_sensitive_name(name: str) -> bool:
    n = str(name or "").replace("-", "_").lower()
    return any(part in n for part in _SENSITIVE_KEY_PARTS)


def _redact_value(value: Any) -> Any:
    if isinstance(value, dict):
        return {str(k): ("[REDACTED]" if _is_sensitive_name(str(k)) else _redact_value(v)) for k, v in value.items()}
    if isinstance(value, list):
        return [_redact_value(v) for v in value]
    return value


def _header_raw_pairs(headers: Any) -> list[tuple[bytes, bytes]]:
    """ASGI/Starlette header pairs; never use ``dict(headers)``.

    ``starlette.datastructures.Headers`` keeps raw key bytes as-is. ``keys()``
    returns that original casing, but ``__getitem__`` lowercases the lookup and
    byte-compares against the stored key — so Title-Case stored keys make
    ``dict(headers)`` raise ``KeyError`` (see EvovexAI/EvoFlow#93).
    """
    if headers is None:
        return []
    raw = getattr(headers, "raw", None)
    if raw is not None:
        return list(raw)
    if isinstance(headers, dict):
        out: list[tuple[bytes, bytes]] = []
        for k, v in headers.items():
            kb = k.encode("latin-1") if isinstance(k, str) else bytes(k)
            vb = v.encode("latin-1") if isinstance(v, str) else bytes(v)
            out.append((kb, vb))
        return out
    return []


def _header_get(headers: Any, name: str) -> str | None:
    """Case-insensitive header read that tolerates Title-Case raw keys."""
    target = name.lower().encode("latin-1")
    for key, val in _header_raw_pairs(headers):
        if key.lower() == target:
            return val.decode("latin-1")
    return None


def _redact_headers(headers: Any) -> dict[str, str]:
    out: dict[str, str] = {}
    try:
        for key_b, val_b in _header_raw_pairs(headers):
            key = key_b.decode("latin-1")
            out[key] = "[REDACTED]" if _is_sensitive_name(key) else val_b.decode("latin-1")
    except Exception:
        logger.debug("failed to redact headers", exc_info=True)
    return out


def _sampleable_content_type(content_type: str | None) -> bool:
    ct = (content_type or "").lower()
    if not ct:
        return False
    return "json" in ct or ct.startswith("text/") or "xml" in ct or "x-www-form-urlencoded" in ct


def _is_streaming_request_path(path: str) -> bool:
    """True for long-lived SSE / stream endpoints that must not enter hang inflight.

    Mis-classifying panel-stream / v4 frames as REST caused false hang dumps
    (wait=2000s+) and drowned the real stuck endpoints (git_status etc.).
    """
    p = str(path or "")
    if "/runs/stream" in p or "/resume-stream" in p:
        return True
    if p.endswith("/panel-stream") or "/panel-stream?" in p:
        return True
    if "/conversation/frames" in p:
        return True
    if p.endswith("/stream") or "/stream?" in p:
        # Catch-all for AG-UI / events SSE siblings without listing every route.
        if "/api/events/" in p or "/api/v4/" in p or "/api/langgraph/" in p:
            return True
    return False


def _skip_response_body(content_type: str | None, headers: Any) -> bool:
    ct = (content_type or "").lower()
    disp = (_header_get(headers, "content-disposition") or "").lower()
    return "text/event-stream" in ct or "attachment" in disp or not _sampleable_content_type(ct)


def _content_length(headers: Any) -> int | None:
    raw = _header_get(headers, "content-length")
    try:
        return int(raw) if raw is not None else None
    except (TypeError, ValueError):
        return None


def _body_sample(raw: bytes, content_type: str | None) -> tuple[str | None, bool]:
    if not raw:
        return None, False
    truncated = len(raw) > _BODY_SAMPLE_LIMIT
    preview = raw[:_BODY_SAMPLE_LIMIT].decode("utf-8", errors="replace")
    if "json" in (content_type or "").lower():
        try:
            obj = json.loads(raw.decode("utf-8", errors="replace"))
            text = json.dumps(_redact_value(obj), ensure_ascii=False, default=str)
            return (text[:_BODY_SAMPLE_LIMIT], len(text) > _BODY_SAMPLE_LIMIT)
        except Exception:
            pass
    return preview, truncated


def _client_ip(headers: Headers, client: Any) -> str | None:
    fwd = (headers.get("x-forwarded-for") or "").split(",", 1)[0].strip()
    if fwd:
        return fwd
    real = (headers.get("x-real-ip") or "").strip()
    if real:
        return real
    if isinstance(client, (list, tuple)) and client:
        return str(client[0])
    return None


def _excluded_from_gateway_logging(path: str) -> bool:
    if any(path == p or path.startswith(f"{p}/") for p in _EXCLUDED_OBS_PATHS):
        return True
    return any(path.startswith(prefix) for prefix in _EXCLUDED_OBS_PREFIXES)


def _gateway_body_samples_enabled() -> bool:
    import os

    raw = (os.getenv("EVOFLOW_OBS_GATEWAY_BODY_SAMPLES") or "").strip().lower()
    return raw in ("1", "true", "yes", "on")


def _read_event_loop_lag() -> float:
    """Safe wrapper used by middlewares (do NOT call get_event_loop_lag_seconds at import time)."""
    try:
        from app.gateway.hang_diagnostics import get_event_loop_lag_seconds
        return get_event_loop_lag_seconds()
    except Exception:
        return 0.0


from app.gateway.gateway_obs_record import normalize_gateway_obs_path, schedule_gateway_observability_record  # noqa: E402


def _occurred_at() -> str:
    try:
        from evoflow.timeutil import beijing_now_iso

        return beijing_now_iso()
    except Exception:
        return ""


class GatewayRequestLoggingMiddleware:
    def __init__(self, app: Any) -> None:
        self.app = app

    async def __call__(self, scope: dict[str, Any], receive: Callable, send: Callable) -> None:
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return

        path = str(scope.get("path") or "")
        method = str(scope.get("method") or "").upper()
        scope_id = id(scope)
        if method == "POST" and "/tool-approval" in path:
            logger.info("HTTP tool-approval received path=%s", path)
        if _excluded_from_gateway_logging(path):
            await self.app(scope, receive, send)
            return

        # Cross-cuts: register this request with hang_diagnostics so a stuck
        # event-loop dump reports not just asyncio tasks but also "which REST
        # endpoints were waiting at the time of the hang".
        # Stream requests are intentionally excluded — they are expected to be
        # long-lived and would otherwise drown the registry.
        is_streaming = _is_streaming_request_path(path)
        if not is_streaming:
            register_inflight_request(
                scope_id=scope_id,
                method=method,
                path=path,
                query=str(URL(scope=scope).query or "") or None,
            )

        started = time.perf_counter()
        request_headers = Headers(scope=scope)
        request_url = URL(scope=scope)
        request_content_type = request_headers.get("content-type")
        request_content_length = _content_length(request_headers)
        sample_request_body = _gateway_body_samples_enabled() and not _is_streaming_request_path(path) and _sampleable_content_type(request_content_type) and request_content_length is not None and request_content_length <= _BODY_READ_LIMIT
        request_body = bytearray()
        request_body_truncated = False

        status_code: int | None = None
        response_headers = Headers(raw=[])
        response_content_type: str | None = None
        sample_response_body = False
        response_body = bytearray()
        response_body_truncated = False
        response_started = False
        logged = False

        def record(error_type: str | None = None, stream_status: str | None = None) -> None:
            nonlocal logged
            if logged:
                return
            logged = True
            # Observability must never take down the business response (#93).
            try:
                duration_s = time.perf_counter() - started
                # Surface the exact symptom the user reported:
                # "流式对话期间其他接口全卡死，watch 这个日志就能看到"。
                # A non-stream request that took > 3s AND the gateway is currently
                # overloaded → was probably starved by a stream run, not slow itself.
                if not is_streaming and duration_s >= 3.0:
                    if is_event_loop_overloaded():
                        logger.warning(
                            "[STREAM_BLOCK_SUSPECT] %s %s took %.2fs while gateway overloaded "
                            "(event_loop_lag=%.2fs); a stream run was likely starving the loop",
                            method, path, duration_s,
                            _read_event_loop_lag(),
                        )
                req_sample, req_truncated = _body_sample(bytes(request_body), request_content_type) if sample_request_body else (None, False)
                resp_sample, resp_truncated = _body_sample(bytes(response_body), response_content_type) if sample_response_body else (None, False)
                metadata = {
                    "scheme": scope.get("scheme"),
                    "host": request_headers.get("host"),
                }
                if stream_status:
                    metadata["stream_status"] = stream_status
                if not is_streaming:
                    unregister_inflight_request(scope_id)
                schedule_gateway_observability_record(
                    {
                        "occurred_at": _occurred_at(),
                        "method": scope.get("method") or "",
                        "path": normalize_gateway_obs_path(path),
                        "query_string": request_url.query or None,
                        "client_ip": _client_ip(request_headers, scope.get("client")),
                        "user_agent": request_headers.get("user-agent"),
                        "request_content_type": request_content_type,
                        "response_content_type": response_content_type,
                        "status_code": status_code if status_code is not None else 500,
                        "duration_ms": round((time.perf_counter() - started) * 1000, 2),
                        "request_headers": _redact_headers(request_headers),
                        "response_headers": _redact_headers(response_headers),
                        "request_body_sample": req_sample,
                        "response_body_sample": resp_sample,
                        "request_body_truncated": request_body_truncated or req_truncated,
                        "response_body_truncated": response_body_truncated or resp_truncated,
                        "error_type": error_type,
                        "metadata": metadata,
                    }
                )
            except Exception:
                logger.exception("gateway observability record failed for %s %s", method, path)
                if not is_streaming:
                    try:
                        unregister_inflight_request(scope_id)
                    except Exception:
                        pass

        async def logging_receive() -> dict[str, Any]:
            nonlocal request_body_truncated
            message = await receive()
            if message.get("type") == "http.request" and sample_request_body:
                chunk = message.get("body") or b""
                remaining = _BODY_READ_LIMIT - len(request_body)
                if remaining > 0:
                    request_body.extend(chunk[:remaining])
                if len(chunk) > remaining:
                    request_body_truncated = True
            return message

        async def logging_send(message: dict[str, Any]) -> None:
            nonlocal status_code, response_headers, response_content_type, sample_response_body, response_started, response_body_truncated
            if message.get("type") == "http.response.start":
                response_started = True
                status_code = int(message.get("status") or 500)
                response_headers = Headers(raw=message.get("headers") or [])
                # Prefer raw-pair lookup: Title-Case keys break Headers.get (#93).
                response_content_type = _header_get(response_headers, "content-type")
                response_length = _content_length(response_headers)
                sample_response_body = _gateway_body_samples_enabled() and not _skip_response_body(response_content_type, response_headers) and response_length is not None and response_length <= _BODY_READ_LIMIT
            elif message.get("type") == "http.response.body":
                if sample_response_body:
                    chunk = message.get("body") or b""
                    remaining = _BODY_READ_LIMIT - len(response_body)
                    if remaining > 0:
                        response_body.extend(chunk[:remaining])
                    if len(chunk) > remaining:
                        response_body_truncated = True
                if not message.get("more_body", False):
                    record(stream_status="completed" if "text/event-stream" in (response_content_type or "").lower() else None)
            await send(message)

        try:
            await self.app(scope, logging_receive, logging_send)
        except asyncio.CancelledError:
            if response_started:
                record(stream_status="cancelled" if "text/event-stream" in (response_content_type or "").lower() else None)
            elif not is_streaming:
                unregister_inflight_request(scope_id)
            raise
        except Exception as exc:
            record(error_type=exc.__class__.__name__, stream_status="error" if response_started and "text/event-stream" in (response_content_type or "").lower() else None)
            raise
        finally:
            # Belt-and-braces: if record() wasn't called for any reason (e.g.
            # an uncaught BaseException, or a path that early-returned), still
            # unregister so the hang-diagnostics registry doesn't leak entries.
            if not logged and not is_streaming:
                unregister_inflight_request(scope_id)


def _content_type_needs_utf8_charset(media_type: str) -> bool:
    """True for text-ish / JSON responses that should declare charset=utf-8."""
    mt = (media_type or "").split(";", 1)[0].strip().lower()
    if not mt:
        return False
    if mt.startswith("text/"):
        return True
    if mt in ("application/json", "application/problem+json", "application/javascript"):
        return True
    if mt.endswith("+json"):
        return True
    return False


def ensure_content_type_charset_utf8(value: bytes) -> bytes:
    """Append ``charset=utf-8`` when missing (defense against HTTP clients that sniff encoding)."""
    try:
        ct = value.decode("latin-1")
    except Exception:
        return value
    lower = ct.lower()
    if "charset=" in lower:
        return value
    mime = lower.split(";", 1)[0].strip()
    if not _content_type_needs_utf8_charset(mime):
        return value
    return f"{ct}; charset=utf-8".encode("latin-1")


class Utf8CharsetMiddleware:
    """ASGI middleware: ensure JSON / text / SSE responses advertise ``charset=utf-8``.

    FastAPI/Starlette often emit ``Content-Type: application/json`` without charset.
    Some HTTP clients (notably reqwest ``.text()`` on zh-CN Windows) then sniff GBK and
    mojibake UTF-8 bodies. Explicit charset makes intent unambiguous end-to-end.
    """

    def __init__(self, app: Any) -> None:
        self.app = app

    async def __call__(self, scope: dict[str, Any], receive: Callable, send: Callable) -> None:
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return

        async def send_with_charset(message: dict[str, Any]) -> None:
            if message.get("type") == "http.response.start":
                raw_headers = list(message.get("headers") or [])
                headers: list[tuple[bytes, bytes]] = []
                for key, val in raw_headers:
                    # ASGI requires lowercase header names; keep them lower so
                    # inner middleware that wraps Headers(raw=...) never KeyErrors.
                    lower_key = key.lower()
                    if lower_key == b"content-type":
                        headers.append((b"content-type", ensure_content_type_charset_utf8(val)))
                    else:
                        headers.append((lower_key, val))
                message = {**message, "headers": headers}
            await send(message)

        await self.app(scope, receive, send_with_charset)


class ErrorHandlingMiddleware(BaseHTTPMiddleware):
    """Middleware to standardize all error responses."""

    async def dispatch(self, request: Request, call_next: Callable) -> JSONResponse:
        """Process request and standardize error responses."""
        try:
            response = await call_next(request)
            return response
        except Exception as exc:
            return self._handle_exception(request, exc)

    def _handle_exception(self, request: Request, exc: Exception) -> JSONResponse:
        """Convert any exception to standardized error response."""
        # Handle FastAPI HTTPException (which may already have our error format)
        from fastapi import HTTPException

        if isinstance(exc, HTTPException):
            # Check if detail is already in our error format
            if isinstance(exc.detail, dict) and "error_code" in exc.detail:
                # Already standardized
                return JSONResponse(
                    status_code=exc.status_code,
                    content=exc.detail,
                )
            # Convert plain HTTPException to standardized format
            error_response = create_error_response(
                error_code=ErrorCode.INTERNAL_ERROR,
                message=str(exc.detail),
            )
            return JSONResponse(
                status_code=exc.status_code,
                content=error_response,
            )

        # Handle Pydantic validation errors
        if isinstance(exc, (RequestValidationError, ValidationError)):
            details = []
            errors = exc.errors() if hasattr(exc, "errors") else []
            for error in errors:
                field = ".".join(str(loc) for loc in error.get("loc", []))
                details.append(
                    ErrorDetail(
                        field=field,
                        message=error.get("msg", ""),
                        code=error.get("type", ""),
                    )
                )

            error_response = create_error_response(
                error_code=ErrorCode.INVALID_PARAMETERS,
                message="请求参数验证失败",
                details=details,
            )
            return JSONResponse(
                status_code=400,
                content=error_response,
            )

        # Handle all other exceptions as internal errors
        logger.exception("Unhandled exception in request")
        error_response = create_error_response(
            error_code=ErrorCode.INTERNAL_ERROR,
            message="服务器内部错误",
        )
        # In debug mode, include traceback
        # error_response['debug'] = traceback.format_exc()

        return JSONResponse(
            status_code=500,
            content=error_response,
        )


def setup_middleware(app: FastAPI) -> None:
    """Register all middleware with the FastAPI app.

    This should be called during app initialization.

    Args:
        app: The FastAPI application instance
    """
    # CORS middleware — restrict to configured origins (default: localhost only)
    from app.gateway.config import get_gateway_config

    gw_config = get_gateway_config()
    app.add_middleware(
        CORSMiddleware,
        allow_origins=gw_config.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.add_middleware(GatewayRequestLoggingMiddleware)

    from app.gateway.startup_gate import StartupGateMiddleware

    app.add_middleware(StartupGateMiddleware)

    # Error handling middleware (must be last to catch all errors)
    app.add_middleware(ErrorHandlingMiddleware)

    # Outermost: stamp charset=utf-8 on JSON/text/SSE so desktop HTTP proxies never sniff GBK.
    app.add_middleware(Utf8CharsetMiddleware)


# Exception handlers that can be registered directly with FastAPI
def register_exception_handlers(app: FastAPI) -> None:
    """Register exception handlers with FastAPI app.

    Alternative to middleware approach, can be used together.

    Args:
        app: The FastAPI application instance
    """

    @app.exception_handler(RequestValidationError)
    async def validation_exception_handler(request: Request, exc: RequestValidationError) -> JSONResponse:
        """Handle validation errors."""
        details = []
        for error in exc.errors():
            field = ".".join(str(loc) for loc in error.get("loc", []))
            details.append(
                ErrorDetail(
                    field=field,
                    message=error.get("msg", ""),
                    code=error.get("type", ""),
                )
            )

        error_response = create_error_response(
            error_code=ErrorCode.INVALID_PARAMETERS,
            message="请求参数验证失败",
            details=details,
        )
        return JSONResponse(
            status_code=400,
            content=error_response,
        )

    @app.exception_handler(Exception)
    async def general_exception_handler(request: Request, exc: Exception) -> JSONResponse:
        """Handle all unhandled exceptions."""
        logger.exception("Unhandled exception")
        error_response = create_error_response(
            error_code=ErrorCode.INTERNAL_ERROR,
            message="服务器内部错误",
        )
        return JSONResponse(
            status_code=500,
            content=error_response,
        )
