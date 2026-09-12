"""
Web Search Tool — Hermes-style pluggable backends + EvoFlow AI modes.

设计约定：
- 泛搜走 Hermes 同款 provider 注册表（Tavily / InfoQuest / Firecrawl / SearXNG / Brave / DDGS）。
- AI 日报走厂商 RSS；53AI 前沿走站点列表接口。
"""

from __future__ import annotations

import json
import logging
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from typing import Literal

from langchain_core.tools import tool

from evoflow.tools.minimal_schema import WEB_SEARCH_DESCRIPTION

from .news_53ai_frontier import (
    _DEFAULT_53AI_LIST_RESULTS,
    _MAX_53AI_LIST_RESULTS,
    WebNews53aiMode,
    _fetch_53ai_list_results,
)
from .official_ai_news import (
    _fetch_official_ai_news_rows,
    authoritative_official_news_index,
    rebalance_ai_daily_rows,
)

try:
    from evoflow.config import get_app_config  # type: ignore
except Exception:  # pragma: no cover
    get_app_config = None

logger = logging.getLogger(__name__)

WebAiDailyMode = Literal["off", "auto"]

_DEFAULT_WEB_SEARCH_RESULTS = 30
_MAX_WEB_SEARCH_RESULTS = 50
_DEFAULT_WEB_SEARCH_CONTENT_CHARS = 1200
_UNSUPPORTED_ENGINES = frozenset({"baidu", "bing", "sogou"})


def _looks_like_ai_news_query(q: str) -> bool:
    q = (q or "").strip().lower()
    if not q:
        return False
    ai_terms = ["ai", "人工智能", "大模型", "llm", "模型", "agent", "智能体"]
    intent_terms = ["今天", "今日", "最新", "早报", "快报", "热点", "新闻", "资讯", "动态"]
    return any(t in q for t in ai_terms) and any(t in q for t in intent_terms)


def _looks_like_ai_topic_query(q: str) -> bool:
    ql = (q or "").strip().lower()
    if not ql:
        return False
    terms = [
        "ai",
        "人工智能",
        "大模型",
        "llm",
        "智能体",
        "chatgpt",
        "openai",
        "anthropic",
        "claude",
        "copilot",
        "grok",
        "kimi",
        "deepseek",
        "豆包",
        "元宝",
        "manus",
        "meta",
    ]
    return any(t in ql for t in terms)


def _normalize_news_query(query: str) -> str:
    """Rewrite ambiguous AI-news queries to reduce off-topic results."""
    q = (query or "").strip()
    if not q:
        return ""
    if not _looks_like_ai_news_query(q):
        return q

    dt = datetime.now()
    today = f"{dt.month}月{dt.day}日"
    neg = "-歌词 -歌曲 -刘德华 -杂志 -万年历 -黄道吉日 -两会 -政府工作报告 -百度百科 -百科"

    if "人工智能" not in q and "大模型" not in q and "llm" not in q.lower():
        q = q.replace("AI", "AI 人工智能 大模型 LLM")

    if "新闻" not in q and "资讯" not in q and "早报" not in q:
        q = q + " 新闻"
    if any(k in q for k in ["今天", "今日", "最新", "早报", "快报", "热点"]):
        q = q.replace("今天", "").replace("今日", "").strip()
        q = f"{q} {today}".strip()
    return f"{q} {neg}".strip()


def _clamp_results(n: int) -> int:
    return max(1, min(int(n), _MAX_WEB_SEARCH_RESULTS))


def _dedupe_results_by_url(rows: list[dict]) -> list[dict]:
    """Stable dedupe by normalized URL (fragment stripped)."""
    seen: set[str] = set()
    out: list[dict] = []
    for r in rows:
        href = str(r.get("href") or r.get("link") or r.get("url") or "").strip()
        if not href:
            continue
        key = href.split("#", 1)[0]
        if key in seen:
            continue
        seen.add(key)
        out.append(r)
    return out


