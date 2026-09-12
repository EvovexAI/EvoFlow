"""Volcengine Ark Agent Plan chat models.

Official chat Base URL is ``/api/plan/v3`` (not payg ``/api/v3``).
``GET {base}/models`` is often missing; fall back to the 套餐概览 catalog.

Source: https://www.volcengine.com/docs/82379/2366394
"""

from __future__ import annotations

import logging
import re
from typing import Any
from urllib.parse import urlparse

logger = logging.getLogger(__name__)

PLAN_CHAT_BASE = "https://ark.cn-beijing.volces.com/api/plan/v3"
PLAN_MEDIA_BASE = "https://ark.cn-beijing.volces.com/api/plan/v3"
PLAN_CODING_BASE = "https://ark.cn-beijing.volces.com/api/coding/v3"
PAYG_CHAT_BASE = "https://ark.cn-beijing.volces.com/api/v3"
VENDOR_KEY = "volcengine"
PREFERRED_PRIMARY_IDS = ("ark-code-latest", "doubao-seed-2.0-lite", "glm-5.3", "deepseek-v4-flash")

_TIER_RANK = {"small": 0, "medium": 1, "large": 2, "max": 3}
_DATED_ID = re.compile(r"-\d{6}$")
_SKIP_SUBSTR = ("embedding", "seedream", "seedance", "tts", "asr", "voice")

# Official 套餐概览 chat IDs + commonly listed Agent Plan aliases.
AGENT_PLAN_CHAT_MODELS: list[dict[str, Any]] = [
    {
        # Official Auto / latest alias for Agent & Coding Plan clients (not the literal id "auto").
        "id": "ark-code-latest",
        "label": "Auto（ark-code-latest）",
        "context_window": 256000,
        "max_output": 128000,
        "vision": False,
        "reasoning": True,
        "min_tier": "small",
        "preferred_primary": True,
        "notes": "控制台切换目标模型；配置文件写 ark-code-latest",
    },
    {
        "id": "doubao-seed-2.0-mini",
        "label": "Doubao Seed 2.0 Mini",
        "context_window": 256000,
        "max_output": 128000,
        "vision": True,
        "reasoning": True,
        "min_tier": "small",
    },
    {
        "id": "doubao-seed-2.0-lite",
        "label": "Doubao Seed 2.0 Lite",
        "context_window": 256000,
        "max_output": 128000,
        "vision": True,
        "reasoning": True,
        "min_tier": "small",
    },
    {
        "id": "doubao-seed-2.1-turbo",
        "label": "Doubao Seed 2.1 Turbo",
        "context_window": 256000,
        "max_output": 64000,
        "vision": True,
        "reasoning": True,
        "min_tier": "small",
    },
    {
        "id": "deepseek-v4-flash",
        "label": "DeepSeek V4 Flash",
        "context_window": 1024000,
        "max_output": 384000,
        "vision": False,
        "reasoning": True,
        "min_tier": "small",
    },
    {
        "id": "doubao-seed-evolving",
        "label": "Doubao Seed Evolving",
        "context_window": 1024000,
        "max_output": 256000,
        "vision": True,
        "reasoning": True,
        "min_tier": "small",
    },
    {
        "id": "doubao-seed-2.0-code",
        "label": "Doubao Seed 2.0 Code",
        "context_window": 256000,
        "max_output": 128000,
        "vision": True,
        "reasoning": True,
        "min_tier": "small",
    },
    {
        "id": "doubao-seed-2.0-pro",
        "label": "Doubao Seed 2.0 Pro",
        "context_window": 256000,
        "max_output": 128000,
        "vision": True,
        "reasoning": True,
        "min_tier": "small",
    },
    {
        "id": "minimax-m2.7",
        "label": "MiniMax M2.7",
        "context_window": 200000,
        "max_output": 128000,
        "vision": False,
        "reasoning": True,
        "min_tier": "small",
        "notes": "即将下线",
    },
    {
        "id": "minimax-m3",
        "label": "MiniMax M3",
        "context_window": 1024000,
        "max_output": 128000,
        "vision": True,
        "reasoning": True,
        "min_tier": "small",
    },
    {
        "id": "glm-5.2",
        "label": "GLM 5.2",
        "context_window": 1024000,
        "max_output": 128000,
        "vision": False,
        "reasoning": True,
        "min_tier": "small",
        "notes": "即将下线",
    },
    {
        "id": "glm-5.3",
        "label": "GLM 5.3",
        "context_window": 1024000,
        "max_output": 128000,
        "vision": False,
        "reasoning": True,
        "min_tier": "small",
        "thinking_always_on": True,
        "notes": "glm-latest；默认开启思考，不支持关闭",
    },
    {
        "id": "deepseek-v4-pro",
        "label": "DeepSeek V4 Pro",
        "context_window": 1024000,
        "max_output": 384000,
        "vision": False,
        "reasoning": True,
        "min_tier": "small",
        "notes": "尝鲜体验版",
    },
    {
        "id": "kimi-k2.6",
        "label": "Kimi K2.6",
        "context_window": 256000,
        "max_output": 32000,
        "vision": True,
        "reasoning": True,
        "min_tier": "small",
        "notes": "即将下线",
    },
    {
        "id": "kimi-k2.7-code",
        "label": "Kimi K2.7 Code",
        "context_window": 256000,
        "max_output": 32000,
        "vision": True,
        "reasoning": True,
        "min_tier": "small",
    },
    {
        "id": "kimi-k3",
        "label": "Kimi K3",
        "context_window": 1024000,
        "max_output": 128000,
        "vision": True,
        "reasoning": True,
        "min_tier": "medium",
    },
]

