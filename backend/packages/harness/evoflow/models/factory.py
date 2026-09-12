import logging
import os
import time
from typing import Any
from urllib.parse import urlparse

from langchain.chat_models import BaseChatModel
from langchain_openai import ChatOpenAI

from evoflow.config import get_app_config, get_tracing_config, is_tracing_enabled
from evoflow.config.app_config import AppConfig
from evoflow.config.credential_pool import build_pool_from_config
from evoflow.config.models_yaml import infer_vendor_from_connection
from evoflow.models.credential_sanitize import (
    patch_chat_model_instance_credentials,
    resolve_and_sanitize_api_key,
    sanitize_model_connection_settings,
)
from evoflow.reflection import resolve_class

logger = logging.getLogger(__name__)


_VALID_REASONING_EFFORTS = {"none", "minimal", "low", "medium", "high", "xhigh"}
_REASONING_EFFORT_ALIASES = {
    "minimum": "minimal",
    "min": "minimal",
    "max": "xhigh",
}
# Volcengine Ark OpenAI-compat: ``thinking`` must be ``{type, budget_tokens}``, not ``type: auto``.
_VOLC_THINKING_BUDGET_BY_EFFORT: dict[str, int] = {
    "minimal": 4096,
    "low": 8192,
    "medium": 16384,
    "high": 32768,
    "xhigh": 49152,
}
# Minimum tokens reserved for visible assistant content (after thinking) on Volc Ark.
_VOLC_COMPLETION_RESERVE_MIN = 8192
_VOLC_COMPLETION_RESERVE_DEFAULT = 16384
_OPENAI_COMPAT_MAX_OUTPUT_TOKENS = 65536

# EvoFlow-only config keys that must not reach LangChain / OpenAI SDK constructors.
_PROVIDER_INTERNAL_KEYS = frozenset(
    {
        "credentials",
        "credential_strategy",
        "_credential_pool",
        "context_length",
        "input_context_length",
        "output_context_length",
        "fallback_models",
        "enable_web_search",
        "web_search_options",
        # Runtime health (v122) — never pass to vendor create()
        "availability_status",
        "unavailable_reason",
        "unavailable_code",
        "unavailable_at",
        # Agent Plan metadata (v124) — EvoFlow-only, not vendor HTTP params
        "plan_type",
        "plan_config",
    }
)


def _strip_provider_internal_keys(settings: dict[str, Any] | None) -> dict[str, Any]:
    if not settings:
        return {}
    return {k: v for k, v in settings.items() if k not in _PROVIDER_INTERNAL_KEYS}


def _is_local_noauth_endpoint(base_url: Any, vendor: Any = None) -> bool:
    """True for Ollama / localhost OpenAI-compat endpoints that typically need no API key."""
    v = str(vendor or "").strip().lower()
    if v == "ollama" or v.startswith("ollama-"):
        return True
    host = (urlparse(str(base_url or "").strip()).hostname or "").lower()
    if not host:
        return False
    if host in {"localhost", "127.0.0.1", "::1"} or host.endswith(".localhost"):
        return True
    return "ollama" in host


def _normalize_reasoning_effort(v):
    """Normalize frontend/runtime reasoning_effort into provider-safe value."""
    if v is None:
        return None
    # Accept object forms like {"effort": "minimal"} from external callers.
    if isinstance(v, dict):
        v = v.get("effort")
    s = str(v).strip().lower()
    if not s:
        return None
    if s == "x-high":
        s = "xhigh"
    s = _REASONING_EFFORT_ALIASES.get(s, s)
    if s in _VALID_REASONING_EFFORTS:
        return s
    return None


_THINKING_UI_KEYS = frozenset(
    {
        "default_mode",
        "defaultMode",
        "supported_levels",
        "supportedLevels",
        "default_level",
        "defaultLevel",
    }
)


def _model_thinking_ui_config(model_config: Any) -> dict[str, Any]:
    thinking = getattr(model_config, "thinking", None)
    return dict(thinking) if isinstance(thinking, dict) else {}


def _thinking_vendor_kwargs(thinking: Any) -> dict[str, Any]:
    """Vendor HTTP ``thinking`` fields only — exclude Settings → Models UI metadata."""
    if not isinstance(thinking, dict):
        return {}
    return {k: v for k, v in thinking.items() if k not in _THINKING_UI_KEYS}


def _model_default_reasoning_effort(model_config: Any) -> str | None:
    """Settings → Models ``thinking.default_level`` (skipped when ``auto`` or empty)."""
    cfg = _model_thinking_ui_config(model_config)
    raw = cfg.get("default_level") or cfg.get("defaultLevel")
    if raw is None:
        return None
    s = str(raw).strip().lower()
    if not s or s == "auto":
        return None
    return _normalize_reasoning_effort(s)


def resolve_model_default_thinking_mode(model_config: Any | None) -> str:
    """Settings → Models ``thinking.default_mode``: ``auto`` | ``enabled`` | ``disabled``."""
    if model_config is None:
        return "auto"
    cfg = _model_thinking_ui_config(model_config)
    raw = str(cfg.get("default_mode") or cfg.get("defaultMode") or "auto").strip().lower()
    if raw in ("enabled", "on", "true", "open"):
        return "enabled"
    if raw in ("disabled", "off", "false", "closed", "none"):
        return "disabled"
    return "auto"


def _clamp_effort_to_supported(model_config: Any, effort: str) -> str:
    cfg = _model_thinking_ui_config(model_config)
    supported = cfg.get("supported_levels") or cfg.get("supportedLevels")
    if not isinstance(supported, list) or not supported:
        return effort
    normalized: list[str] = []
    for item in supported:
        norm = _normalize_reasoning_effort(str(item or "").replace("x-high", "xhigh"))
        if norm and norm not in normalized:
            normalized.append(norm)
    if not normalized:
        return effort
    if effort in normalized:
        return effort
    return normalized[0]


