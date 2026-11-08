"""Aliyun Bailian Token Plan chat / media catalog.

Official OpenAI-compat Base URL is ``token-plan…/compatible-mode/v1``
(not DashScope payg ``compatible-mode/v1``). Media / speech use
``token-plan…/api/v1``.

Source: https://help.aliyun.com/zh/model-studio/token-plan-personal-overview
"""

from __future__ import annotations

import logging
import re
from typing import Any
from urllib.parse import urlparse

logger = logging.getLogger(__name__)

PLAN_CHAT_BASE = "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1"
PLAN_MEDIA_BASE = "https://token-plan.cn-beijing.maas.aliyuncs.com/api/v1"
PLAN_ANTHROPIC_BASE = "https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic"
PAYG_CHAT_BASE = "https://dashscope.aliyuncs.com/compatible-mode/v1"
VENDOR_KEY = "aliyun"
CATALOG_ID = "aliyun.token_plan"
PREFERRED_PRIMARY_IDS = (
    "auto",
    "qwen3.8-flash",
    "qwen3.8-max",
    "deepseek-v4.1-flash",
    "qwen3.7-plus",
)

_TIER_RANK = {"lite": 0, "essential": 1, "standard": 2, "pro": 3}
_DATED_ID = re.compile(r"-\d{6}$")
_SKIP_SUBSTR = (
    "embedding",
    "image",
    "video",
    "tts",
    "asr",
    "audio",
    "wan2.",
    "wan3.",
    "happyhorse",
    "realtime",
)

# Official 套餐概览 chat IDs（个人版，对齐 2026-11 文档）
TOKEN_PLAN_CHAT_MODELS: list[dict[str, Any]] = [
    {
        "id": "auto",
        "label": "Auto",
        "context_window": 256000,
        "max_output": 65536,
        "vision": False,
        "reasoning": True,
        "min_tier": "lite",
        "preferred_primary": True,
        "notes": "智能路由，按请求匹配底层模型",
    },
    {
        "id": "qwen3.8-max",
        "label": "Qwen 3.8 Max",
        "context_window": 256000,
        "max_output": 65536,
        "vision": True,
        "reasoning": True,
        "min_tier": "lite",
        "notes": "夜间 4 折（22:00–08:00）",
    },
    {
        "id": "qwen3.8-flash",
        "label": "Qwen 3.8 Flash",
        "context_window": 256000,
        "max_output": 65536,
        "vision": True,
        "reasoning": True,
        "min_tier": "lite",
        "notes": "夜间 4 折（22:00–08:00）",
    },
    {
        "id": "qwen3.7-plus",
        "label": "Qwen 3.7 Plus",
        "context_window": 256000,
        "max_output": 65536,
        "vision": True,
        "reasoning": True,
        "min_tier": "lite",
    },
    {
        "id": "qwen3.7-max",
        "label": "Qwen 3.7 Max",
        "context_window": 256000,
        "max_output": 65536,
        "vision": False,
        "reasoning": True,
        "min_tier": "lite",
    },
    {
        "id": "qwen3.6-flash",
        "label": "Qwen 3.6 Flash",
        "context_window": 256000,
        "max_output": 65536,
        "vision": True,
        "reasoning": True,
        "min_tier": "lite",
    },
    {
        "id": "deepseek-v4.1-flash",
        "label": "DeepSeek V4.1 Flash",
        "context_window": 256000,
        "max_output": 65536,
        "vision": True,
        "reasoning": True,
        "min_tier": "lite",
        "notes": "夜间 5 折（22:00–08:00）",
    },
    {
        "id": "deepseek-v4.1-flash-1017",
        "label": "DeepSeek V4.1 Flash 1017",
        "context_window": 256000,
        "max_output": 65536,
        "vision": True,
        "reasoning": True,
        "min_tier": "lite",
        "notes": "夜间 5 折（22:00–08:00）",
    },
    {
        "id": "deepseek-v4-pro",
        "label": "DeepSeek V4 Pro",
        "context_window": 256000,
        "max_output": 65536,
        "vision": False,
        "reasoning": True,
        "min_tier": "lite",
    },
    {
        "id": "deepseek-v4-pro-0813",
        "label": "DeepSeek V4 Pro 0813",
        "context_window": 256000,
        "max_output": 65536,
        "vision": False,
        "reasoning": True,
        "min_tier": "lite",
        "notes": "夜间 5 折（22:00–08:00）",
    },
    {
        "id": "deepseek-v4-flash-0731",
        "label": "DeepSeek V4 Flash 0731",
        "context_window": 256000,
        "max_output": 65536,
        "vision": False,
        "reasoning": True,
        "min_tier": "lite",
        "notes": "夜间 5 折（22:00–08:00）",
    },
    {
        "id": "glm-5.3",
        "label": "GLM 5.3",
        "context_window": 256000,
        "max_output": 65536,
        "vision": False,
        "reasoning": True,
        "min_tier": "lite",
    },
    {
        "id": "glm-5.2",
        "label": "GLM 5.2",
        "context_window": 256000,
        "max_output": 65536,
        "vision": False,
        "reasoning": True,
        "min_tier": "lite",
    },
]