# 能力清单（套餐 Tab 表格用）。视频档位对齐官方套餐概览模型表，不是笼统「有/无」。
# Small 不含任何视频；Medium 仅 Seedance 1.5 Pro；2.0 / 2.0-fast 需 Large+。
AGENT_PLAN_CAPABILITIES: list[dict[str, Any]] = [
    {
        "id": "chat",
        "label": "对话模型",
        "summary": "写入「对话模型」页火山连接；智能调度 id 为 ark-code-latest。",
        "item_source": "chat_models",
        "min_tier": "small",
    },
    {
        "id": "embedding",
        "label": "向量",
        "summary": "写入「向量模型」页；知识库 / 记忆可直接选用。绑定时勾选「优先本地」仅影响默认路由，列表仍会显示套餐向量。",
        "min_tier": "small",
        "items": [
            {
                "id": "doubao-embedding-vision",
                "label": "Doubao Embedding Vision",
                "min_tier": "small",
                "notes": "Agent Plan 官方向量模型；走 /embeddings/multimodal。纯文本 doubao-embedding 不支持 Agent Plan。",
            },
        ],
    },
    {
        "id": "tts",
        "label": "语音合成",
        "summary": "朗读走 Agent Plan 语音抵扣（同源 ark- Key）。",
        "min_tier": "small",
        "items": [
            {"id": "doubao-tts", "label": "Doubao TTS", "min_tier": "small", "notes": "OpenSpeech Plan 音色预设"},
        ],
    },
    {
        "id": "asr",
        "label": "语音识别",
        "summary": "语音输入走 Agent Plan ASR 抵扣。",
        "min_tier": "small",
        "items": [
            {
                "id": "volc.seedasr.sauc.duration",
                "label": "Seed ASR",
                "min_tier": "small",
                "notes": "默认资源 ID",
            },
        ],
    },
    {
        "id": "image",
        "label": "生图",
        "summary": "Seedream 系列，走 /api/plan/v3 媒体口。",
        "min_tier": "small",
        "items": [
            {"id": "doubao-seedream-5.0-lite", "label": "Seedream 5.0 Lite", "min_tier": "small"},
        ],
    },
    {
        "id": "video",
        "label": "生视频",
        "summary": (
            "官方套餐概览：Small 不含视频生成（轻量化体验）。"
            "Medium 仅 doubao-seedance-1.5-pro；"
            "doubao-seedance-2.0 / 2.0-fast 需 Large 或 Max。"
        ),
        "excluded_hint": {
            "small": "官方 Small 档不含视频生成。升级 Medium 可用 Seedance 1.5 Pro；2.0 系列需 Large / Max。",
            "medium": "当前 Medium 仅含即将下线的 Seedance 1.5 Pro；Seedance 2.0 / 2.0-fast 需升级 Large 或 Max。",
        },
        "min_tier": "medium",
        "items": [
            {
                "id": "doubao-seedance-1.5-pro",
                "label": "Seedance 1.5 Pro",
                "min_tier": "medium",
                "notes": "即将下线",
            },
            {
                "id": "doubao-seedance-2.0",
                "label": "Seedance 2.0",
                "min_tier": "large",
            },
            {
                "id": "doubao-seedance-2.0-fast",
                "label": "Seedance 2.0 Fast",
                "min_tier": "large",
            },
        ],
    },
    {
        "id": "web_search",
        "label": "联网搜索",
        "summary": (
            "套餐 Harness「豆包搜索」：在控制台领取联网搜索 API Key（SearchInfinity），"
            "填到设置 → 联网搜索；与对话 ark- Key 不是同一把。"
        ),
        "min_tier": "small",
        "items": [
            {
                "id": "doubao-search",
                "label": "豆包搜索",
                "min_tier": "small",
                "notes": (
                    "赠送额度以控制台为准；领取后把联网 Key 填到「设置 → 联网搜索 → 豆包搜索」"
                ),
            },
        ],
    },
]


