"""Model configuration admin (SQLite-backed, no tools coupling)."""

from __future__ import annotations

from typing import Any
from urllib.parse import urlparse

import httpx

from evoflow.admin.errors import NotFoundError, ValidationError
from evoflow.config import add_model_to_config, get_app_config, reload_models_from_db, remove_model_from_config, update_model_in_config
from evoflow.persistence import config_repositories as cfg_repo
from evoflow.utils.model_context_length import context_length_from_model_config


def _mask_api_key(api_key: str | None) -> str | None:
    return api_key if api_key else None


def _model_row(model: Any) -> dict[str, Any]:
    return {
        "name": model.name,
        "vendor": getattr(model, "vendor", None),
        "model": model.model,
        "display_name": model.display_name,
        "description": model.description,
        "use": model.use,
        "base_url": getattr(model, "base_url", None),
        "api_key": _mask_api_key(getattr(model, "api_key", None)),
        "supports_thinking": model.supports_thinking,
        "supports_reasoning_effort": model.supports_reasoning_effort,
        "supports_vision": getattr(model, "supports_vision", False),
        "max_tokens": getattr(model, "max_tokens", None),
        "context_length": context_length_from_model_config(model),
        "when_thinking_enabled": getattr(model, "when_thinking_enabled", None),
        "thinking": getattr(model, "thinking", None),
    }


def list_models() -> dict[str, Any]:
    config = get_app_config()
    return {"models": [_model_row(m) for m in config.models]}


def get_model(name: str) -> dict[str, Any]:
    config = get_app_config()
    model = config.get_model_config(name)
    if model is None:
        raise NotFoundError(f"Model '{name}' not found")
    return _model_row(model)


def get_primary_model() -> dict[str, Any]:
    config = get_app_config()
    primary: str | None = None
    raw = (config.primary_model or "").strip() if config.primary_model else ""
    if raw and config.get_model_config(raw) is not None:
        primary = raw
    elif config.models:
        primary = config.models[0].name
    return {"primary_model": primary}


def set_primary_model(model_name: str) -> dict[str, Any]:
    config = get_app_config()
    name = model_name.strip()
    if config.get_model_config(name) is None:
        raise NotFoundError(f"Model '{name}' not found")
    config.primary_model = name
    cfg_repo.set_app_setting("primary_model", name)
    return {
        "success": True,
        "message": f"'{name}' set as primary model",
        "primary_model": name,
    }


