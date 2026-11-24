"""Aliyun Bailian Coding Plan adapter — chat on coding.dashscope.aliyuncs.com.

Coexists with Token Plan: separate plan_family, connection key, model row names.
Official: quota is for supported coding tools only — not general backend API abuse.
"""

from __future__ import annotations

import logging
from typing import Any

from evoflow.persistence.model_connections import upsert_model_connection
from evoflow.plans.aliyun_coding_plan_models import (
    CODING_CONNECTION_KEY,
    PLAN_CHAT_BASE,
    upsert_coding_plan_chat_models,
)
from evoflow.plans.errors import PlanError, PlanErrorCode

logger = logging.getLogger(__name__)


class AliyunCodingPlanAdapter:
    vendor = "aliyun"
    families = ["coding_plan"]

    def validate_key(self, key: str, family: str) -> None:
        k = str(key or "").strip()
        if not k:
            raise PlanError(PlanErrorCode.WRONG_KEY_TYPE, "请填写 Coding Plan 专属 API Key")
        if k.startswith("*"):
            return
        if not k.startswith("sk-sp-"):
            raise PlanError(
                PlanErrorCode.WRONG_KEY_TYPE,
                "阿里云 Coding Plan 请使用套餐专属 Key（sk-sp- 开头），勿使用按量 sk- 或其他厂商 Key",
                details={"prefix": "sk-sp-"},
            )

    def materialize(self, binding: dict[str, Any], catalog: dict[str, Any]) -> dict[str, Any]:
        api_key = str(binding.get("api_key") or "").strip()
        self.validate_key(api_key, "coding_plan")
        display = str(binding.get("display_name") or catalog.get("name") or "百炼 Coding Plan").strip()
        caps = list(binding.get("bound_capabilities") or [])

        endpoints = catalog.get("endpoints") or {}
        chat_ep = (endpoints.get("chat") or {}).get("base_url") or PLAN_CHAT_BASE

        conn = upsert_model_connection(
            {
                "key": CODING_CONNECTION_KEY,
                "base_url": chat_ep,
                "api_key": api_key,
                "api_type": "openai-completions",
                "display_name": display,
            }
        )

        chat_meta: dict[str, Any] = {"count": 0, "source": "catalog", "names": []}
        binding_id = str(binding.get("id") or "").strip() or None
        if "chat" in caps:
            chat_meta = upsert_coding_plan_chat_models(
                api_key=api_key,
                base_url=chat_ep,
                tier_id=binding.get("tier_id"),
                binding_id=binding_id,
                set_primary_if_missing=False,
            )

        try:
            from evoflow.config.app_config import reload_models_from_db

            reload_models_from_db()
        except Exception as exc:
            logger.warning("reload_models_from_db after Aliyun Coding Plan materialize failed: %s", exc)

        return {
            "linked_connection_ids": [str(conn.get("key") or CODING_CONNECTION_KEY)],
            "materialized": {
                "chat": "chat" in caps,
                "chat_model_count": int(chat_meta.get("count") or 0),
                "chat_models_source": str(chat_meta.get("source") or "catalog"),
                "embedding": False,
                "image": False,
                "video": False,
                "tts": False,
                "asr": False,
                "web_search": False,
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
        if capability == "chat" and not base_url:
            base_url = PLAN_CHAT_BASE
        return {
            "capability": capability,
            "binding_id": binding.get("id"),
            "base_url": base_url,
            "api_key": api_key,
            "headers": {"Authorization": f"Bearer {api_key}"} if api_key else {},
            "model_hint": None,
            "meter_tags": {
                "vendor": self.vendor,
                "plan_family": "coding_plan",
                "tier_id": binding.get("tier_id"),
                "capability": capability,
            },
            "source": "plan",
        }

    def map_error(self, text: str) -> PlanError | None:
        t = str(text or "")
        for sig in (
            ("Coding Plan", PlanErrorCode.DEDUCT_NOT_ENABLED),
            ("未订阅", PlanErrorCode.DEDUCT_NOT_ENABLED),
            ("订阅已过期", PlanErrorCode.QUOTA_EXHAUSTED),
        ):
            if sig[0] in t:
                return PlanError(
                    sig[1],
                    "当前 Key 可能未开通或未生效 Coding Plan。请确认已订阅并使用 sk-sp- Key + coding.dashscope Base。",
                )
        if "quota" in t.lower() or "额度" in t:
            return PlanError(
                PlanErrorCode.QUOTA_EXHAUSTED,
                "Coding Plan 额度可能已用尽，请等待 5h/周/月周期刷新（以百炼控制台为准）。",
            )
        return None
