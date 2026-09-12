"""大厂 / 头部实验室 **官网资讯入口** 与可用的 **RSS/Atom**（供 ``ai_daily=auto`` 优先拉取）。

``news_home`` 优先选用 **产品 / 开放平台 / 更新日志** 等仍在维护的入口（避免旧版营销落地页）；无稳定 RSS 的条目仅提供 ``news_home``，由模型按需再调 ``web_fetch``。
"""

from __future__ import annotations

import re
import urllib.request
import xml.etree.ElementTree as ET
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any
from urllib.parse import urlparse

# id, 展示名, 权威资讯首页, 可选 RSS/Atom（首屏并行拉取）, 命中 query 的关键词（小写）
OFFICIAL_AI_NEWS_SOURCES: list[dict[str, Any]] = [
    {
        "id": "openai",
        "name": "OpenAI",
        "news_home": "https://openai.com/zh-Hans-CN/research/index/",
        "feed": "https://openai.com/blog/rss.xml",
        "match": ("openai", "gpt-4", "gpt4", "chatgpt", "sora", "dall-e", "o3", "o1"),
    },
    {
        "id": "anthropic",
        "name": "Anthropic (Claude)",
        "news_home": "https://www.anthropic.com/news",
        "feed": None,
        "match": ("anthropic", "claude", "claude 3", "claude 4", "sonnet", "opus", "haiku"),
    },
    {
        "id": "cursor",
        "name": "Cursor",
        "news_home": "https://cursor.com/changelog",
        "feed": None,
        "match": ("cursor",),
    },
    {
        "id": "google_ai",
        "name": "Google (The Keyword · AI)",
        "news_home": "https://blog.google/technology/ai/",
        "feed": "https://blog.google/technology/ai/rss/",
        "match": ("google", "gemini", "bard", "deepmind", "google ai"),
    },
    {
        "id": "google_deepmind",
        "name": "Google DeepMind",
        "news_home": "https://deepmind.google/blog/",
        "feed": "https://deepmind.google/blog/rss.xml",
        "match": ("deepmind",),
    },
    {
        "id": "meta_ai",
        "name": "Meta AI",
        "news_home": "https://ai.meta.com/blog/",
        "feed": "https://ai.meta.com/blog/?feed=rss2",
        "match": ("meta", "llama", "facebook ai"),
    },
    {
        "id": "microsoft_ai",
        "name": "Microsoft AI",
        "news_home": "https://blogs.microsoft.com/ai/",
        "feed": "https://blogs.microsoft.com/ai/feed/",
        "match": ("microsoft", "copilot", "azure openai"),
    },
    {
        "id": "nvidia",
        "name": "NVIDIA Blog",
        "news_home": "https://blogs.nvidia.com/blog/category/generative-ai/",
        "feed": "https://blogs.nvidia.com/blog/feed/",
        "match": ("nvidia", "cuda", "tensorrt"),
    },
    {
        "id": "aws_ml",
        "name": "AWS Machine Learning Blog",
        "news_home": "https://aws.amazon.com/blogs/machine-learning/",
        "feed": "https://aws.amazon.com/blogs/machine-learning/feed/",
        "match": ("aws", "amazon bedrock", "sagemaker"),
    },
    {
        "id": "huggingface",
        "name": "Hugging Face",
        "news_home": "https://huggingface.co/blog",
        "feed": "https://huggingface.co/blog/feed.xml",
        "match": ("hugging", "hf ", "transformers", "datasets"),
    },
    {
        "id": "mistral",
        "name": "Mistral AI",
        "news_home": "https://mistral.ai/news",
        "feed": None,
        "match": ("mistral",),
    },
    {
        "id": "cohere",
        "name": "Cohere",
        "news_home": "https://cohere.com/blog",
        "feed": None,
        "match": ("cohere",),
    },
    {
        "id": "xai",
        "name": "xAI",
        "news_home": "https://x.ai/news",
        "feed": None,
        "match": ("xai", "grok"),
    },
    {
        "id": "apple_ml",
        "name": "Apple Machine Learning Research",
        "news_home": "https://machinelearning.apple.com/",
        "feed": None,
        "match": ("apple", "mlx", "apple intelligence"),
    },
    {
        "id": "deepseek",
        "name": "DeepSeek",
        "news_home": "https://api-docs.deepseek.com/zh-cn/updates",
        "feed": None,
        "match": ("deepseek",),
    },
    {
        "id": "moonshot",
        "name": "Moonshot AI (Kimi)",
        "news_home": "https://platform.kimi.ai/",
        "feed": None,
        "match": ("kimi", "moonshot", "月之暗面"),
    },
    {
        "id": "zhipu",
        "name": "智谱 AI",
        "news_home": "https://docs.bigmodel.cn/cn/guide/start/introduction",
        "feed": None,
        "match": ("智谱", "glm", "chatglm", "zhipu", "bigmodel"),
    },
    {
        "id": "bytedance_volc",
        "name": "火山引擎 · 豆包",
        "news_home": "https://www.volcengine.com/product/doubao",
        "feed": None,
        "match": ("豆包", "火山", "volcengine", "字节"),
    },
    {
        "id": "tencent_hunyuan",
        "name": "腾讯混元",
        "news_home": "https://cloud.tencent.com/product/hunyuan",
        "feed": None,
        "match": ("腾讯", "混元", "hunyuan"),
    },
    {
        "id": "alibaba_tongyi",
        "name": "阿里云百炼 · 通义",
        "news_home": "https://www.aliyun.com/product/bailian",
        "feed": None,
        "match": ("通义", "qwen", "tongyi", "阿里云百炼", "百炼", "bailian", "千问", "灵积"),
    },
    {
        "id": "baidu_qianfan",
        "name": "百度千帆（文心）",
        "news_home": "https://qianfan.baidu.com/",
        "feed": None,
        "match": ("文心", "ernie", "千帆", "qianfan", "百度智能云千帆"),
    },
    {
        "id": "baidu_paddle",
        "name": "百度飞桨",
        "news_home": "https://www.paddlepaddle.org.cn/",
        "feed": None,
        "match": ("飞桨", "paddlepaddle", "paddle"),
    },
    {
        "id": "groq",
        "name": "Groq",
        "news_home": "https://groq.com/blog",
        "feed": None,
        "match": ("groq",),
    },
    {
        "id": "perplexity",
        "name": "Perplexity",
        "news_home": "https://www.perplexity.ai/",
        "feed": None,
        "match": ("perplexity",),
    },
    {
        "id": "replicate",
        "name": "Replicate",
        "news_home": "https://replicate.com/blog",
        "feed": None,
        "match": ("replicate",),
    },
    {
        "id": "together_ai",
        "name": "Together AI",
        "news_home": "https://www.together.ai/blog",
        "feed": None,
        "match": ("together.ai", "together ai"),
    },
    {
        "id": "runway",
        "name": "Runway",
        "news_home": "https://runwayml.com/news",
        "feed": None,
        "match": ("runway", "runwayml"),
    },
    {
        "id": "elevenlabs",
        "name": "ElevenLabs",
        "news_home": "https://elevenlabs.io/blog",
        "feed": None,
        "match": ("elevenlabs", "eleven labs"),
    },
    {
        "id": "openrouter",
        "name": "OpenRouter",
        "news_home": "https://openrouter.ai/",
        "feed": None,
        "match": ("openrouter",),
    },
]


