"""Real multi-platform hot lists — adapted from the legacy voice module/src/hotspots.js."""

from __future__ import annotations

import logging
import os
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from typing import Any
from urllib.parse import quote

import httpx

logger = logging.getLogger(__name__)

DEFAULT_REFRESH_MINUTES = 30
DEFAULT_TIMEOUT_SEC = 10.0
USER_AGENT = "EvoFlow/1.0 (+https://localhost)"
# HotData 热点榜 API Key：从环境变量读取，不硬编码密钥。
PUBLIC_HOTDATA_API_KEY = os.environ.get("HOTDATA_API_KEY", "") or ""

PLATFORM_ORDER = ("douyin", "xiaohongshu", "wechat", "weibo")
PLATFORM_LABELS = {
    "douyin": "抖音",
    "xiaohongshu": "小红书",
    "wechat": "微信热点",
    "weibo": "微博",
}

LABEL_TEXT = {
    "1": "热",
    "3": "热",
    "5": "荐",
    "8": "新",
    "16": "辟谣",
    "17": "活动",
}

_cache: dict[str, Any] | None = None
_cache_at = 0.0
_in_flight: bool = False


def _read_config() -> dict[str, Any]:
    refresh_raw = os.environ.get("HOTSPOT_REFRESH_MINUTES", str(DEFAULT_REFRESH_MINUTES))
    try:
        refresh_minutes = max(5, min(24 * 60, int(refresh_raw)))
    except (TypeError, ValueError):
        refresh_minutes = DEFAULT_REFRESH_MINUTES

    tianapi_key = str(os.environ.get("TIANAPI_KEY") or os.environ.get("TIANAPI_DOUYIN_KEY") or "").strip()

    return {
        "provider": str(os.environ.get("HOTSPOT_PROVIDER", "auto")).strip().lower() or "auto",
        "refresh_minutes": refresh_minutes,
        "tianapi_key": tianapi_key,
        "douyin": {
            "url": str(os.environ.get("HOTSPOT_DOUYIN_URL", "")).strip(),
        },
        "xiaohongshu": {
            "url": str(
                os.environ.get("HOTSPOT_XHS_URL")
                or os.environ.get("HOTSPOT_XIAOHONGSHU_URL")
                or ""
            ).strip(),
            "token": str(
                os.environ.get("TIKHUB_TOKEN") or os.environ.get("HOTSPOT_TIKHUB_TOKEN") or ""
            ).strip(),
        },
        "hotdata": {
            "key": str(os.environ.get("HOTDATA_API_KEY", PUBLIC_HOTDATA_API_KEY) or "").strip(),
        },
        "wechat": {
            "url": str(os.environ.get("HOTSPOT_WECHAT_URL", "")).strip(),
            "tianapi_key": str(
                os.environ.get("TIANAPI_WECHAT_KEY") or tianapi_key or ""
            ).strip(),
        },
        "weibo": {
            "url": str(os.environ.get("HOTSPOT_WEIBO_URL", "")).strip(),
            "tianapi_key": str(
                os.environ.get("TIANAPI_WEIBO_KEY") or tianapi_key or ""
            ).strip(),
        },
    }


def _is_cache_fresh(config: dict[str, Any], now: float | None = None) -> bool:
    if not _cache or not _cache.get("fetchedAtMs"):
        return False
    ttl = float(config["refresh_minutes"]) * 60.0
    return (now or time.time()) - float(_cache["fetchedAtMs"]) < ttl


def _fetch_json(url: str, *, headers: dict[str, str] | None = None) -> Any:
    with httpx.Client(timeout=DEFAULT_TIMEOUT_SEC, follow_redirects=True) as client:
        res = client.get(
            url,
            headers={
                "User-Agent": USER_AGENT,
                "Accept": "application/json,text/plain,*/*",
                **(headers or {}),
            },
        )
        res.raise_for_status()
        return res.json()