def _ensure_non_empty_content(query: str, title: str, url: str, content: str) -> str:
    c = (content or "").strip()
    if c:
        return c
    t = (title or "").strip()
    u = (url or "").strip()
    if t and u:
        return f"{t}（来源：{u}）。检索关键词：{query}。"
    if t:
        return f"{t}。检索关键词：{query}。"
    if u:
        return f"来源：{u}。检索关键词：{query}。"
    return f"与“{query}”相关的搜索结果，正文暂未提取成功。"


def _api_licensed_search(
    query: str,
    max_results: int,
    *,
    preferred: list[str] | None = None,
) -> list[dict]:
    """Hermes-style provider dispatch with failover (shared with settings test)."""
    q = (query or "").strip()
    if not q:
        return []

    from evoflow.community.web.registry import (
        _AUTO_PREFERENCE,
        get_provider,
        list_providers,
        resolve_search_backend,
        run_provider_search,
    )

    preferred_backend = resolve_search_backend()
    # Extra failover from tool YAML (preferred_engines); Settings preferred always wins first.
    call_engines = [str(x).strip().lower() for x in (preferred or []) if str(x).strip()]

    logger.info(
        "[联网搜索] 开始查询 query=%r max_results=%s 设置首选=%s",
        q,
        max_results,
        preferred_backend or "（自动）",
    )

    candidates: list = []
    seen: set[str] = set()

    def _add(name: str | None) -> None:
        n = str(name or "").strip().lower()
        if not n or n in seen:
            return
        if n in _UNSUPPORTED_ENGINES:
            logger.debug("Skipping unsupported engine %r", n)
            return
        if n in {"ddg", "duckduckgo"}:
            n = "ddgs"
        prov = get_provider(n)
        if prov is None or not prov.supports_search():
            return
        seen.add(n)
        candidates.append(prov)

    # 1) Settings preferred always first
    _add(preferred_backend)
    # 2) YAML preferred_engines as extra failover only
    for name in call_engines:
        _add(name)
    # 3) Auto failover chain
    for name in _AUTO_PREFERENCE:
        _add(name)
    for prov in list_providers():
        if prov.is_available():
            _add(prov.name)

    # Skip backends that advertise available=False unless settings-preferred or YAML-listed
    explicit = set(call_engines)
    resolved = str(preferred_backend or "")
    last_error = ""
    tried: list[str] = []

    logger.info(
        "[联网搜索] 候选渠道(按优先级)=%s",
        [getattr(p, "name", "?") for p in candidates] or "（无）",
    )

    for prov in candidates:
        if not prov.is_available() and prov.name not in explicit and prov.name not in {resolved}:
            logger.info("[联网搜索] 跳过未配置渠道 channel=%s", prov.name)
            continue
        tried.append(prov.name)
        logger.info("[联网搜索] 正在请求渠道 channel=%s …", prov.name)
        payload = run_provider_search(prov.name, q, limit=max_results)
        if not isinstance(payload, dict):
            last_error = f"{prov.name} returned non-dict"
            logger.info("[联网搜索] 渠道返回格式异常 channel=%s", prov.name)
            continue
        if not payload.get("success"):
            last_error = str(payload.get("error") or f"{prov.name} returned success=false")
            logger.info("[联网搜索] 渠道失败 channel=%s err=%s", prov.name, last_error)
            continue
        web = ((payload.get("data") or {}).get("web")) or []
        out: list[dict] = []
        for r in web:
            if not isinstance(r, dict):
                continue
            out.append(
                {
                    "title": str(r.get("title") or "").strip(),
                    "href": str(r.get("url") or r.get("href") or "").strip(),
                    "body": str(r.get("description") or r.get("body") or r.get("snippet") or "").strip(),
                    "_engine": prov.name,
                }
            )
        if out:
            deduped = _dedupe_results_by_url(out)[:max_results]
            sample = [str(x.get("title") or "")[:40] for x in deduped[:3]]
            logger.info(
                "[联网搜索] 成功 channel=%s 条数=%s 样例标题=%s",
                prov.name,
                len(deduped),
                sample,
            )
            return deduped
        last_error = f"{prov.name} returned empty results"
        logger.info("[联网搜索] 渠道空结果 channel=%s，尝试下一个", prov.name)

    logger.warning(
        "[联网搜索] 全部失败 query=%r 已尝试=%s last_error=%s",
        q,
        tried or "（无可用渠道）",
        last_error or "（无）",
    )
    return []