TOKEN_PLAN_CAPABILITIES: list[dict[str, Any]] = [
    {
        "id": "chat",
        "label": "对话模型",
        "summary": "写入「对话模型」页阿里云连接；智能调度 id 为 auto。",
        "item_source": "chat_models",
        "min_tier": "lite",
    },
    {
        "id": "tts",
        "label": "语音合成",
        "summary": "套餐 Key 写入通义语音；模型 qwen-audio-3.0-tts-plus。",
        "min_tier": "lite",
        "items": [
            {
                "id": "qwen-audio-3.0-tts-plus",
                "label": "Qwen Audio TTS Plus",
                "min_tier": "lite",
            },
        ],
    },
    {
        "id": "asr",
        "label": "语音识别",
        "summary": "套餐 Key 写入通义 ASR；模型 qwen-audio-3.0-asr-flash。",
        "min_tier": "lite",
        "items": [
            {
                "id": "qwen-audio-3.0-asr-flash",
                "label": "Qwen Audio ASR Flash",
                "min_tier": "lite",
            },
        ],
    },
    {
        "id": "image",
        "label": "生图",
        "summary": "万相 / 千问生图，走 Token Plan /api/v1 媒体口。",
        "min_tier": "lite",
        "items": [
            {"id": "wan2.7-image-pro", "label": "万相 2.7 Image Pro", "min_tier": "lite"},
            {"id": "wan2.7-image", "label": "万相 2.7 Image", "min_tier": "lite"},
            {"id": "qwen-image-3.0-pro", "label": "Qwen Image 3.0 Pro", "min_tier": "lite"},
        ],
    },
    {
        "id": "video",
        "label": "生视频",
        "summary": "万相 / HappyHorse 视频，走 Token Plan 视频口；Credits 消耗较高。",
        "min_tier": "lite",
        "items": [
            {"id": "wan3.0-video", "label": "万相 3.0 Video", "min_tier": "lite"},
            {"id": "happyhorse-1.1-t2v", "label": "HappyHorse 1.1 T2V", "min_tier": "lite"},
            {"id": "happyhorse-1.1-i2v", "label": "HappyHorse 1.1 I2V", "min_tier": "lite"},
            {"id": "happyhorse-1.1-r2v", "label": "HappyHorse 1.1 R2V", "min_tier": "lite"},
        ],
    },
    {
        "id": "web_search",
        "label": "联网搜索",
        "summary": (
            "模型内置工具 web_search（Responses API 自动触发，按 Credits 抵扣）；"
            "无需单独配置豆包/博查 Key。"
        ),
        "min_tier": "lite",
        "items": [
            {
                "id": "web_search",
                "label": "联网搜索",
                "min_tier": "lite",
                "notes": "另有 web_extractor / code_interpreter / 文搜图 / 以图搜图",
            },
        ],
    },
]


def media_capability_items(capability: str) -> list[dict[str, Any]]:
    cap = next((c for c in TOKEN_PLAN_CAPABILITIES if c.get("id") == capability), None)
    return list((cap or {}).get("items") or [])


def default_media_models_for_tier(tier_id: str | None) -> dict[str, str | None]:
    rank = _TIER_RANK.get(str(tier_id or "").strip().lower(), _TIER_RANK["pro"])
    out: dict[str, str | None] = {"image": None, "video": None}
    for cap_id in ("image", "video"):
        best: tuple[int, int, str] | None = None
        for idx, row in enumerate(media_capability_items(cap_id)):
            min_rank = _TIER_RANK.get(str(row.get("min_tier") or "lite").lower(), 0)
            if rank < min_rank:
                continue
            mid = str(row.get("id") or "").strip()
            if not mid:
                continue
            cand = (min_rank, idx, mid)
            if best is None or cand[0] > best[0] or (cand[0] == best[0] and cand[1] < best[1]):
                best = cand
        if best:
            out[cap_id] = best[2]
    if not out["image"]:
        out["image"] = "wan2.7-image-pro"
    if not out["video"]:
        out["video"] = "wan3.0-video"
    return out


