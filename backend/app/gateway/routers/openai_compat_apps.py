"""OpenAI-compatible App facade: chat/completions, models, async runs.

Authenticated with app-scoped Bearer keys (``identity_type=app``).
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from typing import Any, AsyncIterator

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

from app.gateway.auth import verify_app_bearer_token
from evoflow.collab.app_openai_compat import (
    build_chat_completion_response,
    build_example_chat_request,
    build_example_chat_response,
    build_response_contract,
    build_response_data,
    collect_new_step_stream_events,
    load_app_for_run,
    map_chat_to_parameters,
    missing_required_parameters,
    openai_completions_timeout_sec,
    progress_fingerprint,
    resolve_app_id_from_request,
    should_append_final_answer_delta,
    summarize_run_content,
    wait_for_run_terminal,
)
from evoflow.collab.app_runner import cancel_run, get_run_status, run_app
from evoflow.persistence import app_repositories

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1", tags=["openai-compat-apps"])

_TERMINAL = frozenset(
    {"completed", "failed", "cancelled", "canceled", "error", "timeout"}
)


class ChatMessage(BaseModel):
    role: str
    content: Any = None


class ChatCompletionsRequest(BaseModel):
    messages: list[ChatMessage] = Field(default_factory=list)
    model: str | None = None
    stream: bool = False
    temperature: float | None = None
    # FastGPT / EvoFlow extensions
    appId: str | None = None
    variables: dict[str, Any] | None = None
    detail: bool = False
    chatId: str | None = None
    # Wave-2: fire-and-poll (mutually exclusive with stream)
    async_: bool = Field(default=False, alias="async")

    model_config = {"populate_by_name": True}


def _pinned_from_token(token_data: dict[str, Any]) -> int | None:
    raw = token_data.get("pinned_version")
    if raw is None:
        return None
    try:
        return int(raw)
    except (TypeError, ValueError):
        return None


def _public_parameters(app: dict[str, Any]) -> list[dict[str, Any]]:
    rows = app.get("parameters") if isinstance(app.get("parameters"), list) else []
    out: list[dict[str, Any]] = []
    for p in rows:
        if not isinstance(p, dict):
            continue
        name = str(p.get("name") or "").strip()
        if not name:
            continue
        out.append(
            {
                "name": name,
                "label": str(p.get("label") or name),
                "type": str(p.get("type") or "text"),
                "required": bool(p.get("required")),
                "default": p.get("default"),
                "description": str(p.get("description") or ""),
                "options": p.get("options") if isinstance(p.get("options"), list) else None,
            }
        )
    return out


def _app_model_evoflow_meta(
    app_id: str,
    app: dict[str, Any],
    *,
    pinned_version: int | None,
) -> dict[str, Any]:
    """Public model contract + paste-ready request/response examples for callers."""
    return {
        "name": app.get("name"),
        "pinned_version": pinned_version if pinned_version is not None else app.get("version"),
        "execution_mode": app.get("execution_mode") or "workflow",
        "parameters": _public_parameters(app),
        "example_request": build_example_chat_request(app_id, app, detail=True),
        "example_response": build_example_chat_response(app_id, app, detail=True),
        "response_contract": build_response_contract(),
        "invoke_path": "/v1/chat/completions",
        "hint": (
            "POST example_request to /v1/chat/completions with Bearer ef-… . "
            "Read choices[0].message.content for the answer; with detail=true read "
            "responseData[].assigned_agent for per-agent outputs (see example_response)."
        ),
    }


def _start_published_app(
    *,
    token_data: dict[str, Any],
    body: ChatCompletionsRequest,
) -> tuple[str, dict[str, Any], int]:
    """Validate + start workflow run (does not wait).

    Returns:
        (app_id, started_run_meta, app_version_used)
    """
    try:
        app_id = resolve_app_id_from_request(
            bound_app_id=str(token_data.get("identity_id") or ""),
            body_app_id=body.appId,
            model=body.model,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    live = app_repositories.load_app(app_id)
    if live is None:
        raise HTTPException(status_code=404, detail=f"Application not found: {app_id}")
    live_status = str(live.get("status") or "").strip().lower()
    if live_status != "published":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=(
                "Application must be published before OpenAPI invocation "
                f"(current status={live_status or 'unknown'})."
            ),
        )

    pin = _pinned_from_token(token_data)
    try:
        app = load_app_for_run(app_id, pinned_version=pin)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e

    mode = str(app.get("execution_mode") or "workflow").strip().lower()
    if mode == "lead_supervised":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                "OpenAPI invocation requires execution_mode=workflow. "
                "This app is lead_supervised — switch to pure workflow in settings, "
                "publish again, then retry. Studio debug still supports Lead mode."
            ),
        )

    messages = [m.model_dump() for m in body.messages]
    parameters = map_chat_to_parameters(
        app, variables=body.variables, messages=messages
    )
    missing = missing_required_parameters(app, parameters)
    if missing:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "message": "Missing required variables.",
                "missing": missing,
                "hint": "Pass them in body.variables (see GET /v1/models).",
            },
        )
    app_version = int(app.get("version") or pin or live.get("version") or 1)

    try:
        started = run_app(
            app_id=app_id,
            parameters=parameters,
            execution_mode="workflow",
            thread_id=None,
            app=app,
            run_kind="production",
            trigger_kind="api",
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    run_id = str(started.get("run_id") or "").strip()
    if not run_id:
        raise HTTPException(status_code=500, detail="run_app did not return run_id")
    started = {**started, "app_version": app_version}
    return app_id, started, app_version


def _run_published_app(
    *,
    token_data: dict[str, Any],
    body: ChatCompletionsRequest,
) -> tuple[str, dict[str, Any], dict[str, Any]]:
    """Validate, start workflow run, wait for terminal status."""
    app_id, started, _ver = _start_published_app(token_data=token_data, body=body)
    run_id = str(started.get("run_id") or "").strip()
    try:
        final = wait_for_run_terminal(
            run_id,
            get_status=get_run_status,
            timeout_sec=openai_completions_timeout_sec(),
            poll_interval_sec=1.0,
        )
    except TimeoutError as e:
        args = e.args
        last = args[1] if len(args) > 1 else None
        raise HTTPException(
            status_code=status.HTTP_504_GATEWAY_TIMEOUT,
            detail={
                "message": "Application run timed out waiting for completion.",
                "run_id": run_id,
                "app_id": app_id,
                "last_status": (last or {}).get("status") if isinstance(last, dict) else None,
            },
        ) from e

    return app_id, started, final


def _finish_reason_for_status(status_doc: dict[str, Any]) -> str:
    return "stop"


def _assert_run_belongs_to_app(run_id: str, app_id: str) -> dict[str, Any]:
    doc = get_run_status(run_id)
    if doc is None:
        raise HTTPException(status_code=404, detail=f"Run not found: {run_id}")
    if str(doc.get("app_id") or "") != str(app_id):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="This run does not belong to the API key's application.",
        )
    return doc


def _async_acceptance_response(
    *,
    app_id: str,
    run_id: str,
    app_version: int,
    status_value: str,
) -> dict[str, Any]:
    return {
        "id": f"chatcmpl-{uuid.uuid4().hex[:24]}",
        "object": "chat.completion.async",
        "created": int(time.time()),
        "model": app_id,
        "status": status_value or "running",
        "evoflow": {
            "run_id": run_id,
            "app_id": app_id,
            "app_version": app_version,
            "status_url": f"/v1/runs/{run_id}",
        },
    }


@router.post("/chat/completions")
async def chat_completions(
    body: ChatCompletionsRequest,
    token_data: dict[str, Any] = Depends(verify_app_bearer_token),
) -> Any:
    """OpenAI-compatible chat completions that runs a published App as a workflow."""
    if body.stream and body.async_:
        raise HTTPException(
            status_code=400,
            detail="stream and async are mutually exclusive; use one or the other.",
        )

    if body.async_:
        app_id, started, app_version = await asyncio.to_thread(
            _start_published_app, token_data=token_data, body=body
        )
        run_id = str(started.get("run_id") or "")
        return JSONResponse(
            content=_async_acceptance_response(
                app_id=app_id,
                run_id=run_id,
                app_version=app_version,
                status_value=str(started.get("status") or "running"),
            )
        )

    if body.stream:
        return _chat_completions_stream(body, token_data)

    app_id, started, final = await asyncio.to_thread(
        _run_published_app, token_data=token_data, body=body
    )
    run_id = str(started.get("run_id") or "")
    content = summarize_run_content(final)
    st = str(final.get("status") or "").strip().lower()
    if st in {"failed", "error"} and not content:
        content = f"Run failed (run_id={run_id})"
    resp = build_chat_completion_response(
        app_id=app_id,
        content=content,
        run_id=run_id,
        finish_reason=_finish_reason_for_status(final),
        app_version=started.get("app_version"),
        status_doc=final,
        detail=bool(body.detail),
    )
    return JSONResponse(content=resp)


@router.get("/runs/{run_id}")
async def get_app_run_openai(
    run_id: str,
    detail: bool = False,
    token_data: dict[str, Any] = Depends(verify_app_bearer_token),
) -> Any:
    """Poll an App run started via OpenAPI (must belong to the key's app)."""
    app_id = str(token_data.get("identity_id") or "")
    doc = await asyncio.to_thread(_assert_run_belongs_to_app, run_id, app_id)
    st = str(doc.get("status") or "").strip().lower()
    if st not in _TERMINAL:
        payload: dict[str, Any] = {
            "id": f"run-{run_id}",
            "object": "evoflow.app_run",
            "model": app_id,
            "status": doc.get("status") or "running",
            "progress": doc.get("progress") or 0,
            "evoflow": {
                "run_id": run_id,
                "app_id": app_id,
                "app_version": doc.get("app_version"),
                "subtask_status": doc.get("subtask_status") or {},
            },
        }
        if detail:
            rows = build_response_data(doc)
            payload["responseData"] = rows
            payload["evoflow"]["flowResponses"] = rows
            payload["evoflow"]["steps"] = rows
        return JSONResponse(content=payload)

    content = summarize_run_content(doc)
    if st in {"failed", "error"} and not content:
        content = f"Run failed (run_id={run_id})"
    resp = build_chat_completion_response(
        app_id=app_id,
        content=content,
        run_id=run_id,
        finish_reason="stop",
        app_version=doc.get("app_version"),
        status_doc=doc,
        detail=bool(detail),
    )
    resp.setdefault("evoflow", {})["status"] = doc.get("status")
    return JSONResponse(content=resp)


@router.post("/runs/{run_id}/cancel")
async def cancel_app_run_openai(
    run_id: str,
    token_data: dict[str, Any] = Depends(verify_app_bearer_token),
) -> dict[str, Any]:
    """Cancel an App run that belongs to the API key's application."""
    app_id = str(token_data.get("identity_id") or "")
    await asyncio.to_thread(_assert_run_belongs_to_app, run_id, app_id)
    ok = await asyncio.to_thread(cancel_run, run_id, "OpenAPI cancel")
    if not ok:
        raise HTTPException(status_code=404, detail=f"Run not found: {run_id}")
    return {"success": True, "run_id": run_id}


@router.get("/models")
async def list_app_models(
    token_data: dict[str, Any] = Depends(verify_app_bearer_token),
) -> dict[str, Any]:
    """OpenAI-style model list: the single app bound to this API key."""
    app_id = str(token_data.get("identity_id") or "")
    pin = _pinned_from_token(token_data)
    try:
        app = load_app_for_run(app_id, pinned_version=pin)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    created = int(time.time())
    return {
        "object": "list",
        "data": [
            {
                "id": app_id,
                "object": "model",
                "created": created,
                "owned_by": "evoflow",
                "evoflow": _app_model_evoflow_meta(app_id, app, pinned_version=pin),
            }
        ],
    }


@router.get("/models/{model_id}")
async def get_app_model(
    model_id: str,
    token_data: dict[str, Any] = Depends(verify_app_bearer_token),
) -> dict[str, Any]:
    """OpenAI-style model detail with App parameter schema + example_request."""
    app_id = str(token_data.get("identity_id") or "")
    mid = str(model_id or "").strip()
    # App_* ids must match the key; other ids (e.g. gpt-4o) alias to the bound app.
    if mid.startswith("App_") and mid != app_id:
        raise HTTPException(
            status_code=404,
            detail=f"Model '{mid}' does not match API key app '{app_id}'.",
        )
    pin = _pinned_from_token(token_data)
    try:
        app = load_app_for_run(app_id, pinned_version=pin)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    meta = _app_model_evoflow_meta(app_id, app, pinned_version=pin)
    return {
        "id": app_id,
        "object": "model",
        "created": int(time.time()),
        "owned_by": "evoflow",
        **meta,
        "evoflow": meta,
    }


def _chat_completions_stream(
    body: ChatCompletionsRequest,
    token_data: dict[str, Any],
) -> StreamingResponse:
    async def event_gen() -> AsyncIterator[str]:
        chunk_id = f"chatcmpl-{uuid.uuid4().hex[:24]}"
        created = int(time.time())
        bound_app = str(token_data.get("identity_id") or "")

        def _sse(payload: dict[str, Any]) -> str:
            return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"

        def _delta(
            content: str | None = None,
            *,
            finish: str | None = None,
            extra: dict | None = None,
        ) -> str:
            choice: dict[str, Any] = {
                "index": 0,
                "delta": {"content": content} if content is not None else {},
                "finish_reason": finish,
            }
            payload: dict[str, Any] = {
                "id": chunk_id,
                "object": "chat.completion.chunk",
                "created": created,
                "model": bound_app,
                "choices": [choice],
            }
            if extra:
                payload["evoflow"] = extra
            return _sse(payload)

        yield _sse(
            {
                "id": chunk_id,
                "object": "chat.completion.chunk",
                "created": created,
                "model": bound_app,
                "choices": [
                    {
                        "index": 0,
                        "delta": {"role": "assistant"},
                        "finish_reason": None,
                    }
                ],
            }
        )

        try:
            app_id, started, app_version = await asyncio.to_thread(
                _start_published_app, token_data=token_data, body=body
            )
            run_id = str(started.get("run_id") or "")
            bound_app = app_id
            # Metadata only — no Chinese startup fluff in assistant content
            yield _delta(
                None,
                extra={
                    "run_id": run_id,
                    "app_id": app_id,
                    "app_version": app_version,
                    "phase": "started",
                },
            )

            emitted_keys: set[str] = set()
            streamed_parts: list[str] = []
            deadline = time.monotonic() + openai_completions_timeout_sec()
            final: dict[str, Any] | None = None
            poll_interval = 1.0
            keep_alive_every = 15.0
            last_keep_alive = time.monotonic()
            last_fp = ""

            while True:
                doc = await asyncio.to_thread(get_run_status, run_id)
                if isinstance(doc, dict):
                    final = doc
                    events = collect_new_step_stream_events(doc, emitted_keys)
                    for i, ev in enumerate(events):
                        piece = str(ev.get("text") or "")
                        if not piece:
                            continue
                        prefix = "\n\n" if streamed_parts or i > 0 else ""
                        text = f"{prefix}{piece}"
                        streamed_parts.append(piece)
                        step_extra: dict[str, Any] = {
                            "run_id": run_id,
                            "app_id": app_id,
                            "phase": "step",
                            "progress": doc.get("progress"),
                        }
                        pub = ev.get("response") if isinstance(ev.get("response"), dict) else {}
                        if pub:
                            step_extra["ref"] = pub.get("ref")
                            step_extra["assigned_agent"] = pub.get("assigned_agent") or ""
                            step_extra["agent"] = pub.get("agent") or ""
                            step_extra["moduleName"] = pub.get("moduleName")
                            step_extra["moduleType"] = pub.get("moduleType")
                            step_extra["status"] = pub.get("status")
                            if body.detail:
                                step_extra["step"] = pub
                        yield _delta(text, extra=step_extra)

                    fp = progress_fingerprint(doc)
                    if body.detail and fp and fp != last_fp:
                        last_fp = fp
                        progress_payload = {
                            "run_id": run_id,
                            "app_id": app_id,
                            "status": doc.get("status"),
                            "progress": doc.get("progress"),
                            "subtask_status": doc.get("subtask_status") or {},
                            "steps": build_response_data(doc),
                        }
                        yield (
                            "event: evoflow.progress\n"
                            f"data: {json.dumps(progress_payload, ensure_ascii=False)}\n\n"
                        )

                    st = str(doc.get("status") or "").strip().lower()
                    if st in _TERMINAL:
                        break

                if time.monotonic() >= deadline:
                    raise HTTPException(
                        status_code=status.HTTP_504_GATEWAY_TIMEOUT,
                        detail={
                            "message": "Application run timed out waiting for completion.",
                            "run_id": run_id,
                            "app_id": app_id,
                            "last_status": (final or {}).get("status") if final else None,
                        },
                    )

                now = time.monotonic()
                if now - last_keep_alive >= keep_alive_every:
                    yield ": ping\n\n"
                    last_keep_alive = now
                await asyncio.sleep(poll_interval)

            final = final or {}
            answer = summarize_run_content(final)
            st = str(final.get("status") or "").strip().lower()
            if st in {"failed", "error"} and not answer:
                answer = f"Run failed (run_id={run_id})"
            if should_append_final_answer_delta(
                answer, streamed_parts=streamed_parts, status_doc=final
            ):
                prefix = "\n\n---\n" if streamed_parts else ""
                yield _delta(
                    f"{prefix}{answer}",
                    extra={"run_id": run_id, "app_id": app_id, "phase": "final"},
                )

            if body.detail and final:
                rows = build_response_data(final)
                yield (
                    "event: evoflow.flowResponses\n"
                    f"data: {json.dumps({'responseData': rows, 'steps': rows, 'status': final.get('status'), 'answer': answer}, ensure_ascii=False)}\n\n"
                )

            yield _delta(finish="stop", extra={"run_id": run_id, "app_id": app_id})
            yield "data: [DONE]\n\n"
        except HTTPException as e:
            detail = e.detail
            if not isinstance(detail, (str, dict)):
                detail = str(detail)
            err = {
                "error": {
                    "message": detail
                    if isinstance(detail, str)
                    else json.dumps(detail, ensure_ascii=False),
                    "type": "api_error",
                    "code": e.status_code,
                }
            }
            yield _sse(err)
            yield "data: [DONE]\n\n"
        except Exception as e:
            logger.exception("chat/completions stream failed")
            yield _sse(
                {
                    "error": {
                        "message": str(e),
                        "type": "api_error",
                        "code": 500,
                    }
                }
            )
            yield "data: [DONE]\n\n"

    return StreamingResponse(
        event_gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