def media_capability_items(capability: str) -> list[dict[str, Any]]:
    """Catalog rows for ``image`` or ``video`` capabilities."""
    cap = next((c for c in AGENT_PLAN_CAPABILITIES if c.get("id") == capability), None)
    return list((cap or {}).get("items") or [])


def default_media_models_for_tier(tier_id: str | None) -> dict[str, str | None]:
    """Best entitled Seedream / Seedance model ids for a Plan tier (video None when excluded)."""
    rank = _TIER_RANK.get(str(tier_id or "").strip().lower(), _TIER_RANK["max"])
    out: dict[str, str | None] = {"image": None, "video": None}
    for cap_id in ("image", "video"):
        best: tuple[int, int, str] | None = None
        for idx, row in enumerate(media_capability_items(cap_id)):
            min_rank = _TIER_RANK.get(str(row.get("min_tier") or "small").lower(), 0)
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
        out["image"] = "doubao-seedream-5.0-lite"
    return out


def is_agent_plan_openai_base(base_url: str) -> bool:
    raw = str(base_url or "").strip().rstrip("/").lower()
    if "/api/plan/v3" not in raw:
        return False
    host = (urlparse(raw).hostname or "").lower()
    return "volces.com" in host or "volcengine" in host


def openai_compat_fallback_models(base_url: str, *, tier_id: str | None = None) -> list[dict[str, str]] | None:
    """Static IDs when Agent Plan has no usable GET /models."""
    if not is_agent_plan_openai_base(base_url):
        return None
    return [{"id": str(m["id"])} for m in chat_models_for_tier(tier_id)]


def chat_models_for_tier(tier_id: str | None) -> list[dict[str, Any]]:
    rank = _TIER_RANK.get(str(tier_id or "").strip().lower(), _TIER_RANK["max"])
    out: list[dict[str, Any]] = []
    for row in AGENT_PLAN_CHAT_MODELS:
        min_rank = _TIER_RANK.get(str(row.get("min_tier") or "small").lower(), 0)
        if rank >= min_rank:
            out.append(dict(row))
    return out


def is_chat_model_id(model_id: str) -> bool:
    s = str(model_id or "").strip()
    if not s:
        return False
    low = s.lower()
    if low.startswith("ep-") or low.startswith("bot-"):
        return False
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
    """GET {base}/models. None means unusable (404/network/empty) → use catalog."""
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
        logger.info("Agent Plan GET /models failed: %s", exc)
        return None
    if resp.status_code != 200:
        logger.info("Agent Plan GET /models HTTP %s", resp.status_code)
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
    """Return (models, source) where source is ``remote`` or ``catalog``."""
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
                    "max_output": 128000,
                    "vision": False,
                    "reasoning": True,
                    "min_tier": "small",
                }
            )
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
        "catalog_id": "volcengine.agent_plan",
        "tier_id": tier_id,
        "min_tier": str(spec.get("min_tier") or "small"),
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
    max_out = int(spec.get("max_output") or 128000)
    always_on = bool(spec.get("thinking_always_on"))
    notes = str(spec.get("notes") or "").strip()
    desc = "方舟 Agent Plan"
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
        doc["when_thinking_enabled"] = {"extra_body": {"thinking": {"type": "enabled"}}}
        doc["thinking"] = {
            "supported_levels": ["low", "medium", "high"],
            "default_level": "medium",
            "default_mode": "enabled" if always_on else "auto",
        }
    doc["plan_type"] = "volcengine_agent"
    doc["plan_config"] = _plan_model_config(
        spec=spec,
        tier_id=tier_id,
        capability="chat",
        binding_id=binding_id,
    )
    return doc


def upsert_agent_plan_chat_models(
    *,
    api_key: str,
    base_url: str,
    tier_id: str | None,
    binding_id: str | None = None,
    set_primary_if_missing: bool = True,
) -> dict[str, Any]:
    """Write Agent Plan chat models into ``evoflow_models``. Idempotent."""
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


