import logging
import os
import re
from typing import Any
from urllib.parse import urlparse

from fastapi import Request, APIRouter, HTTPException
from evoflow.authz.http_guard import require_org_admin
from pydantic import BaseModel, Field

from evoflow.config import get_app_config
from evoflow.utils.model_context_length import context_length_from_model_config

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["models"])


class ModelResponse(BaseModel):
    """Response model for model information."""

    name: str = Field(..., description="Unique identifier for the model")
    vendor: str | None = Field(None, description="English vendor id (e.g. aliyun, openai)")
    model: str = Field(..., description="Actual provider model identifier")
    display_name: str | None = Field(None, description="Human-readable name")
    description: str | None = Field(None, description="Model description")
    use: str = Field(..., description="Provider class path")
    base_url: str | None = Field(None, description="Base URL for the API")
    api_key: str | None = Field(None, description="API key (plain by default; set EVOFLOW_MODEL_MASK_API_KEYS=1 to mask)")
    supports_thinking: bool = Field(default=False, description="Whether model supports thinking mode")
    supports_reasoning_effort: bool = Field(default=False, description="Whether model supports reasoning effort")
    supports_vision: bool = Field(default=False, description="Whether model supports vision")
    enable_web_search: bool = Field(
        default=False,
        description="Vendor-native web search (DashScope: extra_body.enable_search)",
    )
    web_search_options: dict | None = Field(
        default=None,
        description="Optional vendor search_options when enable_web_search is on",
    )
    temperature: float | None = Field(None, description="Temperature for generation")
    request_timeout: float | None = Field(None, description="Request timeout in seconds")
    max_retries: int | None = Field(None, description="Maximum number of retries")
    max_tokens: int | None = Field(None, description="Maximum output tokens (generation limit)")
    context_length: int | None = Field(
        None,
        description="Resolved input context window in tokens (for UI compression thresholds)",
    )
    input_context_length: int | None = Field(
        default=None,
        description="Explicit input context window in tokens (panel override)",
    )
    output_context_length: int | None = Field(
        default=None,
        description="Output / max-tokens limit in tokens (panel override)",
    )
    when_thinking_enabled: dict | None = Field(
        default=None,
        description="Provider kwargs used when thinking mode is enabled (if configured)",
    )
    thinking: dict | None = Field(default=None, description="Thinking config: {default_mode, supported_levels[], default_level}")
    fallback_models: list[str] = Field(
        default_factory=list,
        description="Ordered fallback model names tried when this model fails",
    )
    availability_status: str = Field(
        default="available",
        description="available | unavailable",
    )
    unavailable_reason: str | None = Field(None, description="Human-readable unavailable reason")
    unavailable_code: str | None = Field(None, description="Machine code for unavailable reason")
    unavailable_at: str | None = Field(None, description="ISO timestamp when marked unavailable")
    plan_type: str | None = Field(
        default=None,
        description="Plan source type, e.g. volcengine_agent for Agent Plan materialized models",
    )
    plan_config: dict | None = Field(
        default=None,
        description="Plan metadata: tier_id, min_tier, capability, binding_id, etc.",
    )


def _to_model_response(model: Any) -> ModelResponse:
    """Serialize a ModelConfig (or duck-typed row) into the public API shape."""
    fb_raw = getattr(model, "fallback_models", None) or []
    fallback_models = [str(x).strip() for x in fb_raw if str(x or "").strip()]
    status = str(getattr(model, "availability_status", None) or "available").strip().lower()
    if status not in ("available", "unavailable"):
        status = "available"
    return ModelResponse(
        name=model.name,
        vendor=getattr(model, "vendor", None),
        model=model.model,
        display_name=model.display_name,
        description=model.description,
        use=model.use,
        base_url=getattr(model, "base_url", None),
        api_key=_mask_api_key(getattr(model, "api_key", None)),
        supports_thinking=bool(getattr(model, "supports_thinking", False)),
        supports_reasoning_effort=bool(getattr(model, "supports_reasoning_effort", False)),
        supports_vision=bool(getattr(model, "supports_vision", False)),
        enable_web_search=bool(getattr(model, "enable_web_search", False)),
        web_search_options=getattr(model, "web_search_options", None),
        max_tokens=getattr(model, "max_tokens", None),
        temperature=getattr(model, "temperature", None),
        request_timeout=getattr(model, "request_timeout", None),
        max_retries=getattr(model, "max_retries", None),
        context_length=context_length_from_model_config(model),
        input_context_length=getattr(model, "input_context_length", None),
        output_context_length=getattr(model, "output_context_length", None),
        when_thinking_enabled=getattr(model, "when_thinking_enabled", None),
        thinking=getattr(model, "thinking", None),
        fallback_models=fallback_models,
        availability_status=status,
        unavailable_reason=getattr(model, "unavailable_reason", None),
        unavailable_code=getattr(model, "unavailable_code", None),
        unavailable_at=getattr(model, "unavailable_at", None),
        plan_type=getattr(model, "plan_type", None),
        plan_config=getattr(model, "plan_config", None),
    )


