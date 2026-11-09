"""Aliyun Bailian Token Plan adapter — materialize chat models + DashScope media/speech."""

from __future__ import annotations

import logging
from typing import Any

from evoflow.persistence.media_settings import patch_media_credentials
from evoflow.persistence.model_connections import upsert_model_connection
from evoflow.plans.aliyun_token_plan_models import (
    PLAN_CHAT_BASE,
    PLAN_MEDIA_BASE,
    default_media_models_for_tier,
    upsert_token_plan_chat_models,
)
from evoflow.plans.errors import PlanError, PlanErrorCode

logger = logging.getLogger(__name__)


class AliyunTokenPlanAdapter:
    vendor = "aliyun"
    families = ["token_plan"]

    def validate_key(self, key: str, family: str) -> None:
        k = str(key or "").strip()
        if not k:
            raise PlanError(PlanErrorCode.WRONG_KEY_TYPE, "请填写 Token Plan 专属 API Key")
        if k.startswith("*"):
            return
        if not k.startswith("sk-sp-"):
            raise PlanError(
                PlanErrorCode.WRONG_KEY_TYPE,
                "阿里云 Token Plan 请使用套餐专属 Key（sk-sp- 开头），勿使用按量 sk- 或其他厂商 Key",
                details={"prefix": "sk-sp-"},
            )

    def materialize(self, binding: dict[str, Any], catalog: dict[str, Any]) -> dict[str, Any]:
        api_key = str(binding.get("api_key") or "").strip()
        self.validate_key(api_key, "token_plan")
        display = str(binding.get("display_name") or catalog.get("name") or "百炼 Token Plan").strip()
        caps = list(binding.get("bound_capabilities") or [])

        endpoints = catalog.get("endpoints") or {}
        chat_ep = (endpoints.get("chat") or {}).get("base_url") or PLAN_CHAT_BASE
        media_ep = (endpoints.get("image") or {}).get("base_url") or PLAN_MEDIA_BASE

        conn = upsert_model_connection(
            {
                "key": "aliyun",
                "base_url": chat_ep,
                "api_key": api_key,
                "api_type": "openai-completions",
                "display_name": display,
            }
        )

        chat_meta: dict[str, Any] = {"count": 0, "source": "catalog", "names": []}
        binding_id = str(binding.get("id") or "").strip() or None
        if "chat" in caps:
            chat_meta = upsert_token_plan_chat_models(
                api_key=api_key,
                base_url=chat_ep,
                tier_id=binding.get("tier_id"),
                binding_id=binding_id,
            )

        tier_models = default_media_models_for_tier(binding.get("tier_id"))
        media_patch: dict[str, Any] = {
            "dashscopeApiKey": api_key,
            "dashscopeBaseUrl": media_ep,
            "enabledVendors": {
                "dashscope": "image" in caps or "video" in caps,
                "dashscope-tts": "tts" in caps or "asr" in caps,
            },
        }
        patch_media_credentials(media_patch)

        try:
            from evoflow.config.app_config import reload_models_from_db

            reload_models_from_db()
        except Exception as exc:
            logger.warning("reload_models_from_db after Token Plan materialize failed: %s", exc)

        return {
            "linked_connection_ids": [str(conn.get("key") or "aliyun")],
            "materialized": {
                "chat": True,
                "chat_model_count": int(chat_meta.get("count") or 0),
                "chat_models_source": str(chat_meta.get("source") or "catalog"),
                "embedding": False,
                "embedding_model_count": 0,
                "image": "image" in caps,
                "image_model": tier_models.get("image"),
                "video": "video" in caps,
                "video_model": tier_models.get("video"),
                "tts": "tts" in caps,
                "asr": "asr" in caps,
                "web_search": "web_search" in caps,
                "web_search_builtin": "web_search" in caps,
            },
        }

    def build_route(
        self,
        binding: dict[str, Any],
        catalog: dict[str, Any],
        capability: str,
    ) -> dict[str, Any]:
        api_key = str(binding.get("api_key") or "").strip()
        endpoints = catalog.get("endpoints") or {}
        ep = endpoints.get(capability) or {}
        base_url = str(ep.get("base_url") or "")
        if capability in {"image", "video", "tts", "asr"} and not base_url:
            base_url = PLAN_MEDIA_BASE
        if capability == "chat" and not base_url:
            base_url = PLAN_CHAT_BASE
        tier_models = default_media_models_for_tier(binding.get("tier_id"))
        model_hint: str | None = None
        if capability == "image":
            model_hint = tier_models.get("image")
        elif capability == "video":
            model_hint = tier_models.get("video")
        return {
            "capability": capability,
            "binding_id": binding.get("id"),
            "base_url": base_url,
            "api_key": api_key,
            "headers": {"Authorization": f"Bearer {api_key}"} if api_key else {},
            "model_hint": model_hint,
            "meter_tags": {
                "vendor": self.vendor,
                "plan_family": "token_plan",
                "tier_id": binding.get("tier_id"),
                "capability": capability,
            },
            "source": "plan",
        }

    def map_error(self, text: str) -> PlanError | None:
        t = str(text or "")
        for sig in (
            ("Token Plan", PlanErrorCode.DEDUCT_NOT_ENABLED),
            ("token plan", PlanErrorCode.DEDUCT_NOT_ENABLED),
            ("未订阅", PlanErrorCode.DEDUCT_NOT_ENABLED),
            ("订阅已过期", PlanErrorCode.QUOTA_EXHAUSTED),
        ):
            if sig[0] in t:
                return PlanError(
                    sig[1],
                    "当前 Key 可能未开通或未生效 Token Plan。请确认已订阅并使用 sk-sp- 套餐专属 Key。",
                )
        if "quota" in t.lower() or "额度" in t or "credits" in t.lower() or "Credits" in t:
            return PlanError(
                PlanErrorCode.QUOTA_EXHAUSTED,
                "Token Plan 额度可能已用尽，请等待周期刷新、购买用量包或升级档位（以百炼控制台为准）。",
            )
        return None