@tool("web_search", description=WEB_SEARCH_DESCRIPTION, parse_docstring=False)
def web_search_tool(
    query: str,
    max_results: int | None = None,
    *,
    ai_daily: WebAiDailyMode = "off",
    news_53ai: WebNews53aiMode = "off",
) -> str:
    """Search the web."""
    # Page-fetch knobs are config-only (YAML default_fetch_pages); not model-facing — model often
    # sets fetch_pages>0 and burns 10–30s fetching URLs after search already succeeded.
    fetch_pages = 0
    fetch_extract = "main-content"
    fetch_timeout = 15
    fetch_max_length = 30000

    web_search_config = None
    cfg_max_results: int | None = None
    if get_app_config is not None:
        try:
            web_search_config = get_app_config().get_tool_config("web_search")
            if web_search_config is not None and "max_results" in web_search_config.model_extra:
                cfg_max_results = int(web_search_config.model_extra.get("max_results", _DEFAULT_WEB_SEARCH_RESULTS))
        except Exception:
            pass

    if max_results is None:
        max_results = cfg_max_results if cfg_max_results is not None else _DEFAULT_WEB_SEARCH_RESULTS

    ai_daily_effective: WebAiDailyMode = "auto" if str(ai_daily or "").strip().lower() == "auto" else "off"
    news_53ai_effective: WebNews53aiMode = "latest" if str(news_53ai or "").strip().lower() == "latest" else "off"

    if news_53ai_effective == "latest":
        if max_results == _DEFAULT_WEB_SEARCH_RESULTS:
            max_results = _DEFAULT_53AI_LIST_RESULTS
        max_results = max(1, min(int(max_results), _MAX_53AI_LIST_RESULTS))
    else:
        max_results = _clamp_results(max_results)
    max_content_chars = _DEFAULT_WEB_SEARCH_CONTENT_CHARS
    preferred_providers: list[str] = []
    enable_query_rewrite = True
    prefer_official_ai_sources = True
    tier1_min_results = 3
    if web_search_config is not None:
        try:
            extra = web_search_config.model_extra or {}
            if "max_content_chars" in extra:
                max_content_chars = max(200, min(int(extra.get("max_content_chars", max_content_chars)), 5000))
            if "default_fetch_pages" in extra:
                fetch_pages = int(extra.get("default_fetch_pages", fetch_pages))
            if "fetch_extract" in extra:
                fetch_extract = str(extra.get("fetch_extract", fetch_extract) or fetch_extract)
            if "fetch_timeout" in extra:
                fetch_timeout = int(extra.get("fetch_timeout", fetch_timeout))
            if "fetch_max_length" in extra:
                fetch_max_length = int(extra.get("fetch_max_length", fetch_max_length))
            if "preferred_engines" in extra:
                cfg_engines = extra.get("preferred_engines")
                if isinstance(cfg_engines, list):
                    preferred_providers = [str(x).strip().lower() for x in cfg_engines if str(x).strip()]
            if "provider" in extra and str(extra.get("provider") or "").strip():
                preferred_providers = [str(extra.get("provider")).strip().lower()] + preferred_providers
            if "tier1_min_results" in extra:
                tier1_min_results = max(1, min(int(extra.get("tier1_min_results", tier1_min_results)), max_results))
            if "enable_query_rewrite" in extra:
                enable_query_rewrite = bool(extra.get("enable_query_rewrite"))
            if "prefer_official_ai_sources" in extra:
                prefer_official_ai_sources = bool(extra.get("prefer_official_ai_sources"))
        except Exception:
            pass

    try:
        fetch_pages = max(0, int(fetch_pages))
    except Exception:
        fetch_pages = 0
    fetch_pages = min(fetch_pages, max_results)
    if news_53ai_effective == "latest":
        fetch_pages = 0
    fetch_extract = str(fetch_extract or "main-content").strip() or "main-content"
    if fetch_extract not in {"full", "main-content", "text"}:
        fetch_extract = "main-content"
    try:
        fetch_timeout = max(3, min(int(fetch_timeout), 60))
    except Exception:
        fetch_timeout = 15
    try:
        fetch_max_length = max(1000, min(int(fetch_max_length), 50000))
    except Exception:
        fetch_max_length = 30000

    if ai_daily_effective == "auto":
        query_used = _normalize_news_query(query)
    else:
        query_used = _normalize_news_query(query) if enable_query_rewrite else (query or "").strip()

    if news_53ai_effective == "latest":
        logger.info("[联网搜索] 模式=53AI前沿列表 query=%r", query)
        merged_fast = _dedupe_results_by_url(_fetch_53ai_list_results(query=query, max_results=max_results))
    else:
        merged_fast: list[dict] = []
        if "site:" not in query_used and (ai_daily_effective == "auto" or _looks_like_ai_topic_query(query_used)):
            if prefer_official_ai_sources and ai_daily_effective == "auto":
                logger.info("[联网搜索] 模式=AI日报/官方源优先 query=%r", query_used)
                merged_fast = list(_fetch_official_ai_news_rows(query=query_used, max_results=max_results))
            if not merged_fast:
                merged_fast = _api_licensed_search(query_used, max_results, preferred=preferred_providers)
            elif ai_daily_effective == "auto" and len(merged_fast) < tier1_min_results:
                merged_fast = merged_fast + _api_licensed_search(query_used, max_results, preferred=preferred_providers)
        else:
            logger.info("[联网搜索] 模式=泛搜 query=%r", query_used)
            merged_fast = _api_licensed_search(query_used, max_results, preferred=preferred_providers)

    if merged_fast and ai_daily_effective == "auto" and news_53ai_effective != "latest":
        merged_fast = rebalance_ai_daily_rows(merged_fast, max_results=max_results, max_per_topic=2)

    if merged_fast:
        engines_used = sorted({str(x.get("_engine") or "") for x in merged_fast if str(x.get("_engine") or "").strip()})
        logger.info(
            "[联网搜索] 搜索完成 total=%s channels=%s fetch_pages=%s",
            min(len(merged_fast), max_results),
            engines_used or ["（无渠道标记）"],
            fetch_pages,
        )
        normalized_results = []
        for r in merged_fast[:max_results]:
            title = str(r.get("title", "") or "").strip()
            url = str(r.get("href", r.get("link", r.get("url", ""))) or "").strip()
            raw_content = str(r.get("body", r.get("snippet", "")) or "").strip()
            content_val = (
                raw_content[:max_content_chars]
                if raw_content
                else _ensure_non_empty_content(query=query, title=title, url=url, content=raw_content)[:max_content_chars]
            )
            eng = str(r.get("_engine") or "").strip()
            row_out: dict = {
                "title": title,
                "url": url,
                "content": content_val,
            }
            if eng:
                row_out["_engine"] = eng
            if raw_content:
                row_out["_snippet"] = raw_content
            tv = str(r.get("_topic") or "").strip()
            if tv:
                row_out["_topic"] = tv
            dv = str(r.get("_datePublished") or "").strip()
            if dv:
                row_out["_datePublished"] = dv
            normalized_results.append(row_out)

        if fetch_pages > 0:
            logger.info("[联网搜索] 开始抓取正文 fetch_pages=%s（YAML default_fetch_pages）", fetch_pages)
            try:
                from evoflow.community.web_fetch import web_fetch_tool as _fetch_url  # lazy import

                def _fetch_one(u: str) -> str:
                    try:
                        return str(
                            _fetch_url(
                                url=u,
                                extract=fetch_extract,  # type: ignore[arg-type]
                                max_length=fetch_max_length,
                                timeout=fetch_timeout,
                                prefer_jina=False,
                            )
                        )
                    except TypeError:
                        return str(
                            _fetch_url.invoke(
                                {
                                    "url": u,
                                    "extract": fetch_extract,
                                    "max_length": fetch_max_length,
                                    "timeout": fetch_timeout,
                                    "prefer_jina": False,
                                }
                            )
                        )

                with ThreadPoolExecutor(max_workers=min(4, fetch_pages)) as ex:
                    futs = {}
                    for idx in range(min(fetch_pages, len(normalized_results))):
                        u = str(normalized_results[idx].get("url") or "").strip()
                        if not u:
                            continue
                        futs[ex.submit(_fetch_one, u)] = idx

                    for fut in as_completed(futs):
                        idx = futs[fut]
                        try:
                            body = str(fut.result() or "").strip()
                        except Exception:
                            body = ""
                        if not body or body.lower().startswith("error:"):
                            normalized_results[idx]["_page_fetch_error"] = (body or "Error: fetch failed")[:500]
                            continue
                        normalized_results[idx]["content"] = body[: max(fetch_max_length, max_content_chars)]
                        normalized_results[idx]["_page_fetched"] = True
                        normalized_results[idx]["_page_extract"] = fetch_extract
            except Exception as e:
                for r in normalized_results[: min(fetch_pages, len(normalized_results))]:
                    r["_page_fetch_error"] = f"Error: fetch initialization failed: {e}"[:500]

        logger.info(
            "[联网搜索] 工具返回成功 total=%s channels=%s",
            len(normalized_results),
            engines_used or ["（无渠道标记）"],
        )
        out_payload: dict = {
            "query": query,
            "total_results": len(normalized_results),
            "engines": sorted({str(x.get("_engine") or "") for x in merged_fast if str(x.get("_engine") or "").strip()}),
            "results": normalized_results,
            "_engine_version": "EvoFlowProviderSearch",
            "ai_daily": ai_daily_effective,
            "news_53ai": news_53ai_effective,
        }
        if ai_daily_effective == "auto":
            out_payload["_official_news_index"] = authoritative_official_news_index()
        if news_53ai_effective == "latest":
            out_payload["_list_level_only"] = True
            out_payload["_body_fetch_hint"] = (
                "仅列表级摘要；若需某条全文请根据标题与任务判断是否必要，再对该条 url 单独调用 web_fetch。"
            )
        return json.dumps(out_payload, ensure_ascii=False)

    if news_53ai_effective == "latest":
        logger.warning("[联网搜索] 无结果 模式=53AI列表 query=%r", query)
        return json.dumps(
            {
                "query": query,
                "total_results": 0,
                "engines": [],
                "results": [],
                "_note": "53AI 前沿列表未解析到条目；此模式不启用泛搜/深度兜底。",
                "ai_daily": ai_daily_effective,
                "news_53ai": news_53ai_effective,
            },
            ensure_ascii=False,
        )

    logger.warning("[联网搜索] 无结果 query=%r（见上方渠道尝试日志）", query)
    return json.dumps(
        {
            "query": query,
            "total_results": 0,
            "engines": [],
            "results": [],
            "_note": (
                "No results: open Settings → 联网搜索, set preferred engine + API key "
                "(豆包搜索 / Tavily / Brave / Firecrawl / SearXNG), or install ddgs for free fallback. "
                "Baidu/Bing/Sogou HTML scraping has been removed."
            ),
            "ai_daily": ai_daily_effective,
            "news_53ai": news_53ai_effective,
        },
        ensure_ascii=False,
    )