class ModelsListResponse(BaseModel):
    """Response model for listing all models."""

    models: list[ModelResponse]


@router.get(
    "/models",
    response_model=ModelsListResponse,
    summary="List All Models",
    description="Retrieve a list of all available AI models configured in the system.",
)
async def list_models() -> ModelsListResponse:
    """List all available models from configuration.

    Returns model information suitable for frontend display,
    excluding sensitive fields like API keys and internal configuration.

    Returns:
        A list of all configured models with their metadata.

    Example Response:
        ```json
        {
            "models": [
                {
                    "name": "gpt-4",
                    "display_name": "GPT-4",
                    "description": "OpenAI GPT-4 model",
                    "supports_thinking": false
                },
                {
                    "name": "claude-3-opus",
                    "display_name": "Claude 3 Opus",
                    "description": "Anthropic Claude 3 Opus model",
                    "supports_thinking": true
                }
            ]
        }
        ```
    """
    from evoflow.config import get_app_config, reload_models_from_db

    try:
        config = reload_models_from_db()
    except Exception:
        config = get_app_config()
    models = [_to_model_response(model) for model in config.models]
    return ModelsListResponse(models=models)


class SetPrimaryModelRequest(BaseModel):
    """Request model for setting the primary (default) model."""

    model_name: str = Field(..., description="Name of the model to set as primary")


@router.get(
    "/models/primary",
    summary="Get Primary Model",
    description="Get the current primary (default) model name.",
)
async def get_primary_model() -> dict:
    """Return resolved primary model name (must match a models[].name entry)."""
    config = get_app_config()
    primary: str | None = None
    raw = (config.primary_model or "").strip() if config.primary_model else ""
    if raw and config.get_model_config(raw) is not None:
        primary = raw
    elif raw:
        logger.warning("config primary_model=%r does not match any model; falling back to first model", raw)
    if primary is None and config.models:
        primary = config.models[0].name
    return {"primary_model": primary}


@router.post(
    "/models/primary",
    summary="Set Primary Model",
    description="Set a model as the primary (default) model by setting the primary_model field in config.",
)
async def set_primary_model(http_request: Request, request: SetPrimaryModelRequest) -> dict:
    """Set primary model (``evoflow_app_settings`` + in-memory config)."""
    require_org_admin(http_request)
    import traceback

    from evoflow.persistence import config_repositories as cfg_repo

    try:
        config = get_app_config()
        model_name = request.model_name.strip()
        model = config.get_model_config(model_name)
        if model is None:
            raise HTTPException(status_code=404, detail=f"Model '{model_name}' not found")

        config.primary_model = model_name
        cfg_repo.set_app_setting("primary_model", model_name)
        logger.info("Primary model set to: %s", model_name)

        return {
            "success": True,
            "message": f"'{model_name}' 已设为主模型",
            "primary_model": model_name,
        }
    except HTTPException:
        raise
    except Exception as e:
        error_detail = f"{str(e)}\n{traceback.format_exc()}"
        logger.error("[ERROR] set_primary_model failed: %s", error_detail)
        raise HTTPException(status_code=500, detail=f"Internal error: {str(e)}") from e


class ModelInvokeMessage(BaseModel):
    """One chat message for server-side model invoke."""

    role: str = Field(..., description="system | user | assistant")
    content: str = Field(..., description="Message text")


_ALLOWED_INVOKE_OBS_KINDS = frozenset({"hosted_panel", "hosted_closure"})


class ModelInvokeRequest(BaseModel):
    """Invoke a configured EvoFlow model (same stack as main chat)."""

    model_name: str | None = Field(
        default=None,
        description="Configured model name; omit or empty to use the first configured model",
    )
    messages: list[ModelInvokeMessage] = Field(..., min_length=1)
    temperature: float | None = Field(default=None, ge=0.0, le=2.0)
    invocation_kind: str | None = Field(
        default=None,
        description="Optional observability label for SQLite (e.g. hosted_panel, hosted_closure).",
    )
    thinking_enabled: bool | None = Field(
        default=None,
        description="Enable extended thinking when the model supports it; omit to use model default (off).",
    )


class ModelInvokeResponse(BaseModel):
    content: str = Field(default="", description="Assistant text")


