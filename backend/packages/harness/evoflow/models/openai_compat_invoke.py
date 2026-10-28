"""OpenAI-compatible single-shot invoke over configured EvoFlow models.

Shared by ``POST /openai/v1/chat/completions``, ``POST /api/models/invoke``,
and ``evoflow openai …`` CLI.
"""

from __future__ import annotations

import base64
import logging
import mimetypes
import uuid
from pathlib import Path
from typing import Any

from evoflow.config import get_app_config
from evoflow.timeutil import utc_now_iso_z

logger = logging.getLogger(__name__)

INVOCATION_KIND = "openai_compat"


class OpenAICompatError(Exception):
    """Raised for client/config errors; ``status_code`` maps to HTTP."""

    def __init__(self, message: str, *, status_code: int = 400) -> None:
        super().__init__(message)
        self.status_code = int(status_code)
        self.message = str(message)


def content_has_image(content: Any) -> bool:
    """True when OpenAI-style content includes an image part."""
    if isinstance(content, list):
        for part in content:
            if not isinstance(part, dict):
                continue
            t = str(part.get("type") or "").strip().lower()
            if t in ("image_url", "image", "input_image"):
                return True
            if part.get("image_url") is not None:
                return True
    return False


def messages_have_image(messages: list[Any]) -> bool:
    for m in messages or []:
        if isinstance(m, dict) and content_has_image(m.get("content")):
            return True
        content = getattr(m, "content", None)
        if content_has_image(content):
            return True
    return False


def _read_local_as_data_url(path: str) -> str:
    p = Path(path).expanduser()
    if not p.is_file():
        raise OpenAICompatError(f"image file not found: {path}", status_code=400)
    mime, _ = mimetypes.guess_type(str(p))
    if not mime or not mime.startswith("image/"):
        mime = "image/png"
    raw = p.read_bytes()
    b64 = base64.standard_b64encode(raw).decode("ascii")
    return f"data:{mime};base64,{b64}"


def normalize_image_url(url: str) -> str:
    """Resolve local paths to data URLs; pass through http(s)/data:."""
    s = str(url or "").strip()
    if not s:
        raise OpenAICompatError("empty image_url", status_code=400)
    low = s.lower()
    if low.startswith("http://") or low.startswith("https://") or low.startswith("data:"):
        return s
    # file:// or bare path
    if low.startswith("file://"):
        from urllib.parse import unquote, urlparse

        parsed = urlparse(s)
        local = unquote(parsed.path)
        # Windows file:///C:/...
        if local.startswith("/") and len(local) > 2 and local[2] == ":":
            local = local[1:]
        return _read_local_as_data_url(local)
    return _read_local_as_data_url(s)


def normalize_content_for_langchain(content: Any, *, allow_images: bool) -> Any:
    """Convert OpenAI message content to LangChain-friendly content."""
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return str(content)

    out: list[dict[str, Any]] = []
    for part in content:
        if isinstance(part, str):
            out.append({"type": "text", "text": part})
            continue
        if not isinstance(part, dict):
            continue
        t = str(part.get("type") or "").strip().lower()
        if t in ("text", "input_text") or ("text" in part and t != "image_url"):
            text = part.get("text")
            if text is None and isinstance(part.get("content"), str):
                text = part.get("content")
            out.append({"type": "text", "text": str(text or "")})
            continue
        if t in ("image_url", "image", "input_image") or part.get("image_url") is not None:
            if not allow_images:
                raise OpenAICompatError(
                    "model does not support vision; remove image_url parts or pick a supports_vision model",
                    status_code=400,
                )
            raw_url = part.get("image_url")
            if isinstance(raw_url, dict):
                url = str(raw_url.get("url") or "").strip()
            else:
                url = str(raw_url or part.get("url") or "").strip()
            url = normalize_image_url(url)
            out.append({"type": "image_url", "image_url": {"url": url}})
            continue
    if not out:
        return ""
    # Pure text list → join as string for simpler providers
    if all(p.get("type") == "text" for p in out):
        return "\n".join(str(p.get("text") or "") for p in out)
    return out


