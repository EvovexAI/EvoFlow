"""Volcano Ark Agent Plan adapter — materialize chat models + media + speech."""

from __future__ import annotations

import logging
from typing import Any

from evoflow.persistence.media_settings import patch_media_credentials
from evoflow.persistence.model_connections import upsert_model_connection
from evoflow.plans.errors import PlanError, PlanErrorCode
from evoflow.plans.volc_agent_plan_models import (
    PLAN_CHAT_BASE,
    PLAN_MEDIA_BASE,
    default_media_models_for_tier,
    upsert_agent_plan_chat_models,
    upsert_agent_plan_embedding_models,
)

logger = logging.getLogger(__name__)


class VolcAgentPlanAdapter:
    vendor = "volcengine"
    families = ["agent_plan"]

    def validate_key(self, key: str, family: str) -> None:
        k = str(key or "").strip()
        if not k:
            raise PlanError(PlanErrorCode.WRONG_KEY_TYPE, "请填写 Agent Plan 专属 API Key")
        if k.startswith("*"):
            return
        if not k.startswith("ark-"):
            raise PlanError(
                PlanErrorCode.WRONG_KEY_TYPE,
                "火山 Agent Plan 请使用方舟专属 Key（ark- 开头），勿使用按量或其他厂商 Key",
                details={"prefix": "ark-"},
            )

    def materialize(self, binding: dict[str, Any], catalog: dict[str, Any]) -> dict[str, Any]:
        api_key = str(binding.get("api_key") or "").strip()
        self.validate_key(api_key, "agent_plan")
        display = str(binding.get("display_name") or catalog.get("name") or "火山 Agent Plan").strip()
        caps = list(binding.get("bound_capabilities") or [])

        endpoints = catalog.get("endpoints") or {}
        chat_ep = (endpoints.get("chat") or {}).get("base_url") or PLAN_CHAT_BASE
        image_ep = (endpoints.get("image") or {}).get("base_url") or PLAN_MEDIA_BASE

        conn = upsert_model_connection(
            {
                "key": "volcengine",
                "base_url": chat_ep,
                "api_key": api_key,
                "api_type": "openai-completions",
                "display_name": display,
            }
        )

        chat_meta: dict[str, Any] = {"count": 0, "source": "catalog", "names": []}
        binding_id = str(binding.get("id") or "").strip() or None
        if "chat" in caps:
            chat_meta = upsert_agent_plan_chat_models(
                api_key=api_key,
                base_url=chat_ep,
                tier_id=binding.get("tier_id"),
                binding_id=binding_id,
            )

        emb_meta: dict[str, Any] = {"count": 0, "names": []}
        if "embedding" in caps:
            emb_ep = (endpoints.get("embedding") or {}).get("base_url") or chat_ep
            emb_meta = upsert_agent_plan_embedding_models(
                api_key=api_key,
                base_url=emb_ep,
                tier_id=binding.get("tier_id"),
                binding_id=binding_id,
            )

        tier_models = default_media_models_for_tier(binding.get("tier_id"))
        media_patch: dict[str, Any] = {
            "volcengineApiKey": api_key,
            "volcengineArkBaseUrl": image_ep,
            "jimengVideoBaseUrl": image_ep,
            "volcengineSpeechApiKey": api_key,
            "enabledVendors": {
                "volcengine": "image" in caps or "video" in caps,
                "volcengine-tts": "tts" in caps or "asr" in caps,
            },
        }
        if "image" in caps and tier_models.get("image"):
            media_patch["jimengImageModel"] = tier_models["image"]
        if "video" in caps and tier_models.get("video"):
            media_patch["jimengVideoModel"] = tier_models["video"]
        patch_media_credentials(media_patch)

        web_search_applied = False
        if "web_search" in caps:
            try:
                from evoflow.persistence.web_search_settings import (
                    apply_agent_plan_web_search_defaults,
                )

                apply_agent_plan_web_search_defaults()
                web_search_applied = True
            except Exception as exc:
                logger.warning("Agent Plan web_search defaults failed: %s", exc)

        try:
            from evoflow.config.app_config import reload_models_from_db

            reload_models_from_db()
        except Exception as exc:
            logger.warning("reload_models_from_db after Agent Plan materialize failed: %s", exc)

        return {
            "linked_connection_ids": [str(conn.get("key") or "volcengine")],
            "materialized": {
                "chat": True,
                "chat_model_count": int(chat_meta.get("count") or 0),
                "chat_models_source": str(chat_meta.get("source") or "catalog"),
                "embedding": "embedding" in caps,
                "embedding_model_count": int(emb_meta.get("count") or 0),
                "image": "image" in caps,
                "image_model": tier_models.get("image"),
                "video": "video" in caps,
                "video_model": tier_models.get("video"),
                "tts": "tts" in caps,
                "asr": "asr" in caps,
                "web_search": "web_search" in caps,
                "web_search_preferred_doubao": web_search_applied,
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
        if capability in {"image", "video"} and not base_url:
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
                "plan_family": "agent_plan",
                "tier_id": binding.get("tier_id"),
                "capability": capability,
            },
            "source": "plan",
        }

    def map_error(self, text: str) -> PlanError | None:
        t = str(text or "")
        for sig in (
            ("Agent Plan deduction is not enabled", PlanErrorCode.DEDUCT_NOT_ENABLED),
            ("未开通 Agent Plan", PlanErrorCode.DEDUCT_NOT_ENABLED),
            ("AgentPlanDeductNotEnabled", PlanErrorCode.DEDUCT_NOT_ENABLED),
        ):
            if sig[0] in t:
                return PlanError(
                    sig[1],
                    "当前方舟 Key 未开通 Agent Plan 抵扣。请确认已订阅 Agent Plan，并在控制台开启语音/AFP 抵扣。",
                )
        if "quota" in t.lower() or "额度" in t or "燃料" in t:
            return PlanError(
                PlanErrorCode.QUOTA_EXHAUSTED,
                "Agent Plan 额度可能已用尽，请等待周期刷新或升级档位（以火山控制台为准）。",
            )
        return None