def list_agent_plan_embedding_specs(tier_id: str | None = None) -> list[dict[str, Any]]:
    """Embedding model rows for the current tier (from capability catalog)."""
    emb_cap = next((c for c in AGENT_PLAN_CAPABILITIES if c.get("id") == "embedding"), None)
    items = list((emb_cap or {}).get("items") or [])
    rank = _TIER_RANK.get(str(tier_id or "small").strip().lower(), 0)
    out: list[dict[str, Any]] = []
    for row in items:
        min_rank = _TIER_RANK.get(str(row.get("min_tier") or "small").lower(), 0)
        if rank >= min_rank:
            out.append(dict(row))
    return out


def _embedding_model_document(
    *,
    name: str,
    spec: dict[str, Any],
    api_key: str,
    base_url: str,
    tier_id: str | None = None,
    binding_id: str | None = None,
) -> dict[str, Any]:
    model_id = str(spec["id"])
    notes = str(spec.get("notes") or "").strip()
    desc = "方舟 Agent Plan · 向量"
    if notes:
        desc = f"{desc} · {notes}"
    return {
        "name": name,
        "vendor": VENDOR_KEY,
        "model": model_id,
        "display_name": str(spec.get("label") or model_id),
        "description": desc,
        # Match Settings → 向量模型 cloud add form (registry uses base_url + api_key)
        "use": "langchain_openai:ChatOpenAI",
        "base_url": base_url,
        "api_key": api_key,
        "supports_thinking": False,
        "supports_reasoning_effort": False,
        "supports_vision": "vision" in model_id.lower(),
        "request_timeout": 120,
        "max_retries": 2,
        "plan_type": "volcengine_agent",
        "plan_config": _plan_model_config(
            spec=spec,
            tier_id=tier_id,
            capability="embedding",
            binding_id=binding_id,
        ),
    }


def upsert_agent_plan_embedding_models(
    *,
    api_key: str,
    base_url: str,
    tier_id: str | None,
    binding_id: str | None = None,
    set_default_if_missing: bool = True,
) -> dict[str, Any]:
    """Write Agent Plan embedding models into ``evoflow_models`` (向量模型 Tab). Idempotent."""
    from evoflow.persistence import config_repositories as cfg_repo

    specs = list_agent_plan_embedding_specs(tier_id)
    allowed_ids = {str(s.get("id") or "").strip() for s in specs if s.get("id")}
    existing = list(cfg_repo.list_models() or [])
    names: list[str] = []

    # Drop previously materialized Plan embeddings that are no longer entitled
    # (e.g. plain doubao-embedding — Ark rejects it on Agent Plan).
    for row in list(existing):
        mid = str(row.get("model") or "").strip()
        name = str(row.get("name") or "").strip()
        if not mid or not name:
            continue
        if mid not in {"doubao-embedding", "doubao-embedding-vision"} and mid not in allowed_ids:
            continue
        if mid in allowed_ids:
            continue
        # Only remove Plan-scoped rows (plan base or Agent Plan description)
        bu = str(row.get("base_url") or "").lower()
        desc = str(row.get("description") or "")
        if "/api/plan/" not in bu and "Agent Plan" not in desc:
            continue
        try:
            cfg_repo.delete_model(name)
            existing = [r for r in existing if str(r.get("name") or "") != name]
            logger.info("removed unsupported Agent Plan embedding model %s (%s)", name, mid)
        except Exception as exc:
            logger.info("delete stale plan embedding %s skipped: %s", name, exc)

    for spec in specs:
        model_id = str(spec.get("id") or "").strip()
        if not model_id:
            continue
        name = _resolve_config_name(model_id, existing)
        doc = _embedding_model_document(
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

    if names:
        try:
            from evoflow.knowledge.owned import settings as owned_settings

            current = str(owned_settings.get_default_embedding_model() or "").strip()
            pick = names[0]
            for n, spec in zip(names, specs):
                if str(spec.get("id") or "") == "doubao-embedding-vision":
                    pick = n
                    break
            need_set = False
            if set_default_if_missing and not current:
                need_set = True
            elif current:
                cur_row = next((r for r in existing if str(r.get("name") or "") == current), None)
                cur_model = str((cur_row or {}).get("model") or "").strip().lower()
                # Retarget if default still points at unsupported plain text embedding
                if cur_model == "doubao-embedding" or (
                    not cur_row and "doubao-embedding" in current.lower() and "vision" not in current.lower()
                ):
                    need_set = True
            if need_set:
                owned_settings.set_default_embedding_model(pick)
        except Exception as exc:
            logger.info("set default embedding after Agent Plan materialize skipped: %s", exc)

    return {"count": len(names), "names": names}