def extract_assistant_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for block in content:
            if isinstance(block, str):
                parts.append(block)
            elif isinstance(block, dict) and block.get("type") in {"text", "output_text"}:
                text = block.get("text")
                if isinstance(text, str):
                    parts.append(text)
        return "\n".join(parts) if parts else ""
    if content is None:
        return ""
    return str(content)


def build_langchain_messages(
    messages: list[dict[str, Any]],
    *,
    supports_vision: bool,
) -> list[Any]:
    from langchain_core.messages import AIMessage, HumanMessage, SystemMessage

    want_images = messages_have_image(messages)
    if want_images and not supports_vision:
        raise OpenAICompatError(
            "model does not support vision; choose a model with supports_vision=true",
            status_code=400,
        )
    allow = bool(supports_vision)
    out: list[Any] = []
    for m in messages:
        if not isinstance(m, dict):
            continue
        role = str(m.get("role") or "user").strip().lower()
        content = normalize_content_for_langchain(m.get("content"), allow_images=allow)
        if role == "system":
            # SystemMessage: coerce multimodal to text
            if isinstance(content, list):
                content = extract_assistant_text(content) or str(content)
            out.append(SystemMessage(content=content))
        elif role in ("assistant", "ai"):
            if isinstance(content, list):
                content = extract_assistant_text(content) or str(content)
            out.append(AIMessage(content=content))
        else:
            out.append(HumanMessage(content=content))
    if not out:
        raise OpenAICompatError("messages must contain at least one message", status_code=400)
    return out


def resolve_model_name(model: str | None) -> tuple[str | None, Any]:
    """Return (config_name_or_None, model_config). None name → primary/first."""
    config = get_app_config()
    if not config.models:
        raise OpenAICompatError(
            "no models configured; add one in Settings → Models",
            status_code=503,
        )
    name = str(model or "").strip() or None
    if name:
        cfg = config.get_model_config(name)
        if cfg is None:
            # Also accept provider model id match
            for m in config.models:
                if str(getattr(m, "model", "") or "").strip() == name:
                    return str(m.name), m
            raise OpenAICompatError(f"model not found: {name}", status_code=404)
        return name, cfg
    primary = getattr(config, "get_primary_model", None)
    if callable(primary):
        try:
            p = primary()
            if p is not None:
                return str(getattr(p, "name", "") or None) or None, p
        except Exception:
            pass
    first = config.models[0]
    return str(getattr(first, "name", "") or None) or None, first


def _usage_from_response(resp: Any) -> dict[str, int]:
    try:
        from evoflow.agents.middlewares.message_usage_helpers import infer_usage_metadata_for_ai_message

        inferred = infer_usage_metadata_for_ai_message(resp)
        if inferred:
            return {
                "prompt_tokens": int(inferred.get("input_tokens") or 0),
                "completion_tokens": int(inferred.get("output_tokens") or 0),
                "total_tokens": int(inferred.get("total_tokens") or 0)
                or (
                    int(inferred.get("input_tokens") or 0) + int(inferred.get("output_tokens") or 0)
                ),
            }
    except Exception:
        logger.debug("usage infer skipped", exc_info=True)
    um = getattr(resp, "usage_metadata", None)
    if isinstance(um, dict):
        inp = int(um.get("input_tokens") or um.get("prompt_tokens") or 0)
        out = int(um.get("output_tokens") or um.get("completion_tokens") or 0)
        tot = int(um.get("total_tokens") or 0) or (inp + out)
        return {"prompt_tokens": inp, "completion_tokens": out, "total_tokens": tot}
    return {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}