def _extract_invoke_text(content: object) -> str:
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


@router.post(
    "/models/invoke",
    response_model=ModelInvokeResponse,
    summary="Invoke configured model",
    description="Run one chat completion using EvoFlow DB-backed model config, same as the main agent stack.",
)
async def invoke_configured_model(request: ModelInvokeRequest) -> ModelInvokeResponse:
    from langchain_core.messages import AIMessage, HumanMessage, SystemMessage

    from evoflow.models import create_chat_model

    config = get_app_config()
    if not config.models:
        raise HTTPException(
            status_code=503,
            detail="服务器未配置任何模型，请在设置 → 模型中添加模型",
        )

    name = (request.model_name or "").strip() or None
    if name is not None and config.get_model_config(name) is None:
        raise HTTPException(
            status_code=404,
            detail=f"模型「{name}」不存在。请在对话底部选择已配置的模型，或留空使用默认模型",
        )

    raw_ik = (request.invocation_kind or "").strip().lower()
    obs_ik = raw_ik if raw_ik in _ALLOWED_INVOKE_OBS_KINDS else None
    model_cfg = config.get_model_config(name) if name else (config.models[0] if config.models else None)
    thinking = bool(request.thinking_enabled) if request.thinking_enabled is not None else False
    if thinking and model_cfg is not None and not getattr(model_cfg, "supports_thinking", False):
        thinking = False
    try:
        model = create_chat_model(name=name, thinking_enabled=thinking, invocation_kind=obs_ik)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    if request.temperature is not None:
        try:
            model = model.bind(temperature=request.temperature)
        except Exception:
            logger.debug("model.bind(temperature) skipped", exc_info=True)
    if getattr(model, "streaming", False):
        try:
            model = model.bind(streaming=False)
        except Exception:
            logger.debug("model.bind(streaming=False) skipped", exc_info=True)

    lc_messages: list = []
    for m in request.messages:
        r = m.role.strip().lower()
        if r == "system":
            lc_messages.append(SystemMessage(content=m.content))
        elif r in ("assistant", "ai"):
            lc_messages.append(AIMessage(content=m.content))
        else:
            lc_messages.append(HumanMessage(content=m.content))

    try:
        resp = await model.ainvoke(lc_messages)
    except Exception as e:
        logger.exception("models/invoke failed")
        raise HTTPException(status_code=502, detail=str(e)) from e

    text = _extract_invoke_text(getattr(resp, "content", resp))
    resolved_name = str(name or getattr(model_cfg, "name", "") or "").strip()
    if resolved_name:
        try:
            from evoflow.config import reload_models_from_db
            from evoflow.persistence import config_repositories as cfg_repo

            if cfg_repo.clear_model_unavailable(resolved_name):
                reload_models_from_db()
        except Exception:
            logger.debug(
                "models/invoke: clear unavailable failed for %s",
                resolved_name,
                exc_info=True,
            )
    return ModelInvokeResponse(content=text)


def _mask_api_key(api_key: str | None) -> str | None:
    """Always mask API keys in Panel list/get responses (never echo secrets)."""
    if not api_key:
        return None
    if len(api_key) <= 4:
        return "****"
    return f"****{api_key[-4:]}"


@router.get(
    "/models/tokenizer-status",
    summary="Tokenizer readiness",
    description="Report tiktoken BPE readiness and kick background warm if needed.",
)
async def get_tokenizer_status() -> dict:
    """Must be registered before ``/models/{model_name}`` or FastAPI treats the
    path segment as a model name and returns 404 Model 'tokenizer-status' not found.
    """
    from evoflow.context.compaction_token_utils import (
        ensure_token_encodings_warming,
        token_encodings_ready,
    )

    encodings = ensure_token_encodings_warming()
    ready = token_encodings_ready()
    if ready:
        message = "Tokenizer 已就绪"
    elif any(v == "loading" for v in encodings.values()):
        message = "正在准备 Tokenizer（后台下载/加载，不影响连通性测试）"
    elif any(v == "failed" for v in encodings.values()):
        message = "Tokenizer 准备失败，Token 统计将使用估算值"
    else:
        message = "Tokenizer 未缓存，正在后台准备"
    return {
        "ready": ready,
        "encodings": encodings,
        "message": message,
    }