def authoritative_official_news_index() -> list[dict[str, str]]:
    """供 JSON 附带：厂商中文名 + 官网资讯入口（无 RSS 的同样列出）。"""
    return [{"vendor": str(s["name"]), "news_home": str(s["news_home"])} for s in OFFICIAL_AI_NEWS_SOURCES]


def _tag_local(tag: str) -> str:
    if "}" in tag:
        return tag.rsplit("}", 1)[-1]
    return tag


def _elem_text(el: ET.Element | None) -> str:
    if el is None:
        return ""
    return re.sub(r"\s+", " ", "".join(el.itertext()).strip())


def parse_feed_entries(xml: str, *, max_items: int = 10) -> list[tuple[str, str, str]]:
    """解析 RSS 2.0 或 Atom，返回 ``(title, link, description)``。"""
    xml = (xml or "").strip()
    if not xml.startswith("<"):
        return []
    try:
        root = ET.fromstring(xml)
    except ET.ParseError:
        return []
    rl = _tag_local(root.tag)
    if rl == "rss":
        for ch in root:
            if _tag_local(ch.tag) == "channel":
                return _parse_rss_channel(ch, max_items=max_items)
        return []
    if rl == "feed":
        return _parse_atom_feed(root, max_items=max_items)
    return []


def _parse_rss_channel(channel: ET.Element, *, max_items: int) -> list[tuple[str, str, str]]:
    out: list[tuple[str, str, str]] = []
    for child in channel:
        if _tag_local(child.tag) != "item":
            continue
        title = ""
        link = ""
        desc = ""
        for c in child:
            ln = _tag_local(c.tag)
            if ln == "title":
                title = _elem_text(c)
            elif ln == "link":
                link = (_elem_text(c) or (c.get("href") or "")).strip()
            elif ln == "guid" and not link:
                g = _elem_text(c)
                if g.startswith("http"):
                    link = g
            elif ln == "description":
                desc = _elem_text(c) or desc
            elif "encoded" in ln.lower() and "content" in ln.lower():
                desc = _elem_text(c) or desc
        if title and link.startswith("http"):
            out.append((title, link, desc[:1200]))
            if len(out) >= max_items:
                break
    return out