def _record_usage(
    *,
    model_name: str | None,
    provider: str | None,
    usage: dict[str, int],
    message_id: str,
) -> None:
    inp = int(usage.get("prompt_tokens") or 0)
    out = int(usage.get("completion_tokens") or 0)
    tot = int(usage.get("total_tokens") or 0) or (inp + out)
    if tot <= 0:
        # Still count as 1 request equivalent? Ledger requires tokens > 0 for llm.
        # Skip silent zero; optional: could use quantity=1 media-style — plan says llm path.
        return
    try:
        from evoflow.persistence.db import run_db_transaction
        from evoflow.persistence.usage_ledger import record_llm_chat_usage_in_txn

        sk = f"openai_compat:{message_id}"

        def _write(db: Any) -> bool:
            return record_llm_chat_usage_in_txn(
                db,
                session_key=sk,
                message_id=message_id,
                model_name=model_name,
                provider=provider or "",
                input_tokens=inp,
                output_tokens=out,
                total_tokens=tot,
                meta={"invocation_kind": INVOCATION_KIND},
            )

        run_db_transaction(_write)
    except Exception:
        logger.debug("openai_compat usage record failed", exc_info=True)


def build_chat_completion_response(
    *,
    text: str,
    model: str,
    usage: dict[str, int],
    completion_id: str | None = None,
) -> dict[str, Any]:
    cid = completion_id or f"chatcmpl-{uuid.uuid4().hex[:24]}"
    return {
        "id": cid,
        "object": "chat.completion",
        "created": int(__import__("time").time()),
        "model": model,
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": text},
                "finish_reason": "stop",
            }
        ],
        "usage": {
            "prompt_tokens": int(usage.get("prompt_tokens") or 0),
            "completion_tokens": int(usage.get("completion_tokens") or 0),
            "total_tokens": int(usage.get("total_tokens") or 0),
        },
    }


def list_configured_models_openai() -> dict[str, Any]:
    config = get_app_config()
    now = int(__import__("time").time())
    data: list[dict[str, Any]] = []
    for m in config.models or []:
        mid = str(getattr(m, "name", "") or "").strip()
        if not mid:
            continue
        data.append(
            {
                "id": mid,
                "object": "model",
                "created": now,
                "owned_by": str(getattr(m, "vendor", None) or "evoflow"),
                "evoflow": {
                    "provider_model": getattr(m, "model", None),
                    "display_name": getattr(m, "display_name", None),
                    "supports_vision": bool(getattr(m, "supports_vision", False)),
                    "supports_thinking": bool(getattr(m, "supports_thinking", False)),
                },
            }
        )
    return {"object": "list", "data": data}


async def ainvoke_chat_completion(
    *,
    model: str | None = None,
    messages: list[dict[str, Any]],
    temperature: float | None = None,
    thinking_enabled: bool | None = None,
    record_usage: bool = True,
) -> dict[str, Any]:
    """Run one non-streaming chat completion; return OpenAI-shaped dict."""
    from evoflow.models import create_chat_model

    name, model_cfg = resolve_model_name(model)
    supports_vision = bool(getattr(model_cfg, "supports_vision", False))
    lc_messages = build_langchain_messages(messages, supports_vision=supports_vision)

    thinking: bool | None = None
    if thinking_enabled is not None:
        thinking = bool(thinking_enabled)
        if thinking and not getattr(model_cfg, "supports_thinking", False):
            thinking = False

    try:
        chat = create_chat_model(name=name, thinking_enabled=thinking, invocation_kind=INVOCATION_KIND)
    except ValueError as e:
        raise OpenAICompatError(str(e), status_code=400) from e

    if temperature is not None:
        try:
            chat = chat.bind(temperature=float(temperature))
        except Exception:
            logger.debug("bind temperature skipped", exc_info=True)
    if getattr(chat, "streaming", False):
        try:
            chat = chat.bind(streaming=False)
        except Exception:
            logger.debug("bind streaming=False skipped", exc_info=True)

    try:
        resp = await chat.ainvoke(lc_messages)
    except Exception as e:
        logger.exception("openai_compat ainvoke failed")
        raise OpenAICompatError(str(e), status_code=502) from e

    text = extract_assistant_text(getattr(resp, "content", resp))
    usage = _usage_from_response(resp)
    resolved = str(name or getattr(model_cfg, "name", "") or "unknown")
    cid = f"chatcmpl-{uuid.uuid4().hex[:24]}"
    if record_usage:
        _record_usage(
            model_name=resolved,
            provider=str(getattr(model_cfg, "vendor", "") or ""),
            usage=usage,
            message_id=cid,
        )
    # Clear unavailable flag on success (same as /api/models/invoke)
    try:
        from evoflow.config import reload_models_from_db
        from evoflow.persistence import config_repositories as cfg_repo

        if cfg_repo.clear_model_unavailable(resolved):
            reload_models_from_db()
    except Exception:
        logger.debug("clear unavailable skipped", exc_info=True)

    return build_chat_completion_response(text=text, model=resolved, usage=usage, completion_id=cid)


