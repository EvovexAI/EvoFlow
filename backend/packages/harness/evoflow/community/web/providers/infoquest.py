"""InfoQuest search provider (EvoFlow-specific, Hermes-shaped envelope)."""

from __future__ import annotations

import json
import logging
from typing import Any

from evoflow.community.web.provider import WebSearchProvider, get_provider_env

logger = logging.getLogger(__name__)


class InfoQuestWebSearchProvider(WebSearchProvider):
    @property
    def name(self) -> str:
        return "infoquest"

    @property
    def display_name(self) -> str:
        return "InfoQuest"

    def is_available(self) -> bool:
        return bool(get_provider_env("INFOQUEST_API_KEY"))

    def supports_search(self) -> bool:
        return True

    def search(self, query: str, limit: int = 5) -> dict[str, Any]:
        if not get_provider_env("INFOQUEST_API_KEY"):
            return {"success": False, "error": "INFOQUEST_API_KEY is not set"}
        try:
            from evoflow.community.infoquest.infoquest_client import InfoQuestClient

            search_time_range = -1
            try:
                from evoflow.config import get_app_config

                cfg = get_app_config().get_tool_config("web_search")
                if cfg is not None and cfg.model_extra and "search_time_range" in cfg.model_extra:
                    search_time_range = cfg.model_extra.get("search_time_range", -1)
            except Exception:
                pass

            client = InfoQuestClient(search_time_range=search_time_range)
            raw = client.web_search(query)
            if isinstance(raw, str) and raw.startswith("Error:"):
                return {"success": False, "error": raw}
            data = json.loads(raw) if isinstance(raw, str) else raw
            rows = data if isinstance(data, list) else (data.get("results") or data.get("data") or [])
        except Exception as e:
            logger.warning("InfoQuest search failed: %s", e)
            return {"success": False, "error": f"InfoQuest search failed: {e}"}

        web = []
        for i, r in enumerate(rows[: max(1, int(limit))]):
            if not isinstance(r, dict):
                continue
            web.append(
                {
                    "title": str(r.get("title") or ""),
                    "url": str(r.get("url") or r.get("href") or r.get("link") or ""),
                    "description": str(r.get("snippet") or r.get("content") or r.get("body") or ""),
                    "position": i + 1,
                }
            )
        return {"success": True, "data": {"web": web}}