@router.get(
    "/models/{model_name}",
    response_model=ModelResponse,
    summary="Get Model Details",
    description="Retrieve detailed information about a specific AI model by its name.",
)
async def get_model(model_name: str) -> ModelResponse:
    """Get a specific model by name.

    Args:
        model_name: The unique name of the model to retrieve.

    Returns:
        Model information if found.

    Raises:
        HTTPException: 404 if model not found.

    Example Response:
        ```json
        {
            "name": "gpt-4",
            "display_name": "GPT-4",
            "description": "OpenAI GPT-4 model",
            "supports_thinking": false
        }
        ```
    """
    config = get_app_config()
    model = config.get_model_config(model_name)
    if model is None:
        raise HTTPException(status_code=404, detail=f"Model '{model_name}' not found")

    return _to_model_response(model)


class ModelCreateRequest(BaseModel):
    """Request model for creating/updating a model."""

    name: str = Field(..., description="Unique identifier for the model")
    vendor: str | None = Field(None, description="English vendor id (e.g. aliyun); one connection per vendor in YAML")
    model: str = Field(..., description="Actual provider model identifier")
    display_name: str | None = Field(None, description="Human-readable name")
    description: str | None = Field(None, description="Model description")
    api_key: str | None = Field(None, description="API key for the model")
    base_url: str | None = Field(None, description="Base URL for the API")
    use: str = Field(default="langchain_openai:ChatOpenAI", description="Provider class to use")
    request_timeout: float = Field(default=600.0, description="Request timeout in seconds")
    max_retries: int = Field(default=2, description="Maximum number of retries")
    max_tokens: int = Field(default=65536, description="Maximum output tokens per completion")
    context_length: int | None = Field(
        default=None,
        description="Input context window in tokens (used for compaction thresholds)",
    )
    input_context_length: int | None = Field(
        default=None,
        description="Explicit input context window in tokens (panel override)",
    )
    output_context_length: int | None = Field(
        default=None,
        description="Output / max-tokens limit in tokens (panel override)",
    )
    temperature: float | None = Field(default=None, description="Temperature for generation (unset = use vendor default)")
    supports_vision: bool = Field(default=False, description="Whether model supports vision")
    supports_thinking: bool = Field(default=False, description="Whether model supports thinking mode")
    supports_reasoning_effort: bool = Field(default=False, description="Whether model supports reasoning effort")
    enable_web_search: bool = Field(
        default=False,
        description="Vendor-native web search (DashScope: extra_body.enable_search)",
    )
    web_search_options: dict | None = Field(
        default=None,
        description="Optional vendor search_options when enable_web_search is on",
    )
    when_thinking_enabled: dict | None = Field(
        default=None,
        description="Extra ChatOpenAI kwargs when thinking is on (e.g. extra_body.thinking for OpenAI-compatible gateways)",
    )
    thinking: dict | None = Field(
        default=None,
        description="Thinking config: {default_mode, supported_levels[], default_level}",
    )
    fallback_models: list[str] | None = Field(
        default=None,
        description="Ordered list of fallback model names when this model fails",
    )


@router.post(
    "/models",
    response_model=ModelResponse,
    summary="Create Model",
    description="Add a new AI model to the configuration.",
)
async def create_model(http_request: Request, request: ModelCreateRequest) -> ModelResponse:
    """Create a new model configuration.

    Args:
        request: Model configuration data.

    Returns:
        Created model information.

    Raises:
        HTTPException: 400 if model already exists.
    """
    require_org_admin(http_request)
    import traceback

    from evoflow.config import add_model_to_config, reload_models_from_db

    try:
        request_data = request.model_dump(exclude_none=True)
        model_config = add_model_to_config(request_data)
        reload_models_from_db()
        return _to_model_response(model_config)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        error_detail = f"{str(e)}\n{traceback.format_exc()}"
        print(f"[ERROR] create_model failed: {error_detail}")
        raise HTTPException(status_code=500, detail=f"Internal error: {str(e)}")


@router.put(
    "/models/{model_name}",
    response_model=ModelResponse,
    summary="Update Model",
    description="Update an existing AI model configuration.",
)
async def update_model(http_request: Request, model_name: str, request: ModelCreateRequest) -> ModelResponse:
    """Update an existing model configuration.

    Args:
        model_name: The unique name of the model to update.
        request: Updated model configuration data.

    Returns:
        Updated model information.

    Raises:
        HTTPException: 404 if model not found.
    """
    require_org_admin(http_request)
    import traceback

    from evoflow.config import reload_models_from_db, update_model_in_config

    try:
        request_data = request.model_dump(exclude_unset=True)
        # Skip masked API key to prevent overwriting the real key with a masked value
        _api_key_val = request_data.get("api_key")
        if _api_key_val is not None and str(_api_key_val).startswith("****"):
            request_data.pop("api_key", None)
        # Availability is owned by mark/clear APIs — never accept from Panel sync.
        for _ak in (
            "availability_status",
            "unavailable_reason",
            "unavailable_code",
            "unavailable_at",
        ):
            request_data.pop(_ak, None)
        # Clear null-valued fields so they get written as NULL in the DB
        for k in list(request_data.keys()):
            if request_data[k] is None:
                request_data[k] = None
        model_config = update_model_in_config(model_name, request_data)
        reload_models_from_db()
        return _to_model_response(model_config)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        error_detail = f"{str(e)}\n{traceback.format_exc()}"
        print(f"[ERROR] update_model failed: {error_detail}")
        raise HTTPException(status_code=500, detail=f"Internal error: {str(e)}")