def resolve_effective_reasoning_effort(
    runtime_effort: str | None,
    model_config: Any,
    *,
    thinking_enabled: bool = True,
) -> str | None:
    """Merge session/auto effort with per-model default thinking depth from Settings → Models.

    Priority: explicit user-chosen runtime effort > model default_level > 'medium'.
    User manual selection (thinking_type='manual') carries runtime_effort that must win
    over the model's configured default_level.
    """
    if not thinking_enabled:
        return _normalize_reasoning_effort(runtime_effort)
    runtime = _normalize_reasoning_effort(runtime_effort)
    if runtime is not None:
        return _clamp_effort_to_supported(model_config, runtime)
    model_default = _model_default_reasoning_effort(model_config)
    if model_default is not None:
        return _clamp_effort_to_supported(model_config, model_default)
    return "medium"


def _resolve_model_use_path(model_config) -> str:
    """Resolve provider class path, with safe auto-patching for ChatOpenAI.

    Stock ``langchain_openai:ChatOpenAI`` crashes when a gateway returns a plain
    text/HTML body: ``'str' object has no attribute 'model_dump'`` (see
    ``BaseChatOpenAI._create_chat_result``). Always route to ``PatchedChatOpenAI``,
    which also preserves streamed reasoning / thought_signature for known gateways.
    """
    use_path = str(getattr(model_config, "use", "") or "")
    if use_path == "langchain_openai:ChatOpenAI":
        return "evoflow.models.patched_openai:PatchedChatOpenAI"
    return use_path


def _is_dashscope_like_host(model_config) -> bool:
    """True for Aliyun DashScope OpenAI-compatible endpoints (coding / compatible-mode)."""
    base_url = str(getattr(model_config, "base_url", "") or "").strip().lower()
    host = (urlparse(base_url).hostname or "").lower() if base_url else ""
    vendor = str(getattr(model_config, "vendor", "") or "").strip().lower()
    return ("dashscope" in host) or ("aliyuncs.com" in host) or ("aliyun" in vendor)


def _apply_native_web_search(
    model_config: Any,
    model_settings: dict[str, Any],
    kwargs: dict[str, Any],
) -> None:
    """Inject vendor-native web search into request kwargs when configured.

    Phase 1: DashScope/Aliyun → ``extra_body.enable_search`` (+ optional ``search_options``).
    Other vendors are no-ops with a warning (tools-injection vendors need a later phase).
    """
    if not bool(getattr(model_config, "enable_web_search", False)):
        return
    if not _is_dashscope_like_host(model_config):
        logger.warning(
            "Model %s: enable_web_search is set but host/vendor is not DashScope-like; ignoring",
            getattr(model_config, "name", "?"),
        )
        return
    base = dict(kwargs.get("extra_body") or model_settings.get("extra_body") or {})
    base["enable_search"] = True
    opts = getattr(model_config, "web_search_options", None)
    if isinstance(opts, dict) and opts:
        base["search_options"] = dict(opts)
    kwargs["extra_body"] = base
    model_settings["extra_body"] = dict(base)


def _is_zhipu_like_host(model_config) -> bool:
    """True for Zhipu GLM OpenAI-compatible endpoints."""
    base_url = str(getattr(model_config, "base_url", "") or "").strip().lower()
    host = (urlparse(base_url).hostname or "").lower() if base_url else ""
    vendor = str(getattr(model_config, "vendor", "") or "").strip().lower()
    return ("bigmodel.cn" in host) or ("zhipu" in vendor)


def _is_volcengine_like_host(model_config) -> bool:
    """True for Volcengine Ark / Doubao OpenAI-compatible endpoints."""
    base_url = str(getattr(model_config, "base_url", "") or "").strip().lower()
    host = (urlparse(base_url).hostname or "").lower() if base_url else ""
    vendor = str(getattr(model_config, "vendor", "") or "").strip().lower()
    return ("volces.com" in host) or ("volcengine" in host) or ("volcengine" in vendor)


def _is_anthropic_native(model_class: type) -> bool:
    """True when the model class accepts ``thinking`` as a direct constructor parameter.

    Only the ``ChatAnthropic`` family (incl. ``ClaudeChatModel``) has a native ``thinking`` field.
    OpenAI-compatible models (``ChatOpenAI``, ``ChatDeepSeek``, …) must nest ``thinking`` under
    ``extra_body`` — passing it top-level triggers a UserWarning and silently lands in ``model_kwargs``.
    """
    try:
        from langchain_anthropic import ChatAnthropic

        return issubclass(model_class, ChatAnthropic)
    except ImportError:
        return False


def _effective_when_thinking_enabled(model_config) -> dict:
    effective_wte: dict = dict(model_config.when_thinking_enabled) if model_config.when_thinking_enabled else {}
    vendor_thinking = _thinking_vendor_kwargs(getattr(model_config, "thinking", None))
    if vendor_thinking:
        merged_thinking = {**(effective_wte.get("thinking") or {}), **vendor_thinking}
        effective_wte = {**effective_wte, "thinking": merged_thinking}
    return effective_wte


def _nest_openai_compat_thinking_kwargs(model_class: type, kwargs: dict[str, Any]) -> None:
    """Move ``thinking`` / ``reasoning`` from LangChain model_kwargs into ``extra_body``.

    OpenAI SDK ``AsyncCompletions.create()`` rejects top-level ``thinking``; vendor gateways
    expect it under ``extra_body`` (Anthropic native ChatAnthropic is the exception).
    """
    if _is_anthropic_native(model_class):
        return
    from evoflow.models.volc_payload import _merge_vendor_extra_body

    vendor: dict[str, Any] = {}
    if "thinking" in kwargs:
        vendor["thinking"] = kwargs.get("thinking")
    reasoning = kwargs.get("reasoning")
    if isinstance(reasoning, dict):
        vendor["reasoning"] = reasoning
    if vendor:
        _merge_vendor_extra_body(kwargs, vendor)


def _merge_extra_body_thinking(kwargs: dict[str, Any], model_settings: dict[str, Any], thinking_patch: dict[str, Any]) -> None:
    """Merge ``extra_body.thinking`` into runtime kwargs (preferred for OpenAI-compat gateways)."""
    base = dict(kwargs.get("extra_body") or model_settings.get("extra_body") or {})
    thinking = dict(base.get("thinking") or {})
    thinking.update(thinking_patch)
    base["thinking"] = thinking
    kwargs["extra_body"] = base