def is_token_plan_openai_base(base_url: str) -> bool:
    raw = str(base_url or "").strip().rstrip("/").lower()
    if "token-plan" not in raw:
        return False
    host = (urlparse(raw).hostname or "").lower()
    return "maas.aliyuncs.com" in host or "qianwenaiapi.com" in host or "qwencloudapi.com" in host


def openai_compat_fallback_models(base_url: str, *, tier_id: str | None = None) -> list[dict[str, str]] | None:
    if not is_token_plan_openai_base(base_url):
        return None
    return [{"id": str(m["id"])} for m in chat_models_for_tier(tier_id)]


def chat_models_for_tier(tier_id: str | None) -> list[dict[str, Any]]:
    rank = _TIER_RANK.get(str(tier_id or "").strip().lower(), _TIER_RANK["pro"])
    out: list[dict[str, Any]] = []
    for row in TOKEN_PLAN_CHAT_MODELS:
        min_rank = _TIER_RANK.get(str(row.get("min_tier") or "lite").lower(), 0)
        if rank >= min_rank:
            out.append(dict(row))
    return out


def is_chat_model_id(model_id: str) -> bool:
    s = str(model_id or "").strip()
    if not s:
        return False
    low = s.lower()
    if any(token in low for token in _SKIP_SUBSTR):
        return False
    if _DATED_ID.search(low):
        return False
    return True


def fetch_remote_model_ids(
    api_key: str,
    *,
    base_url: str = PLAN_CHAT_BASE,
    timeout: float = 12.0,
) -> list[str] | None:
    key = str(api_key or "").strip()
    base = str(base_url or PLAN_CHAT_BASE).strip().rstrip("/")
    if not key or key.startswith("*") or not base:
        return None
    try:
        import httpx
    except ImportError:  # pragma: no cover
        return None
    url = f"{base}/models"
    headers = {"accept": "application/json", "authorization": f"Bearer {key}"}
    try:
        with httpx.Client(timeout=timeout) as client:
            resp = client.get(url, headers=headers)
    except Exception as exc:
        logger.info("Token Plan GET /models failed: %s", exc)
        return None
    if resp.status_code != 200:
        logger.info("Token Plan GET /models HTTP %s", resp.status_code)
        return None
    try:
        payload = resp.json()
    except Exception:
        return None
    rows = payload.get("data")
    if rows is None:
        rows = payload.get("models")
    if not isinstance(rows, list):
        return None
    ids: list[str] = []
    seen: set[str] = set()
    for item in rows:
        if isinstance(item, str):
            mid = item.strip()
        elif isinstance(item, dict):
            raw = item.get("id") or item.get("name") or item.get("model")
            mid = str(raw).strip() if raw is not None else ""
        else:
            continue
        if not is_chat_model_id(mid) or mid in seen:
            continue
        seen.add(mid)
        ids.append(mid)
    return ids or None


def resolve_chat_models(
    api_key: str,
    *,
    tier_id: str | None,
    base_url: str = PLAN_CHAT_BASE,
) -> tuple[list[dict[str, Any]], str]:
    catalog = chat_models_for_tier(tier_id)
    by_id = {str(m["id"]): m for m in catalog}
    remote_ids = fetch_remote_model_ids(api_key, base_url=base_url)
    if not remote_ids:
        return catalog, "catalog"
    merged: list[dict[str, Any]] = []
    seen: set[str] = set()
    for mid in remote_ids:
        if not is_chat_model_id(mid) or mid in seen:
            continue
        seen.add(mid)
        meta = by_id.get(mid)
        if meta:
            merged.append(dict(meta))
        else:
            merged.append(
                {
                    "id": mid,
                    "label": mid,
                    "context_window": 256000,
                    "max_output": 65536,
                    "vision": False,
                    "reasoning": True,
                    "min_tier": "lite",
                }
            )
    # Keep preferred catalog rows even if remote list is incomplete
    for row in catalog:
        mid = str(row.get("id") or "")
        if mid and mid not in seen:
            merged.append(dict(row))
            seen.add(mid)
    return merged, "remote"


