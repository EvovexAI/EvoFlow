"""LangGraph run config helpers (Agent Server 0.6+ context-only runs)."""

from __future__ import annotations

import logging
import os
from typing import Any

logger = logging.getLogger(__name__)

DEFAULT_LANGGRAPH_BASE_URL = "http://127.0.0.1:8070/api/langgraph"


def resolve_langgraph_base_url() -> str:
    return (os.getenv("EVOFLOW_LANGGRAPH_URL", DEFAULT_LANGGRAPH_BASE_URL) or DEFAULT_LANGGRAPH_BASE_URL).rstrip("/")


def is_thread_or_assistant_not_found_error(exc: BaseException | None) -> bool:
    """True when LangGraph SDK/HTTP indicates missing thread or assistant graph."""
    if exc is None:
        return False
    response = getattr(exc, "response", None)
    if response is not None and getattr(response, "status_code", None) == 404:
        parts = [str(exc)]
        body = getattr(response, "text", None)
        if body:
            parts.append(str(body))
        msg = "\n".join(parts).lower()
        if ("thread" in msg and "not found" in msg) or ("assistant" in msg and "not found" in msg):
            return True
    msg = str(exc).lower()
    return ("thread" in msg and "not found" in msg) or ("assistant" in msg and "not found" in msg)


def default_langgraph_thread_metadata(*, source: str, session_key: str = "") -> dict[str, Any]:
    """Metadata aligned with ``create_langgraph_thread`` (long-run wall clock)."""
    from evoflow.runtime.long_run_limits import LONG_RUN_WALL_MS, LONG_RUN_WALL_SECONDS

    meta: dict[str, Any] = {
        "max_execution_time": LONG_RUN_WALL_SECONDS,
        "timeout_ms": LONG_RUN_WALL_MS,
        "execution_mode": "normal",
        "source": source,
    }
    sk = str(session_key or "").strip()
    if sk:
        meta["session_key"] = sk
    return meta


def json_safe_run_dict(obj: dict[str, Any] | None) -> dict[str, Any]:
    """Drop callables / types so LangGraph SDK can JSON-encode run config + context."""
    if not isinstance(obj, dict):
        return {}
    out: dict[str, Any] = {}
    for k, v in obj.items():
        if callable(v) or isinstance(v, type):
            continue
        key = str(k)
        if v is None or isinstance(v, (str, int, float, bool)):
            out[key] = v
        elif isinstance(v, dict):
            nested = json_safe_run_dict(v)
            if nested:
                out[key] = nested
        elif isinstance(v, (list, tuple)):
            items: list[Any] = []
            for item in v:
                if callable(item) or isinstance(item, type):
                    continue
                if item is None or isinstance(item, (str, int, float, bool)):
                    items.append(item)
                elif isinstance(item, dict):
                    nested = json_safe_run_dict(item)
                    if nested:
                        items.append(nested)
                else:
                    items.append(str(item))
            out[key] = items
        else:
            out[key] = str(v)
    return out


def merge_configurable_into_context(
    run_config: dict[str, Any],
    run_context: dict[str, Any],
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Merge ``config.configurable`` into ``context``; drop configurable from config.

    LangGraph Agent Server rejects runs that set both ``config.configurable`` and
    ``context``. Existing ``run_context`` keys win on conflict.

    Also fills human identity (``principal_id`` / ``owner_scope_id``) from session
    or resource owner when missing.
    """
    rc = dict(run_config)
    user_conf = rc.pop("configurable", None)
    ctx = dict(run_context)
    if isinstance(user_conf, dict) and user_conf:
        merged = {**user_conf, **ctx}
    else:
        merged = ctx
    try:
        from evoflow.authz.runtime_identity import enrich_run_context_identity

        merged = enrich_run_context_identity(merged)
    except Exception:
        pass
    return rc, merged


async def ensure_langgraph_thread_exists(
    client: Any,
    thread_id: str,
    *,
    metadata: dict[str, Any] | None = None,
) -> str:
    """Ensure a LangGraph thread row exists before ``runs.stream`` / ``runs.wait``."""
    tid = str(thread_id or "").strip()
    if not tid:
        raise ValueError("thread_id required")
    try:
        await client.threads.get(tid)
        return tid
    except Exception as exc:
        if not is_thread_or_assistant_not_found_error(exc):
            logger.debug("langgraph thread get failed tid=%s (will try create)", tid, exc_info=True)
        else:
            logger.debug("langgraph thread missing tid=%s, creating", tid)
    create_kwargs: dict[str, Any] = {"thread_id": tid, "if_exists": "do_nothing"}
    if metadata:
        create_kwargs["metadata"] = dict(metadata)
    try:
        await client.threads.create(**create_kwargs)
    except Exception:
        try:
            await client.threads.get(tid)
            return tid
        except Exception as exc:
            logger.warning("langgraph thread create/get failed tid=%s: %s", tid, exc)
            raise
    return tid


# Interactive UI chat must not ``enqueue`` behind a zombie run on the same thread
# (UI shows bootstrap「准备中…」while ``lg_queue_claim`` never fires). Background
# jobs (unattended / approval resume) keep their explicit ``enqueue``.
_INTERACTIVE_MULTITASK = "interrupt"
_KEEP_STRATEGIES = frozenset({"interrupt", "reject", "rollback"})


def apply_interactive_chat_multitask_strategy(
    body: dict[str, Any] | None,
    *,
    ui_stream: bool = False,
) -> tuple[dict[str, Any] | None, dict[str, Any]]:
    """Force ``multitask_strategy=interrupt`` for interactive UI / employee chat.

    Returns ``(body, meta)`` where ``meta`` is safe to log
    (``changed``, ``before``, ``after``, ``reason``).
    """
    meta: dict[str, Any] = {
        "changed": False,
        "before": None,
        "after": None,
        "reason": "skip",
        "ui_stream": bool(ui_stream),
    }
    if not isinstance(body, dict):
        return body, meta

    ctx = body.get("context") if isinstance(body.get("context"), dict) else {}
    talk = str(ctx.get("employee_talk_mode") or "").strip()
    before_raw = body.get("multitask_strategy")
    before = str(before_raw).strip().lower() if before_raw is not None else ""
    meta["before"] = before or None
    meta["employee_talk_mode"] = talk or None
    meta["source"] = str(ctx.get("source") or "").strip() or None

    interactive = bool(ui_stream) or bool(talk)
    if not interactive:
        meta["reason"] = "non_interactive"
        meta["after"] = before or None
        return body, meta

    if before in _KEEP_STRATEGIES:
        meta["reason"] = "already_set"
        meta["after"] = before
        return body, meta

    out = dict(body)
    out["multitask_strategy"] = _INTERACTIVE_MULTITASK
    meta["changed"] = True
    meta["after"] = _INTERACTIVE_MULTITASK
    meta["reason"] = "ui_stream" if ui_stream else "employee_talk"
    return out, meta