def _parse_atom_feed(feed_el: ET.Element, *, max_items: int) -> list[tuple[str, str, str]]:
    out: list[tuple[str, str, str]] = []
    for entry in feed_el:
        if _tag_local(entry.tag) != "entry":
            continue
        title = ""
        link = ""
        summary = ""
        for c in entry:
            ln = _tag_local(c.tag)
            if ln == "title":
                title = _elem_text(c)
            elif ln == "link":
                href = (c.get("href") or "").strip()
                rel = (c.get("rel") or "alternate").lower()
                if href and rel in ("alternate", "self"):
                    link = href
            elif ln == "id" and not link:
                tid = _elem_text(c)
                if tid.startswith("http"):
                    link = tid
            elif ln in ("summary", "content"):
                summary = _elem_text(c) or summary
        if title and link.startswith("http"):
            out.append((title, link, summary[:1200]))
            if len(out) >= max_items:
                break
    return out


def _http_get_text(url: str, *, timeout: float = 12.0) -> str | None:
    headers = {
        "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36"),
        "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml, */*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.7",
    }
    try:
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.read().decode("utf-8", errors="ignore")
    except Exception:
        return None


def _vendor_ids_from_query(query: str) -> list[str] | None:
    """命中关键词则只拉对应厂商 feed；否则 ``None`` 表示广撒网前若干有 feed 的源。"""
    q = (query or "").strip().lower()
    if not q:
        return None
    hit_ids: list[str] = []
    for src in OFFICIAL_AI_NEWS_SOURCES:
        for kw in src.get("match") or ():
            if str(kw).lower() in q:
                hit_ids.append(str(src["id"]))
                break
    if not hit_ids:
        return None
    seen: set[str] = set()
    ordered: list[str] = []
    for src in OFFICIAL_AI_NEWS_SOURCES:
        sid = str(src["id"])
        if sid in hit_ids and sid not in seen:
            seen.add(sid)
            ordered.append(sid)
    return ordered


def _sources_for_query(query: str, *, breadth: int = 14) -> list[dict[str, Any]]:
    ids = _vendor_ids_from_query(query)
    with_feed = [s for s in OFFICIAL_AI_NEWS_SOURCES if s.get("feed")]
    if ids is None:
        return with_feed[:breadth]
    picked = [s for s in OFFICIAL_AI_NEWS_SOURCES if s["id"] in ids and s.get("feed")]
    return picked if picked else with_feed[:breadth]