def invoke_chat_completion(
    *,
    model: str | None = None,
    messages: list[dict[str, Any]],
    temperature: float | None = None,
    thinking_enabled: bool | None = None,
    record_usage: bool = True,
) -> dict[str, Any]:
    """Sync wrapper for CLI / admin."""
    import asyncio

    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = None
    if loop and loop.is_running():
        # Nested event loop — use sync model.invoke path
        return _invoke_chat_completion_sync(
            model=model,
            messages=messages,
            temperature=temperature,
            thinking_enabled=thinking_enabled,
            record_usage=record_usage,
        )
    return asyncio.run(
        ainvoke_chat_completion(
            model=model,
            messages=messages,
            temperature=temperature,
            thinking_enabled=thinking_enabled,
            record_usage=record_usage,
        )
    )


def _invoke_chat_completion_sync(
    *,
    model: str | None = None,
    messages: list[dict[str, Any]],
    temperature: float | None = None,
    thinking_enabled: bool | None = None,
    record_usage: bool = True,
) -> dict[str, Any]:
    from evoflow.models import create_chat_model

    name, model_cfg = resolve_model_name(model)
    supports_vision = bool(getattr(model_cfg, "supports_vision", False))
    lc_messages = build_langchain_messages(messages, supports_vision=supports_vision)
    thinking: bool | None = None
    if thinking_enabled is not None:
        thinking = bool(thinking_enabled)
        if thinking and not getattr(model_cfg, "supports_thinking", False):
            thinking = False
    try:
        chat = create_chat_model(name=name, thinking_enabled=thinking, invocation_kind=INVOCATION_KIND)
    except ValueError as e:
        raise OpenAICompatError(str(e), status_code=400) from e
    if temperature is not None:
        try:
            chat = chat.bind(temperature=float(temperature))
        except Exception:
            pass
    if getattr(chat, "streaming", False):
        try:
            chat = chat.bind(streaming=False)
        except Exception:
            pass
    try:
        resp = chat.invoke(lc_messages)
    except Exception as e:
        raise OpenAICompatError(str(e), status_code=502) from e
    text = extract_assistant_text(getattr(resp, "content", resp))
    usage = _usage_from_response(resp)
    resolved = str(name or getattr(model_cfg, "name", "") or "unknown")
    cid = f"chatcmpl-{uuid.uuid4().hex[:24]}"
    if record_usage:
        _record_usage(
            model_name=resolved,
            provider=str(getattr(model_cfg, "vendor", "") or ""),
            usage=usage,
            message_id=cid,
        )
    return build_chat_completion_response(text=text, model=resolved, usage=usage, completion_id=cid)


def vision_messages(*, prompt: str, image: str, system: str | None = None) -> list[dict[str, Any]]:
    """Build OpenAI messages for a single-image vision ask."""
    url = normalize_image_url(image)
    msgs: list[dict[str, Any]] = []
    if system:
        msgs.append({"role": "system", "content": system})
    msgs.append(
        {
            "role": "user",
            "content": [
                {"type": "text", "text": prompt},
                {"type": "image_url", "image_url": {"url": url}},
            ],
        }
    )
    return msgs