def create_model(data: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(data, dict):
        raise ValidationError("Model payload must be a JSON object")
    try:
        model_config = add_model_to_config({k: v for k, v in data.items() if v is not None})
        reload_models_from_db()
        return _model_row(model_config)
    except ValueError as e:
        raise ValidationError(str(e)) from e


def update_model(model_name: str, data: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(data, dict):
        raise ValidationError("Model payload must be a JSON object")
    try:
        payload = {k: v for k, v in data.items() if v is not None}
        model_config = update_model_in_config(model_name, payload)
        reload_models_from_db()
        return _model_row(model_config)
    except ValueError as e:
        raise NotFoundError(str(e)) from e


def delete_model(model_name: str) -> dict[str, Any]:
    try:
        remove_model_from_config(model_name)
        reload_models_from_db()
        return {"message": f"Model '{model_name}' deleted successfully"}
    except ValueError as e:
        raise NotFoundError(str(e)) from e


_OPENAI_COMPAT_VERSION_SUFFIX = __import__("re").compile(r"/v\d+/?$")


def _openai_compat_chat_base_url(base_url: str) -> str:
    base = (base_url or "").strip().rstrip("/")
    if not base:
        return base
    if _OPENAI_COMPAT_VERSION_SUFFIX.search(base):
        return base
    if "/v1" in base:
        return base
    return f"{base}/v1"


def test_model_connection(data: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(data, dict):
        raise ValidationError("Test payload must be a JSON object")

    api_type = data.get("api_type") or "openai-completions"
    raw_base = str(data.get("base_url") or "").strip()
    # Anthropic SDK base is host root (no /v1); OpenAI-compat may need /v1 appended.
    if api_type == "anthropic-messages":
        base_url = raw_base.rstrip("/")
    else:
        base_url = _openai_compat_chat_base_url(raw_base)
    api_key = str(data.get("api_key") or "")
    model_id = str(data.get("model_id") or data.get("model") or "")
    if not base_url or not model_id:
        raise ValidationError("base_url and model_id are required")

    try:
        with httpx.Client(timeout=30.0) as client:
            if api_type == "anthropic-messages":
                from evoflow.models.anthropic_url import anthropic_messages_http_url

                url = anthropic_messages_http_url(base_url)
                body = {"model": model_id, "messages": [{"role": "user", "content": "Hi"}], "max_tokens": 16}
                headers = {"anthropic-version": "2023-06-01", "content-type": "application/json"}
                if api_key:
                    headers["x-api-key"] = api_key
                resp = client.post(url, json=body, headers=headers)
            elif api_type == "google-generative-ai":
                url = f"{base_url.rstrip('/')}/models/{model_id}:generateContent?key={api_key}"
                body = {"contents": [{"role": "user", "parts": [{"text": "Hi"}]}]}
                resp = client.post(url, json=body)
            else:
                url = f"{base_url.rstrip('/')}/chat/completions"
                body = {"model": model_id, "messages": [{"role": "user", "content": "Hi"}], "max_tokens": 16}
                headers = {"content-type": "application/json"}
                if api_key:
                    headers["authorization"] = f"Bearer {api_key}"
                resp = client.post(url, json=body, headers=headers)
        if resp.status_code == 200:
            return {"success": True, "message": "Connection OK"}
        snippet = (resp.text or "")[:200] or f"HTTP {resp.status_code}"
        return {"success": False, "message": f"Connection failed: {snippet}"}
    except httpx.TimeoutException:
        return {"success": False, "message": "Connection timed out"}
    except Exception as e:
        return {"success": False, "message": f"Connection failed: {e}"}


def invoke_model(data: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(data, dict):
        raise ValidationError("Invoke payload must be a JSON object")
    from langchain_core.messages import AIMessage, HumanMessage, SystemMessage

    from evoflow.models import create_chat_model

    config = get_app_config()
    if not config.models:
        raise ValidationError("No models configured")

    name = str(data.get("model_name") or "").strip() or None
    if name is not None and config.get_model_config(name) is None:
        raise NotFoundError(f"Model '{name}' not found")

    messages_in = data.get("messages")
    if not isinstance(messages_in, list) or not messages_in:
        single = str(data.get("message") or data.get("prompt") or "").strip()
        if not single:
            raise ValidationError("messages or message is required")
        messages_in = [{"role": "user", "content": single}]

    model = create_chat_model(name=name, thinking_enabled=False)
    temperature = data.get("temperature")
    if temperature is not None:
        try:
            model = model.bind(temperature=float(temperature))
        except Exception:
            pass

    lc_messages = []
    for m in messages_in:
        if not isinstance(m, dict):
            continue
        role = str(m.get("role") or "user").strip().lower()
        content = str(m.get("content") or "")
        if role == "system":
            lc_messages.append(SystemMessage(content=content))
        elif role in ("assistant", "ai"):
            lc_messages.append(AIMessage(content=content))
        else:
            lc_messages.append(HumanMessage(content=content))

    try:
        resp = model.invoke(lc_messages)
    except Exception as e:
        raise ValidationError(f"Model invoke failed: {e}") from e

    content = getattr(resp, "content", resp)
    if isinstance(content, list):
        parts = []
        for block in content:
            if isinstance(block, str):
                parts.append(block)
            elif isinstance(block, dict) and block.get("type") in {"text", "output_text"}:
                text = block.get("text")
                if isinstance(text, str):
                    parts.append(text)
        text = "\n".join(parts)
    elif content is None:
        text = ""
    else:
        text = str(content)
    return {"content": text}


_DASHSCOPE_CODING_FALLBACK_MODEL_IDS = (
    "qwen3-coder-plus",
    "qwen3-coder-flash",
    "qwen-coder-plus",
    "qwen-coder-turbo",
    "qwen3-max",
    "qwen-max",
    "qwen-plus",
    "qwen-turbo",
)


def list_remote_models(data: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(data, dict):
        raise ValidationError("Payload must be a JSON object")

    api_type = str(data.get("api_type") or "openai-completions").strip().lower()
    if api_type not in {"openai-completions", "openai-responses"}:
        return {
            "success": False,
            "message": f"Unsupported api_type '{api_type}' for remote list",
            "models": [],
        }
    base = str(data.get("base_url") or "").strip().rstrip("/")
    if not base:
        raise ValidationError("base_url is required")
    key = str(data.get("api_key") or "").strip()
    headers: dict[str, str] = {"accept": "application/json"}
    if key:
        headers["authorization"] = f"Bearer {key}"
    url = f"{base}/models"
    try:
        with httpx.Client(timeout=45.0) as client:
            resp = client.get(url, headers=headers)
    except httpx.TimeoutException:
        return {"success": False, "message": "Request timed out", "models": []}
    except Exception as e:
        return {"success": False, "message": f"Request failed: {e}", "models": []}

    if resp.status_code != 200:
        snippet = (resp.text or "")[:400].replace("\n", " ")
        if resp.status_code == 404:
            host = (urlparse(url).hostname or "").lower()
            if "coding.dashscope.aliyuncs.com" in host:
                fb = [{"id": mid} for mid in _DASHSCOPE_CODING_FALLBACK_MODEL_IDS]
                return {
                    "success": True,
                    "message": f"DashScope coding endpoint has no /models; returning {len(fb)} common IDs",
                    "models": fb,
                    "degraded": True,
                }
            from evoflow.plans.volc_agent_plan_models import openai_compat_fallback_models

            plan_fb = openai_compat_fallback_models(base)
            if plan_fb:
                return {
                    "success": True,
                    "message": (
                        f"Agent Plan endpoint has no GET /models; "
                        f"returning {len(plan_fb)} official catalog IDs"
                    ),
                    "models": plan_fb,
                    "degraded": True,
                }
        return {"success": False, "message": f"HTTP {resp.status_code}: {snippet}", "models": []}

    try:
        payload = resp.json()
    except Exception:
        return {"success": False, "message": "Response is not valid JSON", "models": []}

    rows = payload.get("data")
    if rows is None:
        rows = payload.get("models")
    if not isinstance(rows, list):
        return {"success": False, "message": "No data/models array in response", "models": []}

    out: list[dict] = []
    for item in rows:
        if isinstance(item, str):
            mid = item.strip()
        elif isinstance(item, dict):
            raw_id = item.get("id") or item.get("name") or item.get("model")
            mid = str(raw_id).strip() if raw_id is not None else ""
        else:
            continue
        if mid:
            out.append({"id": mid})
    return {"success": True, "message": f"Found {len(out)} models", "models": out}