def _omit_vendor_thinking_kwargs(model_settings_from_config: dict[str, Any], kwargs: dict[str, Any]) -> None:
    """Strip thinking-related kwargs so the vendor uses its native default policy."""
    for key in ("reasoning_effort", "thinking"):
        kwargs.pop(key, None)
        model_settings_from_config.pop(key, None)
    for container in (model_settings_from_config, kwargs):
        eb = container.get("extra_body")
        if not isinstance(eb, dict):
            continue
        eb = dict(eb)
        for k in ("enable_thinking", "thinking_budget", "thinkingBudget", "thinking", "reasoning", "reasoning_effort"):
            eb.pop(k, None)
        if eb:
            container["extra_body"] = eb
        else:
            container.pop("extra_body", None)


def _apply_vendor_auto_thinking(
    model_config: Any,
    model_settings_from_config: dict[str, Any],
    kwargs: dict[str, Any],
    model_class: type,
) -> bool:
    """Map session ``thinking_type=auto`` to vendor-native parameters.

    Auto means **omit** thinking kwargs — let the provider decide (DashScope-style for all vendors).
    Returns True when auto handling was applied (caller should skip ``when_thinking_enabled`` merge
    and explicit disable injection).
    """
    del model_config, model_class  # unused — omit path is vendor-agnostic
    _omit_vendor_thinking_kwargs(model_settings_from_config, kwargs)
    return True


def _ensure_stream_usage_for_openai_compat(model_class: type, model_config: Any, model_settings: dict[str, Any]) -> None:
    """Turn on LangChain ``stream_usage`` for OpenAI-compatible chat models.

    LangChain maps this to ``stream_options.include_usage`` on streaming requests so
    token usage is available in the final stream chunk (DashScope, Volcengine Ark, MiniMax, etc.).
    Set ``stream_usage: false`` in the model DB row / panel to opt out per model.
    """
    if not issubclass(model_class, ChatOpenAI):
        return
    if model_settings.get("stream_usage") is not None:
        return
    model_settings["stream_usage"] = True
    logger.info(
        "Model %s: stream_usage=True (OpenAI-compatible) for streaming token usage in AIMessage",
        getattr(model_config, "name", "?"),
    )


def _clamp_openai_compat_max_tokens(model_class: type, model_config: Any, model_settings: dict[str, Any]) -> None:
    if not issubclass(model_class, ChatOpenAI):
        return
    raw = model_settings.get("max_tokens")
    if raw is None:
        return
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return
    if value <= _OPENAI_COMPAT_MAX_OUTPUT_TOKENS:
        return
    model_settings["max_tokens"] = _OPENAI_COMPAT_MAX_OUTPUT_TOKENS
    logger.warning(
        "Model %s: max_tokens=%s exceeds OpenAI-compatible gateway limit; clamped to %s",
        getattr(model_config, "name", "?"),
        value,
        _OPENAI_COMPAT_MAX_OUTPUT_TOKENS,
    )


def _sanitize_openai_compat_reasoning_effort(model_class: type, model_config: Any, model_settings: dict[str, Any]) -> None:
    if not issubclass(model_class, ChatOpenAI):
        return
    if _is_volcengine_like_host(model_config) and _volc_uses_reasoning_effort_api(model_config):
        # Official Volc Chat API uses ``reasoning.effort`` (normalized at HTTP payload time).
        model_settings.pop("reasoning_effort", None)
        return
    if _is_dashscope_like_host(model_config) or _is_zhipu_like_host(model_config):
        # Depth is mapped at HTTP time (thinking_budget / reasoning_effort).
        model_settings.pop("reasoning_effort", None)
        return
    effort = _normalize_reasoning_effort(model_settings.get("reasoning_effort"))
    if effort is None:
        model_settings.pop("reasoning_effort", None)
        return
    mapped = {"minimal": "low", "xhigh": "high"}.get(effort, effort)
    if mapped != model_settings.get("reasoning_effort"):
        model_settings["reasoning_effort"] = mapped
        logger.warning(
            "Model %s: reasoning_effort=%s is not supported by OpenAI-compatible gateways; mapped to %s",
            getattr(model_config, "name", "?"),
            effort,
            mapped,
        )


def _effective_max_output_tokens(model_config: Any, model_settings: dict[str, Any]) -> int:
    """Best-effort output cap from model row (``output_context_length`` / ``max_tokens``)."""
    from evoflow.config.model_config import resolve_model_max_output_tokens

    candidates: list[int] = []
    ocl = getattr(model_config, "output_context_length", None)
    if ocl is not None:
        try:
            n = int(ocl)
            if n > 0:
                candidates.append(n)
        except (TypeError, ValueError):
            pass
    raw = model_settings.get("max_tokens")
    try:
        mt = int(raw) if raw is not None else None
    except (TypeError, ValueError):
        mt = None
    candidates.append(resolve_model_max_output_tokens(mt))
    return max(candidates) if candidates else resolve_model_max_output_tokens(None)


