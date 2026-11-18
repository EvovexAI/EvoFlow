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
    """Mask a stored API key for read-back surfaces (platform / CLI / HTTP).

    【self-evolution-bot · 2026-11-19 · 第60轮 · 模型:deepseek-v4.1-flash-1017】
    改了什么：原来这个函数是 ``return api_key if api_key else None`` —— **名字叫 mask，
    实际原样返回**。于是 ``settings.list_models`` / ``settings.get_model`` 把明文密钥
    直接吐进模型上下文（现网实测：``sk-sp-H.HHRLYH.Jxpb.MEUCIDwleak…`` 68 字符全裸、
    另一条 ``123``），任何一次「看看我配了哪些模型」都会把凭据写进会话记录与日志。
    为什么在这里改而不是只改 handler：``admin/models.py`` 是 platform、CLI
    (``evoflow models list/get``)、HTTP 路由共用的唯一序列化点（``_model_row``），
    单点改动覆盖全部三个出口；同仓 ``models/credential_sanitize.is_masked_api_key``
    与 ``gateway/routers/models._mask_api_key`` 早就这么做了，此处属漏接。

    掩码格式与网关侧保持一致（首4…末4），保留可辨识度；``len<=8`` 只露末4 位。
    配套：``settings_update_model`` 已用 ``is_masked_api_key`` 丢弃掩码回填，
    所以「读出来是掩码 → 原样写回」不会把 ``****`` 存进配置。
    """
    if not api_key:
        return None
    text = str(api_key)
    if len(text) <= 8:
        return f"****{text[-4:]}" if len(text) > 4 else "****"
    return f"{text[:4]}****{text[-4:]}"


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


def _model_not_found(name: str, config: Any) -> NotFoundError:
    """「Model 'x' not found」必须自带可用的模型名 + 下一步动作。

    【self-evolution-bot · 2026-11-18 · 第52轮 · 模型:deepseek-v4.1-flash-1017】
    现网 obs 实证：`platform` 的 5 次报错里有这条
    ``{"ok": false, "error": "Model 'qwen3.8-flash' not found", "action": "settings.get_model"}``
    ——它只说了「没有」，没说「有的是哪些」，于是调用方只能先调一次
    ``settings.list_models`` 再回来，白绕一步。同文件里 ``unknown action`` 分支
    （platform_actions.py:1585）早就带 ``suggestions``，这条却没带，属同一套能力的漏接。
    """
    names = [str(getattr(m, "name", "") or "") for m in (getattr(config, "models", None) or [])]
    names = [n for n in names if n]
    if not names:
        return NotFoundError(
            f"Model '{name}' not found, and no models are configured. "
            "Add one with settings.create_model before using it."
        )
    shown = ", ".join(names[:20])
    more = "" if len(names) <= 20 else f" (and {len(names) - 20} more)"
    return NotFoundError(
        f"Model '{name}' not found. Configured models: {shown}{more}. "
        "Call settings.list_models to see full config, or settings.create_model to add it."
    )


def get_model(name: str) -> dict[str, Any]:
    config = get_app_config()
    model = config.get_model_config(name)
    if model is None:
        raise _model_not_found(name, config)
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
        # 【self-evolution-bot · 2026-11-18 · 第52轮 · 模型:deepseek-v4.1-flash-1017】
        # 同 get_model：报「没有」时一并给出已配置的模型名，避免调用方多绕一步。
        raise _model_not_found(name, config)
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
        payload = {k: v for k, v in data.items() if v is not None}
        # Platform gate flags (confirm / dry_run …) are not model settings — drop
        # them so they never become a ModelConfig extra (see create_payload_sanitize).
        from evoflow.models.create_payload_sanitize import strip_platform_control_keys

        strip_platform_control_keys(payload)
        model_config = add_model_to_config(payload)
        reload_models_from_db()
        return _model_row(model_config)
    except ValueError as e:
        raise ValidationError(str(e)) from e


def update_model(model_name: str, data: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(data, dict):
        raise ValidationError("Model payload must be a JSON object")
    try:
        payload = {k: v for k, v in data.items() if v is not None}
        from evoflow.models.create_payload_sanitize import strip_platform_control_keys

        strip_platform_control_keys(payload)
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
    from evoflow.models.openai_compat_invoke import OpenAICompatError, invoke_chat_completion

    name = str(data.get("model_name") or data.get("model") or "").strip() or None
    messages_in = data.get("messages")
    if not isinstance(messages_in, list) or not messages_in:
        single = str(data.get("message") or data.get("prompt") or "").strip()
        if not single:
            raise ValidationError("messages or message is required")
        messages_in = [{"role": "user", "content": single}]
        system = str(data.get("system") or "").strip()
        if system:
            messages_in.insert(0, {"role": "system", "content": system})

    temperature = data.get("temperature")
    try:
        result = invoke_chat_completion(
            model=name,
            messages=list(messages_in),
            temperature=float(temperature) if temperature is not None else None,
            thinking_enabled=(
                None if data.get("thinking_enabled") is None else bool(data.get("thinking_enabled"))
            ),
            record_usage=True,
        )
    except OpenAICompatError as e:
        if e.status_code == 404:
            raise NotFoundError(e.message) from e
        raise ValidationError(e.message) from e

    text = ""
    try:
        text = str((((result.get("choices") or [{}])[0].get("message") or {}).get("content")) or "")
    except Exception:
        text = ""
    return {"content": text, "openai": result}


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
            from evoflow.plans.aliyun_token_plan_models import (
                openai_compat_fallback_models as aliyun_plan_fallback_models,
            )
            from evoflow.plans.volc_agent_plan_models import openai_compat_fallback_models

            plan_fb = openai_compat_fallback_models(base) or aliyun_plan_fallback_models(base)
            if plan_fb:
                return {
                    "success": True,
                    "message": (f"Plan endpoint has no GET /models; returning {len(plan_fb)} official catalog IDs"),
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
