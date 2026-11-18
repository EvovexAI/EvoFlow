"""Resource-market source list: official GitHub + user-added catalogs (LAN / custom)."""

from __future__ import annotations

import json
import logging
import re
import time
import urllib.error
import urllib.request
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from evoflow.organizations.fetch import DEFAULT_MARKET_CATALOG_URL, market_catalog_url
from evoflow.persistence import config_repositories as cfg_repo

logger = logging.getLogger(__name__)

_SOURCES_KEY = "resource_market.sources"
_OFFICIAL_ID = "official"
_ID_RE = re.compile(r"^[a-z][a-z0-9_-]{0,63}$")

# Per-source fetch cache (url -> (monotonic_ts, data|None))
_fetch_cache: dict[str, tuple[float, dict[str, Any] | None]] = {}
_FETCH_TTL_S = 60.0
_FETCH_NEG_TTL_S = 15.0


def official_source() -> dict[str, Any]:
    return {
        "id": _OFFICIAL_ID,
        "name": "官方资源市场",
        "catalog_url": market_catalog_url(),
        "enabled": True,
        "builtin": True,
        "token": "",
    }


def _normalize_source(raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    sid = str(raw.get("id") or "").strip().lower()
    url = str(raw.get("catalog_url") or raw.get("url") or "").strip()
    if not sid or not _ID_RE.match(sid) or sid == _OFFICIAL_ID:
        return None
    if not url or not url.lower().startswith(("http://", "https://")):
        return None
    return {
        "id": sid,
        "name": str(raw.get("name") or sid).strip() or sid,
        "catalog_url": url,
        "enabled": bool(raw.get("enabled", True)),
        "builtin": False,
        "token": str(raw.get("token") or "").strip(),
    }


def list_sources() -> list[dict[str, Any]]:
    """Official first, then custom sources from app settings."""
    out = [official_source()]
    try:
        stored = cfg_repo.get_app_setting(_SOURCES_KEY)
    except Exception:
        stored = None
    rows: list[Any] = []
    if isinstance(stored, list):
        rows = stored
    elif isinstance(stored, str) and stored.strip():
        try:
            parsed = json.loads(stored)
            if isinstance(parsed, list):
                rows = parsed
        except Exception:
            rows = []
    seen = {_OFFICIAL_ID}
    for raw in rows:
        norm = _normalize_source(raw)
        if not norm or norm["id"] in seen:
            continue
        seen.add(norm["id"])
        out.append(norm)
    return out


def save_custom_sources(sources: list[dict[str, Any]]) -> list[dict[str, Any]]:
    custom = []
    seen: set[str] = set()
    for raw in sources:
        norm = _normalize_source(raw)
        if not norm or norm["id"] in seen:
            continue
        seen.add(norm["id"])
        custom.append(
            {
                "id": norm["id"],
                "name": norm["name"],
                "catalog_url": norm["catalog_url"],
                "enabled": norm["enabled"],
                "token": norm["token"],
            }
        )
    cfg_repo.set_app_setting(_SOURCES_KEY, custom)
    return list_sources()


def add_source(
    *,
    catalog_url: str,
    name: str = "",
    source_id: str = "",
    token: str = "",
    enabled: bool = True,
) -> dict[str, Any]:
    url = str(catalog_url or "").strip()
    if not url.lower().startswith(("http://", "https://")):
        raise ValueError("catalog_url must be http(s)")
    sid = str(source_id or "").strip().lower()
    if not sid:
        # Derive a stable-ish id from host path
        host = urlsplit(url).hostname or "custom"
        host = re.sub(r"[^a-z0-9]+", "-", host.lower()).strip("-") or "custom"
        sid = host[:48]
        if not _ID_RE.match(sid):
            sid = f"src-{abs(hash(url)) % 10_000_000}"
    if sid == _OFFICIAL_ID:
        raise ValueError("id 'official' is reserved")
    if not _ID_RE.match(sid):
        raise ValueError("source id must be kebab-case [a-z][a-z0-9_-]{0,63}")

    sources = [s for s in list_sources() if not s.get("builtin")]
    for s in sources:
        if s["id"] == sid:
            s["name"] = str(name or s["name"] or sid).strip() or sid
            s["catalog_url"] = url
            s["token"] = str(token or "").strip()
            s["enabled"] = bool(enabled)
            save_custom_sources(sources)
            return next(x for x in list_sources() if x["id"] == sid)
    sources.append(
        {
            "id": sid,
            "name": str(name or sid).strip() or sid,
            "catalog_url": url,
            "enabled": bool(enabled),
            "token": str(token or "").strip(),
        }
    )
    save_custom_sources(sources)
    return next(x for x in list_sources() if x["id"] == sid)


def remove_source(source_id: str) -> list[dict[str, Any]]:
    sid = str(source_id or "").strip().lower()
    if not sid or sid == _OFFICIAL_ID:
        raise ValueError("cannot remove official market")
    custom = [s for s in list_sources() if not s.get("builtin") and s["id"] != sid]
    return save_custom_sources(custom)


def set_source_enabled(source_id: str, enabled: bool) -> dict[str, Any]:
    sid = str(source_id or "").strip().lower()
    if sid == _OFFICIAL_ID:
        # Official stays on; env override still controls its URL.
        return official_source()
    sources = [s for s in list_sources() if not s.get("builtin")]
    found = None
    for s in sources:
        if s["id"] == sid:
            s["enabled"] = bool(enabled)
            found = s
            break
    if not found:
        raise ValueError(f"unknown market source: {sid}")
    save_custom_sources(sources)
    return next(x for x in list_sources() if x["id"] == sid)


def append_token_to_url(url: str, token: str) -> str:
    """Attach ?token= when the market host expects it."""
    u = str(url or "").strip()
    tok = str(token or "").strip()
    if not u or not tok:
        return u
    parts = urlsplit(u)
    q = dict(parse_qsl(parts.query, keep_blank_values=True))
    if "token" not in q:
        q["token"] = tok
    return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(q), parts.fragment))


