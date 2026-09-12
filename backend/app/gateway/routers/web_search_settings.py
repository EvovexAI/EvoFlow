"""Gateway API for web search settings (EvoPanel).

Read/write settings may use REST helpers; **connectivity test always goes through
the same platform action as the assistant** (``settings.test_web_search``), which
calls ``run_provider_search`` — identical to the ``web_search`` tool bottom layer.
"""

from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from evoflow.admin import web_search as web_search_admin
from evoflow.admin.platform_actions import dispatch_platform_action
from evoflow.authz.http_guard import require_org_admin
from evoflow.persistence.web_search_settings import DEFAULT_WEB_SEARCH_SETTINGS, PROVIDER_UI

router = APIRouter(prefix="/api/settings", tags=["settings"])


class WebSearchSettingsResponse(BaseModel):
    settings: dict[str, Any] = Field(default_factory=dict)
    defaults: dict[str, Any] = Field(default_factory=lambda: dict(DEFAULT_WEB_SEARCH_SETTINGS))
    providers: list[dict[str, Any]] = Field(default_factory=list)
    active_backend: str | None = None
    active_source: str = "auto"  # settings | auto | agent_plan | none
    agent_plan_web_search: dict[str, Any] | None = None
    provider_ui: list[dict[str, str]] = Field(default_factory=lambda: list(PROVIDER_UI))


class WebSearchSettingsPatchBody(BaseModel):
    settings: dict[str, Any] = Field(default_factory=dict)


class WebSearchTestBody(BaseModel):
    query: str = Field(default="今天 AI 新闻")
    engines: list[str] | None = Field(default=None)
    max_results: int = Field(default=5, ge=1, le=20)
    adopt_recommended: bool = Field(default=False)


class WebSearchTestResultItem(BaseModel):
    name: str
    ok: bool = False
    latency_ms: float = 0
    result_count: int = 0
    sample_titles: list[str] = Field(default_factory=list)
    error: str = ""
    available: bool = False
    skipped: bool = False


class WebSearchTestResponse(BaseModel):
    query: str
    results: list[WebSearchTestResultItem] = Field(default_factory=list)
    recommended: str | None = None
    adopted_preferred: str | None = None


def _to_settings_response(data: dict[str, Any]) -> WebSearchSettingsResponse:
    return WebSearchSettingsResponse(
        settings=data.get("settings") or {},
        defaults=data.get("defaults") or dict(DEFAULT_WEB_SEARCH_SETTINGS),
        providers=data.get("providers") or [],
        active_backend=data.get("active_backend"),
        active_source=str(data.get("active_source") or "none"),
        agent_plan_web_search=data.get("agent_plan_web_search"),
        provider_ui=list(data.get("provider_ui") or PROVIDER_UI),
    )


@router.get("/web-search", response_model=WebSearchSettingsResponse)
async def get_web_search_settings_api(request: Request) -> WebSearchSettingsResponse:
    require_org_admin(request)
    return _to_settings_response(web_search_admin.get_web_search())


@router.patch("/web-search", response_model=WebSearchSettingsResponse)
async def patch_web_search_settings_api(
    request: Request, body: WebSearchSettingsPatchBody
) -> WebSearchSettingsResponse:
    require_org_admin(request)
    return _to_settings_response(web_search_admin.patch_web_search(body.settings or {}))


@router.post("/web-search/test", response_model=WebSearchTestResponse)
async def test_web_search_api(request: Request, body: WebSearchTestBody) -> WebSearchTestResponse:
    """Thin alias of ``POST /api/platform`` → ``settings.test_web_search``.

    Same backend as the agent ``platform`` tool / ``web_search`` provider layer
    (``evoflow.community.web.registry.run_provider_search``). Do not reintroduce a
    parallel probe implementation here.
    """
    require_org_admin(request)
    args: dict[str, Any] = {
        "query": body.query,
        "max_results": body.max_results,
        "adopt_recommended": bool(body.adopt_recommended),
    }
    if body.engines is not None:
        args["engines"] = body.engines

    raw = dispatch_platform_action(
        "settings.test_web_search",
        args_json=json.dumps(args, ensure_ascii=False),
        confirm=True,
    )
    if not isinstance(raw, dict) or not raw.get("ok"):
        detail = ""
        if isinstance(raw, dict):
            detail = str(raw.get("error") or raw.get("hint") or raw)
        raise HTTPException(status_code=400, detail=detail or "web search test failed")

    results = [WebSearchTestResultItem(**r) for r in (raw.get("results") or []) if isinstance(r, dict)]
    return WebSearchTestResponse(
        query=str(raw.get("query") or body.query),
        results=results,
        recommended=raw.get("recommended"),
        adopted_preferred=raw.get("adopted_preferred"),
    )
