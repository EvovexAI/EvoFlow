"""News feeds for EvoPanel right-stage news-dashboard kind."""

from __future__ import annotations

from fastapi import APIRouter, Query

router = APIRouter(prefix="/api/stage/news", tags=["stage-news"])


@router.get("/feeds")
def get_news_feeds(refresh: int = Query(0, ge=0, le=1)):
    try:
        from evoflow.stage.stage_context import fetch_news_feeds

        return fetch_news_feeds(force_refresh=bool(refresh))
    except Exception as exc:
        return {"ok": False, "error": str(exc), "platforms": {}}