def _fetch_one_source(src: dict[str, Any], *, per_feed: int) -> list[dict[str, Any]]:
    feed = src.get("feed")
    if not feed:
        return []
    xml = _http_get_text(str(feed), timeout=12.0)
    if not xml:
        return []
    rows: list[dict[str, Any]] = []
    for title, link, desc in parse_feed_entries(xml, max_items=per_feed):
        if not title or not link.startswith("http"):
            continue
        rows.append(
            {
                "title": title,
                "href": link,
                "body": desc,
                "_engine": "official",
                "_topic": str(src["name"]),
            }
        )
    return rows


def _round_robin_merge(batches: list[list[dict[str, Any]]], *, max_results: int) -> list[dict[str, Any]]:
    merged: list[dict[str, Any]] = []
    i = 0
    while len(merged) < max_results:
        progressed = False
        for batch in batches:
            if i < len(batch):
                merged.append(batch[i])
                progressed = True
                if len(merged) >= max_results:
                    break
        if not progressed:
            break
        i += 1
    return merged


def rebalance_ai_daily_rows(
    rows: list[dict[str, Any]],
    *,
    max_results: int,
    max_per_topic: int = 2,
) -> list[dict[str, Any]]:
    """按 ``OFFICIAL_AI_NEWS_SOURCES`` 的厂商顺序轮转：每家先占 1 条，再占第 2 条，避免前几席被同一 `_topic` 塞满。

    无 ``_topic`` 的（如泛搜 Bing）按 ``url`` 主机名分桶，同样受 ``max_per_topic`` 约束。
    """
    max_results = max(1, min(int(max_results), 50))
    max_per_topic = max(1, min(int(max_per_topic), 5))

    def topic_key(r: dict[str, Any]) -> str:
        tv = str(r.get("_topic") or "").strip()
        if tv:
            return tv
        u = str(r.get("href", r.get("link", r.get("url", ""))) or "").strip()
        try:
            h = urlparse(u).netloc.lower()
        except Exception:
            h = ""
        return h or "_"

    buckets: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for r in rows:
        buckets[topic_key(r)].append(r)

    vendor_names_ordered = [str(s["name"]) for s in OFFICIAL_AI_NEWS_SOURCES]
    order = [n for n in vendor_names_ordered if n in buckets]
    for t in list(buckets.keys()):
        if t not in order:
            order.append(t)

    out: list[dict[str, Any]] = []
    for rnd in range(max_per_topic):
        for t in order:
            if len(out) >= max_results:
                return out
            lst = buckets.get(t) or []
            if rnd < len(lst):
                out.append(lst[rnd])
    return out


def _fetch_official_ai_news_rows(*, query: str, max_results: int) -> list[dict[str, Any]]:
    """并行拉取若干官方 RSS：先多拉一些再 ``rebalance``，保证前几条尽量「一家一条」。"""
    max_results = max(1, min(int(max_results), 50))
    sources = _sources_for_query(query, breadth=14)
    if not sources:
        return []
    fetch_budget = min(48, max(max_results * 6, 24))
    per_feed = max(2, min(8, fetch_budget // max(1, len(sources)) + 2))

    max_workers = min(8, len(sources))
    with ThreadPoolExecutor(max_workers=max_workers) as ex:
        futs = {ex.submit(_fetch_one_source, s, per_feed=per_feed): i for i, s in enumerate(sources)}
        by_idx: dict[int, list[dict[str, Any]]] = {}
        for fut in as_completed(futs):
            idx = futs[fut]
            try:
                by_idx[idx] = fut.result() or []
            except Exception:
                by_idx[idx] = []
        batches = [by_idx.get(i, []) for i in range(len(sources))]

    pooled = _round_robin_merge(batches, max_results=fetch_budget)
    return rebalance_ai_daily_rows(pooled, max_results=max_results, max_per_topic=2)


__all__ = [
    "OFFICIAL_AI_NEWS_SOURCES",
    "authoritative_official_news_index",
    "parse_feed_entries",
    "rebalance_ai_daily_rows",
    "_fetch_official_ai_news_rows",
]