def _format_heat(value: Any) -> str:
    try:
        n = float(value)
    except (TypeError, ValueError):
        return str(value or "")
    if n >= 100_000_000:
        text = f"{n / 100_000_000:.2f}".rstrip("0").rstrip(".")
        return f"{text}亿"
    if n >= 10_000:
        return f"{int(round(n / 10_000))}万"
    return str(int(n)) if n == int(n) else str(n)


def _label_text(label: Any) -> str:
    value = str(label or "").strip()
    if not value or value == "0":
        return ""
    return LABEL_TEXT.get(value, value)


def _pick_array(data: Any) -> list[Any]:
    if isinstance(data, list):
        return data
    if not isinstance(data, dict):
        return []
    candidates = [
        data.get("result"),
        data.get("data"),
        data.get("newslist"),
        data.get("list"),
        (data.get("result") or {}).get("list") if isinstance(data.get("result"), dict) else None,
        (data.get("data") or {}).get("list") if isinstance(data.get("data"), dict) else None,
        (data.get("data") or {}).get("items") if isinstance(data.get("data"), dict) else None,
        (data.get("data") or {}).get("data") if isinstance(data.get("data"), dict) else None,
        ((data.get("data") or {}).get("data") or {}).get("items")
        if isinstance(data.get("data"), dict) and isinstance((data.get("data") or {}).get("data"), dict)
        else None,
        (data.get("data") or {}).get("hot_list") if isinstance(data.get("data"), dict) else None,
        (data.get("data") or {}).get("hotList") if isinstance(data.get("data"), dict) else None,
    ]
    for candidate in candidates:
        if isinstance(candidate, list):
            return candidate
    return []


def _normalize_items(platform: str, raw_items: Any, source: str) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    if not isinstance(raw_items, list):
        return items
    for idx, item in enumerate(raw_items):
        if not isinstance(item, dict):
            continue
        title = (
            item.get("word")
            or item.get("hotword")
            or item.get("sentence")
            or item.get("title")
            or item.get("name")
            or item.get("keyword")
            or item.get("query")
            or item.get("text")
            or item.get("display_query")
            or ""
        )
        title = str(title).strip()
        if not title:
            continue
        tag = _label_text(item.get("label") or item.get("sentence_tag") or item.get("tag") or item.get("type"))
        heat_raw = (
            item.get("hot_value")
            or item.get("hotValue")
            or item.get("hotwordnum")
            or item.get("heat")
            or item.get("score")
            or item.get("views")
            or item.get("view_count")
            or item.get("num")
            or ""
        )
        heat = _format_heat(heat_raw) if heat_raw not in ("", None) else ""
        url = str(
            item.get("url")
            or item.get("share_url")
            or item.get("link")
            or item.get("jump_url")
            or ""
        ).strip()
        rank = int(item.get("position") or item.get("rank") or item.get("index") or idx + 1)
        items.append(
            {
                "platform": platform,
                "rank": rank,
                "text": title,
                "title": title,
                "heat": heat,
                "tag": tag,
                "trend": "same",
                "isNew": tag == "新" or bool(item.get("is_new") or item.get("isNew")),
                "url": url,
                "source": source,
            }
        )
    return items[:50]


def _run_providers(providers: list, empty_message: str) -> list[dict[str, Any]]:
    if not providers:
        raise RuntimeError(empty_message)
    errors: list[str] = []
    for provider in providers:
        try:
            return provider()
        except Exception as exc:
            errors.append(str(exc))
    raise RuntimeError("；".join(errors) or empty_message)


def _fetch_custom_platform(platform: str, url: str) -> list[dict[str, Any]]:
    if not url:
        raise RuntimeError(f"缺少 {PLATFORM_LABELS.get(platform, platform)} 自定义热榜地址")
    data = _fetch_json(url)
    items = _normalize_items(platform, _pick_array(data), "custom")
    if not items:
        raise RuntimeError("自定义热榜返回空数据")
    return items