@router.post(
    "/models/{model_name}/clear-unavailable",
    response_model=ModelResponse,
    summary="Clear Model Unavailable Status",
    description="Mark a model as available again (admin / after fixing credentials).",
)
async def clear_model_unavailable_status(request: Request, model_name: str) -> ModelResponse:
    require_org_admin(request)
    from evoflow.config import get_app_config, reload_models_from_db
    from evoflow.persistence import config_repositories as cfg_repo

    name = str(model_name or "").strip()
    if not name:
        raise HTTPException(status_code=422, detail="model_name required")
    if not cfg_repo.get_model(name):
        raise HTTPException(status_code=404, detail=f"Model '{name}' not found")
    cfg_repo.clear_model_unavailable(name)
    reload_models_from_db()
    cfg = get_app_config()
    mc = cfg.get_model_config(name)
    if mc is None:
        raise HTTPException(status_code=404, detail=f"Model '{name}' not found")
    return _to_model_response(mc)


@router.delete(
    "/models/{model_name}",
    summary="Delete Model",
    description="Remove an AI model from the configuration.",
)
async def delete_model(request: Request, model_name: str) -> dict:
    """Delete a model configuration.

    Args:
        model_name: The unique name of the model to delete.

    Returns:
        Success message.

    Raises:
        HTTPException: 404 if model not found.
    """
    require_org_admin(request)
    from evoflow.config import reload_models_from_db, remove_model_from_config

    try:
        remove_model_from_config(model_name)
        reload_models_from_db()
        return {"message": f"Model '{model_name}' deleted successfully"}
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))


class EmbeddingProbeRequest(BaseModel):
    """Probe whether an embedding model can produce vectors."""

    model_name: str = Field(..., description="Configured model name (evoflow_models.name)")


@router.post(
    "/models/embedding-probe",
    summary="Probe Embedding Model",
    description="Run a lightweight embedding call to verify the model is ready.",
)
async def probe_embedding_model(http_request: Request, request: EmbeddingProbeRequest) -> dict:
    """Return whether the named embedding model is usable."""
    require_org_admin(http_request)
    from evoflow.config import get_app_config
    from evoflow.knowledge.embedding import get_embedding

    config = get_app_config()
    mc = config.get_model_config(request.model_name.strip())
    if mc is None:
        raise HTTPException(status_code=404, detail=f"Model '{request.model_name}' not found")
    try:
        vec = await get_embedding("probe", mc)
        if vec and len(vec) > 0:
            return {"ok": True}
        return {"ok": False, "message": "返回向量为空"}
    except Exception as exc:
        return {"ok": False, "message": str(exc)}


_OPENAI_COMPAT_VERSION_SUFFIX = re.compile(r"/v\d+/?$")


def openai_compat_chat_base_url(base_url: str) -> str:
    """Normalize base URL for OpenAI-compatible POST …/chat/completions.

    Only appends ``/v1`` when the URL has no API version segment. Providers such as
    Volcengine Ark (``…/api/v3``) and Zhipu (``…/api/paas/v4``) must be left unchanged;
    the previous logic treated any URL without the substring ``/v1`` as needing ``/v1``,
    which produced invalid paths like ``…/api/v3/v1`` and HTTP 404 on model test.
    """
    base = (base_url or "").strip().rstrip("/")
    if not base:
        return base
    if _OPENAI_COMPAT_VERSION_SUFFIX.search(base):
        return base
    if "/v1" in base:
        return base
    return f"{base}/v1"


def _api_type_from_model_use(use: str | None) -> str:
    u = str(use or "").lower()
    if "anthropic" in u:
        return "anthropic-messages"
    if "google" in u or "genai" in u or "gemini" in u:
        return "google-generative-ai"
    return "openai-completions"