def _http_get_json(url: str, *, token: str = "", timeout: float = 4.0) -> dict[str, Any]:
    final = append_token_to_url(url, token)
    headers = {"User-Agent": "EvoFlow-ResourceMarket/1.0", "Accept": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(final, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310 — operator URL
        raw = resp.read().decode("utf-8", errors="replace")
    data = json.loads(raw)
    if not isinstance(data, dict):
        raise ValueError("catalog must be a JSON object")
    return data


def fetch_catalog_for_source(source: dict[str, Any], *, force: bool = False) -> dict[str, Any]:
    url = str(source.get("catalog_url") or "").strip()
    token = str(source.get("token") or "").strip()
    cache_key = f"{url}#{token}"
    now = time.monotonic()
    if not force and cache_key in _fetch_cache:
        ts, cached = _fetch_cache[cache_key]
        ttl = _FETCH_TTL_S if cached is not None else _FETCH_NEG_TTL_S
        if now - ts < ttl:
            if cached is None:
                raise RuntimeError("catalog recently failed")
            return dict(cached)

    empty = {
        "schema": 1,
        "marketId": source.get("id") or "unknown",
        "packs": [],
        "source": url or None,
        "configured": bool(url),
        "sourceId": source.get("id"),
        "sourceName": source.get("name"),
    }
    if not url:
        return empty
    try:
        data = _http_get_json(url, token=token)
        data.setdefault("schema", 1)
        data["source"] = url
        data["configured"] = True
        data["sourceId"] = source.get("id")
        data["sourceName"] = source.get("name")
        if not isinstance(data.get("packs"), list):
            data["packs"] = []
        _fetch_cache[cache_key] = (now, data)
        return dict(data)
    except Exception as e:
        _fetch_cache[cache_key] = (now, None)
        logger.info("market catalog fetch failed source=%s err=%s", source.get("id"), e)
        raise


def pack_download_url(pack: dict[str, Any]) -> str:
    """Resolve zip download URL from a catalog pack entry (if any)."""
    if not isinstance(pack, dict):
        return ""
    dl = pack.get("download")
    if isinstance(dl, dict):
        for key in ("url", "zip_url"):
            u = str(dl.get(key) or "").strip()
            if u.lower().startswith(("http://", "https://")):
                return u
        if str(dl.get("type") or "").strip().lower() in ("zip_url", "url"):
            u = str(dl.get("url") or dl.get("zip_url") or "").strip()
            if u:
                return u
    for key in ("zip_url", "download_url", "url"):
        u = str(pack.get(key) or "").strip()
        if u.lower().startswith(("http://", "https://")):
            return u
    return ""


def annotate_packs(packs: list[Any], *, source: dict[str, Any]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for raw in packs:
        if not isinstance(raw, dict):
            continue
        p = dict(raw)
        p["_sourceId"] = source.get("id")
        p["_sourceName"] = source.get("name")
        p["_sourceToken"] = source.get("token") or ""
        # Convenience for UI/install
        zip_url = pack_download_url(p)
        if zip_url and source.get("token"):
            zip_url = append_token_to_url(zip_url, str(source.get("token") or ""))
        if zip_url:
            p["_zipUrl"] = zip_url
        out.append(p)
    return out


def fetch_merged_catalog(*, force: bool = False) -> dict[str, Any]:
    """Merge packs from all enabled sources (official + custom)."""
    sources = [s for s in list_sources() if s.get("enabled", True)]
    packs: list[dict[str, Any]] = []
    errors: list[dict[str, str]] = []
    seen_ids: set[str] = set()
    for src in sources:
        try:
            data = fetch_catalog_for_source(src, force=force)
            for p in annotate_packs(list(data.get("packs") or []), source=src):
                pid = str(p.get("id") or p.get("path") or "").strip()
                # Allow same id from different sources; key by source+id
                key = f"{src.get('id')}::{pid}"
                if key in seen_ids:
                    continue
                seen_ids.add(key)
                packs.append(p)
        except Exception as e:
            errors.append({"sourceId": str(src.get("id") or ""), "error": str(e)})

    return {
        "schema": 1,
        "marketId": "merged",
        "packs": packs,
        "configured": True,
        "sources": [{"id": s["id"], "name": s["name"], "enabled": s.get("enabled", True)} for s in sources],
        "errors": errors,
        "defaultCatalog": DEFAULT_MARKET_CATALOG_URL,
    }