def _fetch_tianapi(platform: str, api_name: str, key: str) -> list[dict[str, Any]]:
    if not key:
        raise RuntimeError("缺少 TianAPI key")
    data = _fetch_json(f"https://apis.tianapi.com/{api_name}/index?key={quote(key, safe='')}")
    items = _normalize_items(platform, _pick_array(data), "tianapi")
    if not items:
        raise RuntimeError("TianAPI 返回空热榜")
    return items


def _fetch_haotechs_douyin() -> list[dict[str, Any]]:
    data = _fetch_json("https://www.haotechs.cn/ljh-wx/api/douyinHot")
    items = _normalize_items("douyin", _pick_array(data), "haotechs")
    if not items:
        raise RuntimeError("haotechs 返回空热榜")
    return items


def _fetch_xxapi(platform: str, api_name: str) -> list[dict[str, Any]]:
    data = _fetch_json(f"https://v2.xxapi.cn/api/{api_name}")
    items = _normalize_items(platform, _pick_array(data), "xxapi")
    if not items:
        raise RuntimeError("xxapi 返回空热榜")
    return items


def _fetch_tikhub_xiaohongshu(config: dict[str, Any]) -> list[dict[str, Any]]:
    token = config["xiaohongshu"]["token"]
    if not token:
        raise RuntimeError("缺少 TikHub token")
    data = _fetch_json(
        "https://api.tikhub.io/api/v1/xiaohongshu/web_v2/fetch_hot_list",
        headers={"Authorization": f"Bearer {token}"},
    )
    items = _normalize_items("xiaohongshu", _pick_array(data), "tikhub")
    if not items:
        raise RuntimeError("TikHub 返回空热榜")
    return items


def _fetch_hotdata(platform: str, data_id: str, key: str) -> list[dict[str, Any]]:
    if not key:
        raise RuntimeError("缺少 Hot Data key")
    data = _fetch_json(
        f"https://w-hotdata.aipromptnav.com/api/hot-data/{data_id}",
        headers={"X-API-Key": key},
    )
    items = _normalize_items(platform, _pick_array(data), "hotdata")
    if not items:
        raise RuntimeError("Hot Data 返回空热榜")
    return items


def _fetch_douyin(config: dict[str, Any]) -> list[dict[str, Any]]:
    providers = []
    if config["provider"] == "custom":
        providers.append(lambda: _fetch_custom_platform("douyin", config["douyin"]["url"]))
    if config["provider"] == "tianapi" or (config["provider"] == "auto" and config["tianapi_key"]):
        providers.append(lambda: _fetch_tianapi("douyin", "douyinhot", config["tianapi_key"]))
    if config["provider"] in ("haotechs", "auto"):
        providers.append(_fetch_haotechs_douyin)
    if config["provider"] in ("xxapi", "auto"):
        providers.append(lambda: _fetch_xxapi("douyin", "douyinhot"))
    return _run_providers(providers, f"未知抖音热点 provider: {config['provider']}")


def _fetch_xiaohongshu(config: dict[str, Any]) -> list[dict[str, Any]]:
    providers = []
    if config["xiaohongshu"]["url"]:
        providers.append(
            lambda: _fetch_custom_platform("xiaohongshu", config["xiaohongshu"]["url"])
        )
    if config["xiaohongshu"]["token"]:
        providers.append(lambda: _fetch_tikhub_xiaohongshu(config))
    if config["provider"] in ("auto", "hotdata"):
        providers.append(
            lambda: _fetch_hotdata("xiaohongshu", "xiaohongshu", config["hotdata"]["key"])
        )
    return _run_providers(providers, "小红书实时源未配置")


def _fetch_wechat(config: dict[str, Any]) -> list[dict[str, Any]]:
    providers = []
    if config["wechat"]["url"]:
        providers.append(lambda: _fetch_custom_platform("wechat", config["wechat"]["url"]))
    if config["wechat"]["tianapi_key"]:
        providers.append(
            lambda: _fetch_tianapi("wechat", "wxhottopic", config["wechat"]["tianapi_key"])
        )
    if config["provider"] in ("auto", "hotdata"):
        providers.append(
            lambda: _fetch_hotdata("wechat", "wxhottopic", config["hotdata"]["key"])
        )
    return _run_providers(providers, "微信热点实时源未配置")