def _resolve_test_connection(
    request: "TestModelRequest",
) -> tuple[str, str, str, str, str | None]:
    """Resolve base_url / api_key / model_id / api_type / config_name for connectivity probe.

    When ``config_name`` is set, missing fields are filled from the DB-backed
    model config so the panel can test without re-applying or using /models/invoke.
    """
    config_name = str(request.config_name or "").strip() or None
    base_url = str(request.base_url or "").strip()
    api_key = str(request.api_key or "")
    model_id = str(request.model_id or "").strip()
    api_type = (request.api_type or "").strip() or None

    if config_name:
        cfg = get_app_config().get_model_config(config_name)
        if cfg is None:
            raise HTTPException(
                status_code=404,
                detail=(
                    f"模型「{config_name}」不存在。"
                    "请先保存配置后再测试，或提供 base_url / api_key"
                ),
            )
        if not base_url:
            base_url = str(getattr(cfg, "base_url", None) or "").strip()
        if not model_id:
            model_id = str(getattr(cfg, "model", None) or "").strip()
        if not str(api_key or "").strip():
            api_key = str(getattr(cfg, "api_key", None) or "")
        if not api_type:
            api_type = _api_type_from_model_use(getattr(cfg, "use", None))

    api_type = api_type or "openai-completions"
    if not base_url:
        raise HTTPException(status_code=400, detail="缺少 base_url")
    if not model_id:
        raise HTTPException(status_code=400, detail="缺少 model_id")
    return base_url, api_key, model_id, api_type, config_name


class TestModelRequest(BaseModel):
    """Lightweight connectivity probe (httpx only — no LangChain / tiktoken)."""

    base_url: str = Field(
        default="",
        description="Base URL for the API (optional when config_name is set)",
    )
    api_key: str = Field(default="", description="API key for authentication")
    model_id: str = Field(
        default="",
        description="Provider model id (optional when config_name is set)",
    )
    api_type: str | None = Field(
        default=None,
        description="API type (openai-completions, anthropic-messages, etc.)",
    )
    config_name: str | None = Field(
        default=None,
        description=(
            "Optional evoflow_models.name; fills missing credentials from DB and "
            "on success clears unavailable status"
        ),
    )


@router.post(
    "/models/test",
    summary="Test Model Connection",
    description=(
        "Test connectivity with a simple vendor HTTP request. "
        "Does not apply config, invoke LangChain, or load tiktoken."
    ),
)
async def test_model_connection(http_request: Request, request: TestModelRequest) -> dict:
    """Test model connectivity via httpx only."""
    require_org_admin(http_request)
    import traceback

    import httpx

    try:
        base_url, api_key, model_id, api_type, config_name = _resolve_test_connection(request)
    except HTTPException as e:
        detail = e.detail
        if isinstance(detail, str):
            return {"success": False, "message": detail}
        return {"success": False, "message": str(detail)}

    base_url = base_url.rstrip("/")

    if api_type == "openai-completions":
        base_url = openai_compat_chat_base_url(base_url)

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            if api_type == "anthropic-messages":
                from evoflow.models.anthropic_url import anthropic_messages_http_url

                # Official: base https://api.anthropic.com + POST /v1/messages
                # (do not treat Anthropic like OpenAI …/v1 + /messages)
                url = anthropic_messages_http_url(base_url)
                body = {
                    "model": model_id,
                    "messages": [{"role": "user", "content": "Hi"}],
                    "max_tokens": 16,
                }
                headers = {
                    "anthropic-version": "2023-06-01",
                    "content-type": "application/json",
                }
                if api_key:
                    headers["x-api-key"] = api_key
                resp = await client.post(url, json=body, headers=headers)

            elif api_type == "google-generative-ai":
                url = f"{base_url}/models/{model_id}:generateContent?key={api_key}"
                body = {"contents": [{"role": "user", "parts": [{"text": "Hi"}]}]}
                resp = await client.post(url, json=body)

            else:  # openai-completions (default)
                url = f"{base_url}/chat/completions"
                body = {
                    "model": model_id,
                    "messages": [{"role": "user", "content": "Hi"}],
                    "max_tokens": 16,
                }
                headers = {"content-type": "application/json"}
                if api_key:
                    headers["authorization"] = f"Bearer {api_key}"
                resp = await client.post(url, json=body, headers=headers)

            if resp.status_code == 200:
                if config_name:
                    try:
                        from evoflow.config import reload_models_from_db
                        from evoflow.persistence import config_repositories as cfg_repo

                        if cfg_repo.clear_model_unavailable(config_name):
                            reload_models_from_db()
                    except Exception:
                        logger.debug(
                            "test_model: clear unavailable failed for %s",
                            config_name,
                            exc_info=True,
                        )
                return {"success": True, "message": "连接成功"}
            else:
                error_text = resp.text[:200] if resp.text else f"HTTP {resp.status_code}"
                return {"success": False, "message": f"连接失败: {error_text}"}

    except httpx.TimeoutException:
        return {"success": False, "message": "连接超时，请检查网络或 base URL"}
    except Exception as e:
        error_detail = f"{str(e)}\n{traceback.format_exc()}"
        print(f"[ERROR] test_model failed: {error_detail}")
        return {"success": False, "message": f"连接失败: {str(e)}"}