def _resolve_config_name(model_id: str, existing: list[dict[str, Any]]) -> str:
    for row in existing:
        if str(row.get("vendor") or "") == VENDOR_KEY and str(row.get("model") or "") == model_id:
            return str(row.get("name") or model_id)
    names = {str(r.get("name") or "") for r in existing}
    if model_id not in names:
        return model_id
    candidate = f"{VENDOR_KEY}-{model_id}"
    if candidate not in names:
        return candidate
    i = 2
    while f"{candidate}-{i}" in names:
        i += 1
    return f"{candidate}-{i}"


def _plan_model_config(
    *,
    spec: dict[str, Any],
    tier_id: str | None,
    capability: str,
    binding_id: str | None = None,
) -> dict[str, Any]:
    model_id = str(spec.get("id") or "").strip()
    cfg: dict[str, Any] = {
        "catalog_id": CATALOG_ID,
        "tier_id": tier_id,
        "min_tier": str(spec.get("min_tier") or "lite"),
        "capability": capability,
        "model_id": model_id,
    }
    if binding_id:
        cfg["binding_id"] = binding_id
    return cfg


def _model_document(
    *,
    name: str,
    spec: dict[str, Any],
    api_key: str,
    base_url: str,
    tier_id: str | None = None,
    binding_id: str | None = None,
) -> dict[str, Any]:
    model_id = str(spec["id"])
    reasoning = bool(spec.get("reasoning", True))
    vision = bool(spec.get("vision"))
    context = int(spec.get("context_window") or 256000)
    max_out = int(spec.get("max_output") or 65536)
    notes = str(spec.get("notes") or "").strip()
    desc = "百炼 Token Plan"
    if notes:
        desc = f"{desc} · {notes}"
    doc: dict[str, Any] = {
        "name": name,
        "vendor": VENDOR_KEY,
        "model": model_id,
        "display_name": str(spec.get("label") or model_id),
        "description": desc,
        "use": "langchain_openai:ChatOpenAI",
        "base_url": base_url,
        "api_key": api_key,
        "supports_thinking": reasoning,
        "supports_reasoning_effort": reasoning,
        "supports_vision": vision,
        "context_length": context,
        "input_context_length": context,
        "output_context_length": max_out,
        "max_tokens": max_out,
        "request_timeout": 600,
        "max_retries": 2,
    }
    if reasoning:
        doc["when_thinking_enabled"] = {"extra_body": {"enable_thinking": True}}
        doc["thinking"] = {
            "supported_levels": ["low", "medium", "high"],
            "default_level": "medium",
            "default_mode": "auto",
        }
    doc["plan_type"] = "aliyun_token"
    doc["plan_config"] = _plan_model_config(
        spec=spec,
        tier_id=tier_id,
        capability="chat",
        binding_id=binding_id,
    )
    return doc


def upsert_token_plan_chat_models(
    *,
    api_key: str,
    base_url: str,
    tier_id: str | None,
    binding_id: str | None = None,
    set_primary_if_missing: bool = True,
) -> dict[str, Any]:
    """Write Token Plan chat models into ``evoflow_models``. Idempotent."""
    from evoflow.persistence import config_repositories as cfg_repo

    models, source = resolve_chat_models(api_key, tier_id=tier_id, base_url=base_url)
    existing = list(cfg_repo.list_models() or [])
    names: list[str] = []
    preferred: str | None = None

    for spec in models:
        model_id = str(spec.get("id") or "").strip()
        if not model_id:
            continue
        name = _resolve_config_name(model_id, existing)
        doc = _model_document(
            name=name,
            spec=spec,
            api_key=api_key,
            base_url=base_url,
            tier_id=tier_id,
            binding_id=binding_id,
        )
        cfg_repo.upsert_model(doc)
        existing = [r for r in existing if str(r.get("name") or "") != name]
        existing.append({"name": name, "vendor": VENDOR_KEY, "model": model_id})
        names.append(name)
        if preferred is None and spec.get("preferred_primary"):
            preferred = name

    if set_primary_if_missing and names:
        current = str(cfg_repo.get_app_setting("primary_model") or "").strip()
        if not current:
            pick = preferred
            if not pick:
                by_id = {str(spec.get("id")): name for spec, name in zip(models, names)}
                for mid in PREFERRED_PRIMARY_IDS:
                    if mid in by_id:
                        pick = by_id[mid]
                        break
            cfg_repo.set_app_setting("primary_model", pick or names[0])

    return {"count": len(names), "source": source, "names": names}