def _volc_completion_reserve_tokens(max_out: int) -> int:
    """Tokens to reserve for assistant ``content`` / tool calls after thinking."""
    raw = os.environ.get("EVOFLOW_VOLC_COMPLETION_RESERVE_TOKENS", "").strip()
    if raw:
        try:
            return max(1024, int(raw))
        except ValueError:
            pass
    # Keep a large completion stage: at least 16K or 25% of the output budget.
    return max(_VOLC_COMPLETION_RESERVE_DEFAULT, max_out // 4, _VOLC_COMPLETION_RESERVE_MIN)


def _volc_thinking_budget_floor(model_settings: dict[str, Any], kwargs: dict[str, Any]) -> int:
    effort = _normalize_reasoning_effort(
        kwargs.get("_evoflow_reasoning_effort")
        or kwargs.get("reasoning_effort")
        or model_settings.get("reasoning_effort")
    )
    return _VOLC_THINKING_BUDGET_BY_EFFORT.get(effort or "medium", _VOLC_THINKING_BUDGET_BY_EFFORT["medium"])


def _volc_thinking_budget_from_probe(probe: dict[str, Any]) -> int | None:
    extra = probe.get("extra_body")
    if not isinstance(extra, dict):
        return None
    th = extra.get("thinking")
    if not isinstance(th, dict):
        return None
    raw = th.get("budget_tokens") if th.get("budget_tokens") is not None else th.get("budgetTokens")
    if raw is None:
        return None
    try:
        return int(raw)
    except (TypeError, ValueError):
        return None


def _volc_target_thinking_budget(
    probe: dict[str, Any],
    model_settings: dict[str, Any],
    kwargs: dict[str, Any],
) -> int:
    """Resolve thinking budget from explicit vendor config or session reasoning effort."""
    configured = _volc_thinking_budget_from_probe(probe)
    if configured is not None and configured > 0:
        return configured
    return _volc_thinking_budget_floor(model_settings, kwargs)


def _align_volcengine_thinking_output_budget(
    model_config: Any,
    model_settings: dict[str, Any],
    kwargs: dict[str, Any],
) -> None:
    """Cap legacy ``thinking.budget_tokens`` by output headroom; honor reasoning-effort depth."""
    if not _is_volcengine_like_host(model_config):
        return
    if _volc_uses_reasoning_effort_api(model_config):
        return
    probe = dict(model_settings)
    eb_kw = kwargs.get("extra_body")
    if isinstance(eb_kw, dict):
        peb = dict(probe.get("extra_body") or {})
        peb.update(eb_kw)
        probe["extra_body"] = peb
    if not _thinking_enabled_in_model_settings(probe):
        return

    max_out = _effective_max_output_tokens(model_config, model_settings)
    cap_raw = os.environ.get("EVOFLOW_VOLC_ASSUMED_OUTPUT_CAP", "").strip()
    if cap_raw:
        try:
            cap = int(cap_raw)
            if cap > 0:
                max_out = min(max_out, cap)
        except ValueError:
            pass

    reserve = _volc_completion_reserve_tokens(max_out)
    headroom = max_out - reserve
    if headroom < 4096:
        headroom = max(4096, max_out // 2)
    else:
        headroom = max(4096, headroom)

    configured = _volc_thinking_budget_from_probe(probe)
    target = _volc_target_thinking_budget(probe, model_settings, kwargs)
    if configured is not None and configured > 0:
        budget = min(configured, headroom)
    else:
        budget = min(max(target, 4096), headroom)
    if budget >= max_out:
        budget = max(4096, max_out // 2)
        reserve = max_out - budget
    if max_out <= budget:
        max_out = budget + max(reserve, _VOLC_COMPLETION_RESERVE_MIN)
        model_settings["max_tokens"] = max_out

    _merge_extra_body_thinking(
        kwargs,
        model_settings,
        {"type": "enabled", "budget_tokens": int(budget)},
    )
    if isinstance(kwargs.get("extra_body"), dict):
        model_settings["extra_body"] = dict(kwargs["extra_body"])
    effort = _normalize_reasoning_effort(
        kwargs.get("_evoflow_reasoning_effort")
        or kwargs.get("reasoning_effort")
        or model_settings.get("reasoning_effort")
    )
    logger.info(
        "Model %s: Volc thinking effort=%s budget_tokens=%s max_tokens=%s (completion reserve ~%s)",
        getattr(model_config, "name", "?"),
        effort or "?",
        int(budget),
        max_out,
        reserve,
    )


def _volc_uses_reasoning_effort_api(model_config: Any) -> bool:
    """Newer Volc Chat API (Seed 2.x / GLM 5.2): ``reasoning.effort`` + ``thinking.type``."""
    return bool(getattr(model_config, "supports_reasoning_effort", False))


def _volc_vendor_reasoning_effort(effort: str | None, model_config: Any) -> str | None:
    """Map EvoFlow effort labels to Volc Chat API values."""
    norm = _normalize_reasoning_effort(effort)
    if not norm:
        return None
    model_name = str(getattr(model_config, "model", "") or getattr(model_config, "name", "") or "").lower()
    if norm == "xhigh" and "glm" in model_name:
        return "max"
    return norm


def _sanitize_volcengine_modern_thinking_settings(
    model_config: Any,
    model_settings: dict[str, Any],
    kwargs: dict[str, Any],
) -> None:
    """Official Volc Chat API: ``thinking.type`` for on/off, ``reasoning.effort`` for depth.

    See https://www.volcengine.com/docs/82379/1449737
    """
    effort = (
        _volc_vendor_reasoning_effort(kwargs.get("_evoflow_reasoning_effort"), model_config)
        or _volc_vendor_reasoning_effort(kwargs.get("reasoning_effort"), model_config)
        or _volc_vendor_reasoning_effort(_model_default_reasoning_effort(model_config), model_config)
    )
    base = dict(kwargs.get("extra_body") or model_settings.get("extra_body") or {})
    thinking = dict(base.get("thinking") or {})
    t = str(thinking.get("type") or "").strip().lower()

    if effort in ("minimal", "none") or t in ("disabled", "off", "none"):
        base["thinking"] = {"type": "disabled"}
        base.pop("reasoning", None)
    elif t == "auto":
        base["thinking"] = {"type": "auto"}
        if effort:
            base["reasoning"] = {"effort": effort}
        else:
            base.pop("reasoning", None)
    else:
        base["thinking"] = {"type": "enabled"}
        if effort:
            base["reasoning"] = {"effort": effort}
        else:
            base.pop("reasoning", None)
    kwargs["extra_body"] = base
    kwargs.pop("reasoning_effort", None)
    model_settings.pop("reasoning_effort", None)


def _sanitize_dashscope_thinking_settings(
    model_config: Any,
    model_settings: dict[str, Any],
    kwargs: dict[str, Any],
) -> None:
    """DashScope: ``enable_thinking`` switch; depth via ``thinking_budget`` at HTTP time."""
    if not _is_dashscope_like_host(model_config):
        return
    base = dict(kwargs.get("extra_body") or model_settings.get("extra_body") or {})
    if "enable_thinking" not in base and base.get("thinking"):
        base.pop("thinking", None)
    kwargs["extra_body"] = base
    kwargs.pop("reasoning_effort", None)
    model_settings.pop("reasoning_effort", None)


def _sanitize_zhipu_thinking_settings(
    model_config: Any,
    model_settings: dict[str, Any],
    kwargs: dict[str, Any],
) -> None:
    """Zhipu: ``thinking.type`` + ``reasoning_effort`` (normalized at HTTP time)."""
    if not _is_zhipu_like_host(model_config):
        return
    effort = (
        _volc_vendor_reasoning_effort(kwargs.get("_evoflow_reasoning_effort"), model_config)
        or _volc_vendor_reasoning_effort(kwargs.get("reasoning_effort"), model_config)
        or _volc_vendor_reasoning_effort(_model_default_reasoning_effort(model_config), model_config)
    )
    base = dict(kwargs.get("extra_body") or model_settings.get("extra_body") or {})
    thinking = dict(base.get("thinking") or {})
    t = str(thinking.get("type") or "").strip().lower()
    if effort in ("minimal", "none") or t in ("disabled", "off", "none"):
        base["thinking"] = {"type": "disabled"}
    else:
        base["thinking"] = {"type": "enabled"}
    base.pop("reasoning", None)
    kwargs["extra_body"] = base
    kwargs.pop("reasoning_effort", None)
    model_settings.pop("reasoning_effort", None)


def _rewrite_thinking_auto_to_adaptive(container: dict[str, Any]) -> None:
    """Map invalid Anthropic ``thinking.type=auto`` → ``adaptive`` (session auto stays internal)."""
    if not isinstance(container, dict):
        return
    thinking = container.get("thinking")
    if isinstance(thinking, dict) and str(thinking.get("type") or "").strip().lower() == "auto":
        container["thinking"] = {**thinking, "type": "adaptive"}
    eb = container.get("extra_body")
    if isinstance(eb, dict) and isinstance(eb.get("thinking"), dict):
        nested = eb["thinking"]
        if str(nested.get("type") or "").strip().lower() == "auto":
            eb = dict(eb)
            eb["thinking"] = {**nested, "type": "adaptive"}
            container["extra_body"] = eb


def _sanitize_anthropic_style_thinking_settings(
    model_config: Any,
    model_settings: dict[str, Any],
    kwargs: dict[str, Any],
) -> None:
    """Claude / Anthropic-compatible hosts reject ``thinking.type=auto``.

    Keep Volcengine's ``auto`` (still valid there). Everyone else maps to ``adaptive``.
    """
    if _is_volcengine_like_host(model_config):
        return
    _rewrite_thinking_auto_to_adaptive(kwargs)
    _rewrite_thinking_auto_to_adaptive(model_settings)


def _sanitize_vendor_thinking_settings(
    model_config: Any,
    model_settings: dict[str, Any],
    kwargs: dict[str, Any],
) -> None:
    """Normalize vendor-specific thinking kwargs before ChatOpenAI construction."""
    _sanitize_volcengine_thinking_settings(model_config, model_settings, kwargs)
    _sanitize_dashscope_thinking_settings(model_config, model_settings, kwargs)
    _sanitize_zhipu_thinking_settings(model_config, model_settings, kwargs)
    _sanitize_anthropic_style_thinking_settings(model_config, model_settings, kwargs)


def _sanitize_volcengine_thinking_settings(
    model_config: Any,
    model_settings: dict[str, Any],
    kwargs: dict[str, Any],
) -> None:
    """Normalize Volc Ark thinking parameters for the target model generation."""
    if not _is_volcengine_like_host(model_config):
        return
    if _volc_uses_reasoning_effort_api(model_config):
        _sanitize_volcengine_modern_thinking_settings(model_config, model_settings, kwargs)
        return
    # Legacy Volc models: extra_body.thinking.budget_tokens (no top-level reasoning_effort).
    kwargs.pop("reasoning_effort", None)
    model_settings.pop("reasoning_effort", None)
    model_settings.pop("extra_body", None)
    base = dict(kwargs.get("extra_body") or model_settings.get("extra_body") or {})
    if "thinking" not in base:
        return
    thinking = dict(base.get("thinking") or {})
    t = str(thinking.get("type") or "").strip().lower()
    if t in ("disabled", "off", "none"):
        base["thinking"] = {"type": "disabled"}
    elif t in ("auto", "on", "enabled") or thinking:
        raw_budget = thinking.get("budget_tokens") or thinking.get("budgetTokens")
        if raw_budget is None:
            effort = (
                _normalize_reasoning_effort(kwargs.get("_evoflow_reasoning_effort"))
                or _normalize_reasoning_effort(kwargs.get("reasoning_effort"))
                or _model_default_reasoning_effort(model_config)
                or "medium"
            )
            budget = _VOLC_THINKING_BUDGET_BY_EFFORT.get(effort, _VOLC_THINKING_BUDGET_BY_EFFORT["medium"])
        else:
            try:
                budget = int(raw_budget)
            except (TypeError, ValueError):
                budget = _VOLC_THINKING_BUDGET_BY_EFFORT["medium"]
        base["thinking"] = {"type": "enabled", "budget_tokens": budget}
    kwargs["extra_body"] = base


def _finalize_thinking_max_tokens(
    model_config: Any,
    model_settings: dict[str, Any],
    kwargs: dict[str, Any],
) -> None:
    """Apply max_tokens vs thinking_budget fixup for all thinking-on paths (incl. thinking_type=auto)."""
    probe = dict(model_settings)
    eb_kw = kwargs.get("extra_body")
    if isinstance(eb_kw, dict):
        peb = dict(probe.get("extra_body") or {})
        peb.update(eb_kw)
        probe["extra_body"] = peb
    if "max_tokens" in kwargs:
        probe["max_tokens"] = kwargs["max_tokens"]
    if not _thinking_enabled_in_model_settings(probe):
        return
    before = probe.get("max_tokens")
    _normalize_dashscope_thinking_vs_max_completion(probe, model_config)
    after = probe.get("max_tokens")
    if after != before:
        model_settings["max_tokens"] = after
        kwargs.pop("max_tokens", None)


def _thinking_enabled_in_model_settings(model_settings: dict[str, Any]) -> bool:
    extra = model_settings.get("extra_body")
    if not isinstance(extra, dict):
        return False
    et = extra.get("enable_thinking")
    if et is True or str(et).lower() in ("true", "1", "yes"):
        return True
    th = extra.get("thinking")
    if isinstance(th, dict):
        t = str(th.get("type") or "").strip().lower()
        if t in ("auto", "enabled", "on"):
            return True
    return False


def _normalize_dashscope_thinking_vs_max_completion(model_settings: dict[str, Any], model_config) -> None:
    """DashScope / Volcengine Ark reject requests when ``max_completion_tokens`` <= ``thinking_budget`` (400 InvalidParameter).

    LangChain maps ``max_tokens`` → ``max_completion_tokens``. Some gateways default ``thinking_budget`` to 32768
    while leaving completion cap at ~32k — bump ``max_tokens`` or clamp ``thinking_budget`` here.
    """
    if not (_is_dashscope_like_host(model_config) or _is_volcengine_like_host(model_config)):
        return
    if not _thinking_enabled_in_model_settings(model_settings):
        return
    extra = model_settings.get("extra_body")
    if not isinstance(extra, dict):
        return

    def _as_int(v: Any) -> int | None:
        if v is None:
            return None
        try:
            return int(v)
        except (TypeError, ValueError):
            return None

    mt_int = _as_int(model_settings.get("max_tokens"))
    b_raw = extra.get("thinking_budget")
    if b_raw is None:
        b_raw = extra.get("thinkingBudget")
    th_obj = extra.get("thinking")
    if b_raw is None and isinstance(th_obj, dict):
        b_raw = th_obj.get("budget_tokens") or th_obj.get("budgetTokens")
    b_int = _as_int(b_raw)

    margin = 4096
    if b_int is not None and b_int > 0:
        if mt_int is None or mt_int <= b_int:
            new_mt = b_int + margin
            model_settings["max_tokens"] = new_mt
            logger.warning(
                "Model %s: max_tokens (%s) must exceed thinking_budget (%s); set max_tokens=%s",
                getattr(model_config, "name", "?"),
                mt_int,
                b_int,
                new_mt,
            )
        return

    # thinking on without explicit budget — provider may still allocate a large default thinking budget
    if mt_int is None or mt_int < 40000:
        new_mt = _OPENAI_COMPAT_MAX_OUTPUT_TOKENS if mt_int is None else max(mt_int, _OPENAI_COMPAT_MAX_OUTPUT_TOKENS)
        model_settings["max_tokens"] = new_mt
        logger.info(
            "Model %s: thinking enabled without explicit thinking_budget; set max_tokens=%s (was %s)",
            getattr(model_config, "name", "?"),
            new_mt,
            mt_int,
        )


def _default_resolved_model_name(config: AppConfig) -> str:
    """When callers omit ``name``, match ``_resolve_model_name`` semantics: ``primary_model`` then first listed model."""
    if not config.models:
        raise ValueError("No chat models are configured. Add at least one model in Settings → Models.")
    primary = (config.primary_model or "").strip()
    if primary and config.get_model_config(primary):
        return primary
    return config.models[0].name


def create_chat_model(
    name: str | None = None,
    thinking_enabled: bool = False,
    *,
    thinking_type: str | None = None,
    invocation_kind: str | None = None,
    **kwargs: Any,
) -> BaseChatModel:
    """Create a chat model instance from the config.

    This factory only **instantiates** the provider class (``use`` on the model row); it does not
    perform HTTP. Vendor HTTP is invoked inside the model implementation (e.g. LangChain ``ChatOpenAI``
    ``_generate`` / ``_stream``). Full vendor request + response persistence is wired in those providers
    via ``log_model_request_payload`` and ``VendorRoundtripChatMixin`` (see ``evoflow.models.vendor_roundtrip``).

    Args:
        name: The name of the model to create. If None or empty, uses ``primary_model`` from config when set
            and valid; otherwise the first model entry in the flattened ``models`` list.
        invocation_kind: Observability label: ``main``, ``title``, ``mission_state``, ``memory``, ``compress``, ``subagent``, ``hosted*``, etc.

    Returns:
        A chat model instance.
    """
    config = get_app_config()
    resolved = (name or "").strip()
    if not resolved:
        resolved = _default_resolved_model_name(config)
    model_config = config.get_model_config(resolved)
    if model_config is None:
        raise ValueError(f"Model {resolved!r} not found in config") from None
    if not hasattr(model_config, "model_dump") or not callable(getattr(model_config, "model_dump", None)):
        raise TypeError(
            f"Model {resolved!r} config must be a ModelConfig instance, "
            f"got {type(model_config).__name__}"
        ) from None
    resolved_use = _resolve_model_use_path(model_config)
    model_class = resolve_class(resolved_use, BaseChatModel)
    dumped = model_config.model_dump(
        exclude_none=True,
        exclude={
            "use",
            "name",
            "vendor",
            "display_name",
            "description",
            "supports_thinking",
            "supports_reasoning_effort",
            "when_thinking_enabled",
            "thinking",
            "supports_vision",
            "enable_web_search",
            "web_search_options",
            "credentials",
            "credential_strategy",
            "fallback_models",
            "context_length",
            "input_context_length",
            "output_context_length",
            "availability_status",
            "unavailable_reason",
            "unavailable_code",
            "unavailable_at",
            "plan_type",
            "plan_config",
            # Reserved Pydantic class-config key; may leak via extra="allow".
            "model_config",
        },
    )
    model_settings_from_config = _strip_provider_internal_keys(dumped)

    # ── Credential pool (multi-key rotation) ─────────────────────────
    pool = build_pool_from_config(model_config)
    if pool is not None:
        cred = pool.get()
        if cred is not None:
            # Override api_key + base_url with pool-managed credential
            model_settings_from_config.pop("api_key", None)
            kwargs["api_key"] = cred.api_key
            if cred.base_url:
                kwargs["base_url"] = cred.base_url
            # Attach pool ref for runtime callbacks
            kwargs["_credential_pool"] = pool
    # Compute effective when_thinking_enabled by merging in the `thinking` shortcut field.
    # The `thinking` shortcut is equivalent to setting when_thinking_enabled["thinking"].
    has_thinking_settings = (model_config.when_thinking_enabled is not None) or (model_config.thinking is not None)
    effective_wte = _effective_when_thinking_enabled(model_config)
    thinking_type_norm = str(thinking_type or kwargs.pop("thinking_type", "") or "").strip().lower()
    auto_thinking_applied = False
    if thinking_type_norm == "auto":
        # Session Auto: omit all thinking kwargs — let the vendor decide.
        auto_thinking_applied = _apply_vendor_auto_thinking(
            model_config, model_settings_from_config, kwargs, model_class
        )
    if thinking_enabled and has_thinking_settings and not auto_thinking_applied:
        if not model_config.supports_thinking:
            raise ValueError(f"Model {resolved} does not support thinking. Enable supports_thinking on the model in Settings → Models.") from None
        if effective_wte:
            model_settings_from_config.update(_strip_provider_internal_keys(effective_wte))
        _normalize_dashscope_thinking_vs_max_completion(model_settings_from_config, model_config)
    # Explicit off only when user/manual disabled — not for Auto (omit).
    if not thinking_enabled and thinking_type_norm != "auto":
        if effective_wte.get("extra_body", {}).get("thinking", {}).get("type"):
            # OpenAI-compatible gateway: thinking is nested under extra_body
            kwargs.update({"extra_body": {"thinking": {"type": "disabled"}}})
            kwargs.update({"reasoning_effort": "minimal"})
        elif isinstance(effective_wte.get("extra_body", {}).get("enable_thinking"), bool):
            # DashScope/Kimi style: explicit boolean switch under extra_body.enable_thinking
            kwargs.update({"extra_body": {"enable_thinking": False}})
            kwargs.update({"reasoning_effort": "minimal"})
        elif effective_wte.get("thinking", {}).get("type"):
            if _is_anthropic_native(model_class):
                # Native langchain_anthropic: thinking is a direct constructor parameter
                kwargs.update({"thinking": {"type": "disabled"}})
            else:
                # OpenAI-compatible gateways: nest under extra_body to avoid the
                # "thinking is not default parameter" warning and ensure it reaches the API.
                _merge_extra_body_thinking(kwargs, model_settings_from_config, {"type": "disabled"})
        elif _is_volcengine_like_host(model_config) or _is_dashscope_like_host(model_config):
            # Fallback: model has no explicit thinking config (e.g. supports_thinking=False
            # but the API host may still default to thinking-on). Force-disable to prevent
            # the API from using its default behavior.
            if _is_dashscope_like_host(model_config):
                kwargs.update({"extra_body": {"enable_thinking": False}})
            else:
                _merge_extra_body_thinking(kwargs, model_settings_from_config, {"type": "disabled"})
            kwargs.update({"reasoning_effort": "minimal"})
    if "reasoning_effort" in kwargs:
        normalized_effort = _normalize_reasoning_effort(kwargs.get("reasoning_effort"))
        if normalized_effort is None:
            kwargs.pop("reasoning_effort", None)
        else:
            kwargs["reasoning_effort"] = normalized_effort
    if not model_config.supports_reasoning_effort and "reasoning_effort" in kwargs:
        del kwargs["reasoning_effort"]

    resolved_effort = resolve_effective_reasoning_effort(
        kwargs.get("reasoning_effort"),
        model_config,
        thinking_enabled=bool(thinking_enabled),
    )
    if thinking_enabled:
        kwargs["_evoflow_reasoning_effort"] = resolved_effort
        if resolved_effort and model_config.supports_reasoning_effort:
            kwargs["reasoning_effort"] = resolved_effort
    else:
        kwargs["_evoflow_reasoning_effort"] = _normalize_reasoning_effort(kwargs.get("reasoning_effort"))
    evoflow_thinking_enabled = bool(thinking_enabled)
    evoflow_reasoning_effort = kwargs.get("_evoflow_reasoning_effort")
    evoflow_thinking_type = thinking_type_norm or None
    evoflow_session_mode = None
    try:
        from langgraph.config import get_config

        cfg = get_config()
        c = cfg.get("configurable") if isinstance(cfg, dict) else {}
        if isinstance(c, dict):
            evoflow_session_mode = str(c.get("session_mode") or "").strip() or None
    except Exception:
        pass

    # For runtime Responses API models: map thinking mode to reasoning_effort
    from evoflow.models.openai_codex_provider import runtimeChatModel

    if issubclass(model_class, runtimeChatModel):
        # The ChatGPT runtime endpoint currently rejects max_tokens/max_output_tokens.
        model_settings_from_config.pop("max_tokens", None)

        # Use explicit reasoning_effort from frontend if provided (low/medium/high)
        explicit_effort = _normalize_reasoning_effort(kwargs.pop("reasoning_effort", None))
        if not thinking_enabled:
            model_settings_from_config["reasoning_effort"] = "none"
        elif explicit_effort and explicit_effort in _VALID_REASONING_EFFORTS:
            model_settings_from_config["reasoning_effort"] = explicit_effort
        elif "reasoning_effort" not in model_settings_from_config:
            model_settings_from_config["reasoning_effort"] = "medium"

    _ensure_stream_usage_for_openai_compat(model_class, model_config, model_settings_from_config)

    _sanitize_vendor_thinking_settings(model_config, model_settings_from_config, kwargs)
    if not issubclass(model_class, runtimeChatModel):
        from evoflow.config.model_config import resolve_model_max_output_tokens

        raw_mt = model_settings_from_config.get("max_tokens")
        try:
            mt = int(raw_mt) if raw_mt is not None else None
        except (TypeError, ValueError):
            mt = None
        model_settings_from_config["max_tokens"] = resolve_model_max_output_tokens(mt)
        ocl = getattr(model_config, "output_context_length", None)
        if ocl is not None:
            try:
                ocl_int = int(ocl)
                if ocl_int > int(model_settings_from_config["max_tokens"]):
                    model_settings_from_config["max_tokens"] = ocl_int
            except (TypeError, ValueError):
                pass
    _finalize_thinking_max_tokens(model_config, model_settings_from_config, kwargs)
    _align_volcengine_thinking_output_budget(model_config, model_settings_from_config, kwargs)
    _normalize_dashscope_thinking_vs_max_completion(model_settings_from_config, model_config)
    _apply_native_web_search(model_config, model_settings_from_config, kwargs)

    kwargs.pop("_evoflow_reasoning_effort", None)
    merged_kwargs = {**_strip_provider_internal_keys(kwargs), **model_settings_from_config}
    _nest_openai_compat_thinking_kwargs(model_class, merged_kwargs)
    _sanitize_openai_compat_reasoning_effort(model_class, model_config, merged_kwargs)
    _clamp_openai_compat_max_tokens(model_class, model_config, merged_kwargs)
    sanitize_model_connection_settings(merged_kwargs)
    stress_vendor_base = os.environ.get("EVOFLOW_STRESS_VENDOR_BASE_URL", "").strip()
    if stress_vendor_base and issubclass(model_class, ChatOpenAI):
        merged_kwargs["base_url"] = stress_vendor_base.rstrip("/")
        if not merged_kwargs.get("api_key"):
            merged_kwargs["api_key"] = "stress-mock"
        logger.info(
            "EVOFLOW_STRESS_VENDOR_BASE_URL redirecting model %r to %s",
            resolved,
            merged_kwargs["base_url"],
        )
    if _is_anthropic_native(model_class) and merged_kwargs.get("base_url"):
        # Official SDK base is https://api.anthropic.com; trailing /v1 → …/v1/v1/messages.
        from evoflow.models.anthropic_url import normalize_anthropic_sdk_base_url

        merged_kwargs["base_url"] = normalize_anthropic_sdk_base_url(str(merged_kwargs.get("base_url") or ""))
    if not merged_kwargs.get("api_key") and issubclass(model_class, ChatOpenAI):
        env_key = resolve_and_sanitize_api_key(os.environ.get("OPENAI_API_KEY"))
        if env_key:
            merged_kwargs["api_key"] = env_key
        elif _is_local_noauth_endpoint(
            getattr(model_config, "base_url", None) or merged_kwargs.get("base_url"),
            getattr(model_config, "vendor", None),
        ):
            # ChatOpenAI requires a non-empty api_key; Ollama / local OpenAI-compat ignore it.
            merged_kwargs["api_key"] = "ollama"
    model_instance = model_class(**merged_kwargs)
    patch_chat_model_instance_credentials(model_instance)
    if pool is not None:
        try:
            setattr(model_instance, "_credential_pool", pool)
        except Exception:
            pass
    fb_models = list(getattr(model_config, "fallback_models", None) or [])
    if fb_models:
        try:
            setattr(model_instance, "_evoflow_fallback_models", fb_models)
            setattr(model_instance, "_evoflow_primary_model_name", resolved)
        except Exception:
            pass
    ik = (invocation_kind or "main").strip() or "main"
    try:
        vendor = (
            str(getattr(model_config, "vendor", "") or "").strip()
            or infer_vendor_from_connection(getattr(model_config, "base_url", None), resolved)
        )
        setattr(model_instance, "_evoflow_vendor", vendor)
        setattr(model_instance, "_evoflow_invocation_kind", ik)
        setattr(model_instance, "_evoflow_thinking_enabled", evoflow_thinking_enabled)
        setattr(model_instance, "_evoflow_reasoning_effort", evoflow_reasoning_effort)
        setattr(model_instance, "_evoflow_thinking_type", evoflow_thinking_type)
        if evoflow_session_mode:
            setattr(model_instance, "_evoflow_session_mode", evoflow_session_mode)
    except Exception:
        pass

    if is_tracing_enabled():
        try:
            from langchain_core.tracers.langchain import LangChainTracer

            tracing_config = get_tracing_config()
            tracer = LangChainTracer(
                project_name=tracing_config.project,
            )
            existing_callbacks = model_instance.callbacks or []
            model_instance.callbacks = [*existing_callbacks, tracer]
            logger.debug(f"LangSmith tracing attached to model '{resolved}' (project='{tracing_config.project}')")
        except Exception as e:
            logger.warning(f"Failed to attach LangSmith tracing to model '{resolved}': {e}")

    # ── Instrument main model to log wall-clock time before vendor HTTP call ──
    if ik == "main":
        _instrument_vendor_call_timing(model_instance)

    return model_instance


def _instrument_vendor_call_timing(model: BaseChatModel) -> None:
    """Wrap implementation methods to print elapsed time before the first vendor HTTP call."""
    from evoflow.observability.run_latency_trace import read_configurable_trace_fields

    _logged: list[bool] = [False]

    def _log_before_vendor() -> None:
        if _logged[0]:
            return
        _logged[0] = True
        try:
            _, _, user_ts = read_configurable_trace_fields()
            if user_ts:
                elapsed_s = max(0.0, time.time() * 1000.0 - float(user_ts)) / 1000.0
                print(f"[AGENT-TIMING] → vendor_http_call 请求到模型调用={elapsed_s:.3f}秒", flush=True)
                if elapsed_s >= 60.0:
                    logger.warning(
                        "slow_provider_alert: TTFT/wall before vendor HTTP >= 60s (%.1fs)",
                        elapsed_s,
                    )
        except Exception:
            pass

    def _setattr(name: str, wrapped) -> None:
        object.__setattr__(model, name, wrapped.__get__(model, type(model)))

    # Sync methods
    if hasattr(model, "stream") and callable(model.stream):
        orig = model.stream
        def timed(self, messages, stop=None, *, run_manager=None, **kwargs):
            _log_before_vendor()
            return orig(messages, stop=stop, run_manager=run_manager, **kwargs)
        _setattr("stream", timed)

    if hasattr(model, "_generate") and callable(model._generate):
        orig = model._generate
        def timed(self, messages, stop=None, *, run_manager=None, **kwargs):
            _log_before_vendor()
            return orig(messages, stop=stop, run_manager=run_manager, **kwargs)
        _setattr("_generate", timed)

    # Async methods — LangGraph / streaming uses these.
    if hasattr(model, "astream") and callable(model.astream):
        orig = model.astream
        async def timed(self, messages, stop=None, *, run_manager=None, **kwargs):
            _log_before_vendor()
            return await orig(messages, stop=stop, run_manager=run_manager, **kwargs)
        _setattr("astream", timed)

    if hasattr(model, "_agenerate") and callable(model._agenerate):
        orig = model._agenerate
        async def timed(self, messages, stop=None, *, run_manager=None, **kwargs):
            _log_before_vendor()
            return await orig(messages, stop=stop, run_manager=run_manager, **kwargs)
        _setattr("_agenerate", timed)