_OPENAI_STYLE_MODEL_LIST = frozenset({"openai-completions", "openai-responses"})

# 百炼 Coding 专线不提供 OpenAI /models（恒 404）。以下为控制台/文档常见模型名，供面板参考导入。
_DASHSCOPE_CODING_FALLBACK_MODEL_IDS: tuple[str, ...] = (
    "qwen3-coder-plus",
    "qwen3-coder-flash",
    "qwen-coder-plus",
    "qwen-coder-turbo",
    "qwen3-max",
    "qwen-max",
    "qwen-plus",
    "qwen-plus-latest",
    "qwen-turbo",
    "qwen-flash",
    "qwen3.6-plus",
    "qwen3.5-plus",
    "qwq-plus",
    "deepseek-v3",
    "deepseek-r1",
    "kimi-k2.5",
    "glm-5",
    "MiniMax-M2.5",
)


def _dashscope_coding_fallback_models() -> list[dict]:
    return [{"id": mid} for mid in _DASHSCOPE_CODING_FALLBACK_MODEL_IDS]


class ListRemoteModelsRequest(BaseModel):
    """List models via OpenAI-compatible GET {base_url}/models."""

    base_url: str = Field(..., description="API root, e.g. https://api.openai.com/v1 or .../compatible-mode/v1")
    api_key: str = Field(default="", description="Bearer token (same as chat/completions)")
    api_type: str | None = Field(
        default="openai-completions",
        description="openai-completions / openai-responses（与 OpenAI 同源 /models 列表）",
    )


@router.post(
    "/models/list-remote",
    summary="List models from remote OpenAI-compatible API",
    description="Server-side GET {base_url}/models with Bearer auth; used by panel to import model IDs.",
)
async def list_remote_openai_models(http_request: Request, request: ListRemoteModelsRequest) -> dict:
    """Fetch model catalog from a vendor (OpenAI-compatible /models)."""
    require_org_admin(http_request)
    import httpx

    api_type = (request.api_type or "openai-completions").strip().lower()
    if api_type not in _OPENAI_STYLE_MODEL_LIST:
        return {
            "success": False,
            "message": f"仅支持 OpenAI 兼容接口拉取列表（openai-completions / openai-responses），当前 api_type={api_type}",
            "models": [],
        }

    base = (request.base_url or "").strip().rstrip("/")
    if not base:
        return {"success": False, "message": "base_url 为空", "models": []}

    url = f"{base}/models"
    headers: dict[str, str] = {"accept": "application/json"}
    key = (request.api_key or "").strip()
    if key:
        headers["authorization"] = f"Bearer {key}"

    try:
        async with httpx.AsyncClient(timeout=45.0) as client:
            resp = await client.get(url, headers=headers)
    except httpx.TimeoutException:
        return {"success": False, "message": "请求超时，请检查网络", "models": []}
    except Exception as e:
        logger.exception("list_remote_openai_models transport error")
        return {"success": False, "message": f"请求失败: {e}", "models": []}

    if resp.status_code != 200:
        snippet = (resp.text or "")[:400].replace("\n", " ")
        if resp.status_code == 404:
            try:
                host = (urlparse(url).hostname or "").lower()
            except Exception:
                host = ""
            if "coding.dashscope.aliyuncs.com" in host:
                fb = _dashscope_coding_fallback_models()
                return {
                    "success": True,
                    "message": (f"Coding 专线不提供 OpenAI 的 GET /models（返回 404）；下列 {len(fb)} 个为常见模型 ID，供参考导入，实际以百炼控制台为准"),
                    "models": fb,
                    "degraded": True,
                }
            from evoflow.plans.volc_agent_plan_models import openai_compat_fallback_models

            plan_fb = openai_compat_fallback_models(base)
            if plan_fb:
                return {
                    "success": True,
                    "message": (
                        f"Agent Plan 专线通常不提供 GET /models（HTTP 404）；"
                        f"下列 {len(plan_fb)} 个为官方套餐概览对话模型，绑定全家桶时会自动写入"
                    ),
                    "models": plan_fb,
                    "degraded": True,
                }
        return {
            "success": False,
            "message": f"厂商返回 HTTP {resp.status_code}: {snippet}",
            "models": [],
        }

    try:
        payload = resp.json()
    except Exception:
        return {"success": False, "message": "响应不是合法 JSON", "models": []}

    rows = payload.get("data")
    if rows is None:
        rows = payload.get("models")
    if not isinstance(rows, list):
        return {"success": False, "message": "响应中未找到 data 或 models 数组", "models": []}

    out: list[dict] = []
    for item in rows:
        if isinstance(item, str):
            mid = item.strip()
            owned_by = None
            created = None
        elif isinstance(item, dict):
            raw_id = item.get("id") or item.get("name") or item.get("model")
            mid = str(raw_id).strip() if raw_id is not None else ""
            owned_by = item.get("owned_by")
            created = item.get("created")
        else:
            continue
        if not mid:
            continue
        row: dict = {"id": mid}
        if owned_by is not None:
            row["owned_by"] = str(owned_by)
        if created is not None:
            row["created"] = created
        out.append(row)

    return {"success": True, "message": f"共 {len(out)} 个模型", "models": out}