def _fetch_weibo(config: dict[str, Any]) -> list[dict[str, Any]]:
    providers = []
    if config["weibo"]["url"]:
        providers.append(lambda: _fetch_custom_platform("weibo", config["weibo"]["url"]))
    if config["weibo"]["tianapi_key"]:
        providers.append(
            lambda: _fetch_tianapi("weibo", "weibohot", config["weibo"]["tianapi_key"])
        )
    if config["provider"] in ("auto", "hotdata"):
        providers.append(lambda: _fetch_hotdata("weibo", "weibohot", config["hotdata"]["key"]))
    if config["provider"] in ("auto", "xxapi"):
        providers.append(lambda: _fetch_xxapi("weibo", "weibohot"))
    return _run_providers(providers, "微博热搜实时源未配置")


def _fetch_platform(platform: str, loader) -> dict[str, Any]:
    try:
        items = loader()
        return {
            "platform": platform,
            "items": items,
            "status": {"ok": True, "count": len(items), "source": items[0].get("source") if items else "hotspot-api"},
        }
    except Exception as exc:
        logger.warning("news_feeds: %s failed: %s", platform, exc)
        return {
            "platform": platform,
            "items": [],
            "status": {"ok": False, "count": 0, "error": str(exc)},
        }


def _fetch_all_platforms() -> dict[str, Any]:
    config = _read_config()
    fetched_at = datetime.now(timezone.utc)
    loaders = {
        "douyin": lambda: _fetch_douyin(config),
        "xiaohongshu": lambda: _fetch_xiaohongshu(config),
        "wechat": lambda: _fetch_wechat(config),
        "weibo": lambda: _fetch_weibo(config),
    }
    results: list[dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=4) as pool:
        futures = {
            pool.submit(_fetch_platform, platform, loaders[platform]): platform
            for platform in PLATFORM_ORDER
        }
        for future in as_completed(futures):
            results.append(future.result())
    results.sort(key=lambda r: PLATFORM_ORDER.index(r["platform"]))

    platforms: dict[str, list[dict[str, Any]]] = {}
    status: dict[str, Any] = {}
    for result in results:
        platforms[result["platform"]] = result["items"]
        status[result["platform"]] = result["status"]

    if not any(items for items in platforms.values()):
        errors = [
            f"{PLATFORM_LABELS.get(p, p)}：{(status.get(p) or {}).get('error') or '无数据'}"
            for p in PLATFORM_ORDER
        ]
        raise RuntimeError("；".join(errors) or "全部热点源均不可用")

    return {
        "ok": True,
        "refreshMinutes": config["refresh_minutes"],
        "fetchedAt": fetched_at.isoformat().replace("+00:00", "Z"),
        "fetchedAtMs": fetched_at.timestamp() * 1000,
        "stale": False,
        "platforms": platforms,
        "status": status,
    }


def fetch_news_feeds(*, force_refresh: bool = False) -> dict[str, Any]:
    """Return cached or freshly fetched multi-platform hot lists."""
    global _cache, _cache_at, _in_flight

    config = _read_config()
    now = time.time()

    if not force_refresh and _is_cache_fresh(config, now):
        out = dict(_cache or {})
        out["stale"] = True
        return out

    if _in_flight and _cache:
        out = dict(_cache)
        out["stale"] = True
        return out

    _in_flight = True
    try:
        try:
            result = _fetch_all_platforms()
            _cache = result
            _cache_at = now
            return dict(result)
        except Exception as exc:
            if _cache:
                out = dict(_cache)
                out["ok"] = True
                out["stale"] = True
                out["error"] = str(exc)
                return out
            return {
                "ok": False,
                "error": str(exc),
                "platforms": {},
                "status": {},
                "stale": False,
            }
    finally:
        _in_flight = False