class ModelConnectionResponse(BaseModel):
    """Panel LLM provider connection (independent of model rows)."""

    key: str = Field(..., description="Provider connection key (matches evoflow_models.vendor)")
    base_url: str = Field(default="", description="API base URL")
    api_key: str | None = Field(default=None, description="API key (masked when EVOFLOW_MODEL_MASK_API_KEYS=1)")
    api_type: str = Field(default="openai-completions", description="Panel API type")
    display_name: str | None = Field(default=None, description="Custom connection display name")


class ModelConnectionsListResponse(BaseModel):
    connections: list[ModelConnectionResponse]


class ModelConnectionsSyncRequest(BaseModel):
    connections: list[ModelConnectionResponse] = Field(default_factory=list)


def _connection_to_response(row: dict) -> ModelConnectionResponse:
    display = str(row.get("display_name") or "").strip() or None
    return ModelConnectionResponse(
        key=str(row["key"]),
        base_url=str(row.get("base_url") or ""),
        api_key=_mask_api_key(str(row.get("api_key") or "") or None),
        api_type=str(row.get("api_type") or "openai-completions"),
        display_name=display,
    )


@router.get(
    "/model-connections",
    response_model=ModelConnectionsListResponse,
    summary="List Model Connections",
    description="List Panel LLM provider connections stored independently of model rows.",
)
async def list_model_connections(request: Request) -> ModelConnectionsListResponse:
    require_org_admin(request)
    from evoflow.persistence import model_connections as conn_repo

    rows = conn_repo.list_model_connections()
    return ModelConnectionsListResponse(
        connections=[_connection_to_response(r) for r in rows.values()],
    )


@router.post(
    "/model-connections/sync",
    response_model=ModelConnectionsListResponse,
    summary="Sync Model Connections",
    description="Replace Panel-managed connections (upsert desired + delete orphans).",
)
async def sync_model_connections(http_request: Request, request: ModelConnectionsSyncRequest) -> ModelConnectionsListResponse:
    require_org_admin(http_request)
    from evoflow.config import reload_models_from_db
    from evoflow.persistence import model_connections as conn_repo

    payload = [c.model_dump(exclude_none=True) for c in request.connections]
    rows = conn_repo.sync_model_connections(payload)
    # Connection api_key/base_url are mirrored onto evoflow_models; refresh process cache.
    reload_models_from_db()
    return ModelConnectionsListResponse(
        connections=[_connection_to_response(r) for r in rows.values()],
    )


@router.delete(
    "/model-connections/{key}",
    summary="Delete Model Connection",
    description=(
        "Remove a Panel LLM provider connection and every model row owned by it "
        "(vendor == key). Returns the names of deleted models."
    ),
)
async def delete_model_connection(request: Request, key: str) -> dict:
    require_org_admin(request)
    from evoflow.config import reload_models_from_db
    from evoflow.persistence import model_connections as conn_repo

    conn = conn_repo.get_model_connection(key)
    if conn is None:
        raise HTTPException(status_code=404, detail=f"Connection '{key}' not found")

    deleted_models = conn_repo.delete_model_connection(key)
    reload_models_from_db()
    return {
        "ok": True,
        "deleted": deleted_models,
        "message": f"Connection '{key}' deleted",
    }


@router.post(
    "/models/cleanup-stale",
    summary="Cleanup Stale Panel Models",
    description="Remove legacy duplicate model rows and superseded connection links from historical Panel data.",
)
async def cleanup_stale_panel_models(request: Request) -> dict:
    require_org_admin(request)
    from evoflow.config import reload_models_from_db
    from evoflow.persistence.model_cleanup import cleanup_stale_panel_models

    result = cleanup_stale_panel_models()
    reload_models_from_db()
    return {"ok": True, **result}
