"""53AI「前沿技术」列表抓取与解析（独立模块，供 ``web_search`` 的 ``news_53ai=latest`` 使用）。"""

from __future__ import annotations

import re
import urllib.parse
import urllib.request
from typing import Literal

WebNews53aiMode = Literal["off", "latest"]

# ``news_53ai=latest``：未显式传 max_results 时的默认条数与上限。
_DEFAULT_53AI_LIST_PAGES = 2
_DEFAULT_53AI_LIST_RESULTS = 24
_MAX_53AI_LIST_RESULTS = 50

_DEFAULT_53AI_LIST_URL = "https://www.53ai.com/news/qianyanjishu"


def qianyan_list_url(*, page: int) -> str:
    """前沿列表页 URL；``page<=1`` 无 query，否则 ``?page=N``。"""
    base = _DEFAULT_53AI_LIST_URL.rstrip("/")
    p = max(1, int(page))
    if p <= 1:
        return base
    return f"{base}?{urllib.parse.urlencode({'page': p})}"


# 测试与兼容：保留旧名
_53ai_qianyan_list_url = qianyan_list_url


_STATIC_ASSET_SUFFIX = re.compile(
    r"\.(png|jpe?g|gif|webp|svg|ico|bmp|woff2?|ttf|eot)(\?|#|$)",
    re.IGNORECASE,
)


def frontier_list_url_keep(url: str) -> bool:
    """丢弃 CDN 图 / 静态资源；保留主站文章链接。"""
    u = (url or "").strip()
    if not u.startswith("http"):
        return False
    if _STATIC_ASSET_SUFFIX.search(u):
        return False
    try:
        parsed = urllib.parse.urlparse(u)
    except Exception:
        return False
    host = (parsed.netloc or "").lower()
    path = (parsed.path or "").lower()
    if host.startswith("static."):
        return False
    if "/uploads/" in path:
        return False
    if "53ai.com" not in host:
        return False
    if path.rstrip("/").endswith("qianyanjishu"):
        return False
    return bool(path.strip("/"))


_53ai_frontier_list_url_keep = frontier_list_url_keep


def _strip_html_fragment(s: str) -> str:
    s = re.sub(r"<script[\s\S]*?</script>", " ", s, flags=re.I)
    s = re.sub(r"<style[\s\S]*?</style>", " ", s, flags=re.I)
    s = re.sub(r"<[^>]+>", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s


_53AI_QIANYAN_BLOCK_RE = re.compile(
    r'<a\s+href="(/news/[^"#\s]+\.html)"[^>]*>([\s\S]*?)</a>',
    re.IGNORECASE,
)
_53AI_QIANYAN_HTML_ARTICLE_RE = re.compile(
    r'<a\s+href="(/news/[^"#\s]+\.html)"[^>]*>\s*'
    r'<div\s+class="title"\s*>\s*<span>([^<]*)</span>',
    re.IGNORECASE | re.DOTALL,
)


def _parse_53ai_qianyan_anchor_inner(inner: str) -> tuple[str, str, str]:
    """列表卡片 inner HTML → (title, desc_plain, date_yyyy_mm_dd)。"""
    title = ""
    tit_m = re.search(r'<div\s+class="title"\s*>\s*<span>([^<]*)</span>', inner, re.I)
    if tit_m:
        raw_title = (tit_m.group(1) or "").strip()
        dm = re.search(r"发布日期：\s*([0-9]{4}-[0-9]{2}-[0-9]{2})", raw_title)
        if dm:
            dm.group(1)
        title = raw_title.split("发布日期：", 1)[0].strip() if "发布日期：" in raw_title else raw_title
    body = ""
    dm2 = re.search(r'<div\s+class="desc"\s*>([\s\S]*?)</div>', inner, re.I)
    if dm2:
        body = _strip_html_fragment(dm2.group(1) or "").strip()
    dpub = ""
    dtm = re.search(
        r'<div\s+class="release-date"[^>]*>[\s\S]*?<span>\s*(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})\s*</span>',
        inner,
        re.I,
    )
    if dtm:
        dpub = dtm.group(1).strip()[:10]
    elif not dpub and (dm3 := re.search(r"\d{4}-\d{2}-\d{2}", inner)):
        dpub = dm3.group(0)
    return title, body, dpub


def _http_get_53ai_qianyan_html(*, page: int = 1) -> str | None:
    list_url = qianyan_list_url(page=page)
    req = urllib.request.Request(
        list_url,
        headers={
            "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"),
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=22) as resp:
            raw = resp.read()
    except Exception:
        return None
    for enc in ("utf-8", "gbk"):
        try:
            return raw.decode(enc)
        except Exception:
            continue
    return raw.decode("utf-8", errors="replace")


def _parse_53ai_qianyan_list_html(html: str, *, max_results: int | None = None) -> list[dict]:
    base = "https://www.53ai.com"
    out: list[dict] = []
    seen: set[str] = set()

    def _push_row(path: str, title: str, body: str, dp: str) -> None:
        if not path or not title:
            return
        if "qianyanjishu" in path.lower():
            return
        url = urllib.parse.urljoin(base + "/", path)
        if not frontier_list_url_keep(url):
            return
        if url in seen:
            return
        seen.add(url)
        row: dict = {"title": title, "href": url, "body": body, "_engine": "53ai"}
        if dp:
            row["_datePublished"] = dp
        out.append(row)

    for m in _53AI_QIANYAN_BLOCK_RE.finditer(html):
        path = (m.group(1) or "").strip()
        inner = m.group(2) or ""
        t, b, dp = _parse_53ai_qianyan_anchor_inner(inner)
        _push_row(path, t, b, dp)
        if max_results is not None and len(out) >= max_results:
            return out

    if not out:
        for m in _53AI_QIANYAN_HTML_ARTICLE_RE.finditer(html):
            path = (m.group(1) or "").strip()
            raw_title = (m.group(2) or "").strip()
            if not path or not raw_title:
                continue
            dp = ""
            dm = re.search(r"发布日期：\s*([0-9]{4}-[0-9]{2}-[0-9]{2})", raw_title)
            if dm:
                dp = dm.group(1)
            title = raw_title.split("发布日期：", 1)[0].strip() if "发布日期：" in raw_title else raw_title
            _push_row(path, title, "", dp)
            if max_results is not None and len(out) >= max_results:
                break
    return out


def _fetch_53ai_list_results_from_markdown(md: str, *, query: str, max_results: int) -> list[dict]:
    q = (query or "").strip().lower()
    out: list[dict] = []
    seen: set[str] = set()

    for m in re.finditer(r"\[([^\]]+?)\]\((https?://[^)\s]+)\)", md):
        if m.start() > 0 and md[m.start() - 1] == "!":
            continue
        text = (m.group(1) or "").strip()
        url = (m.group(2) or "").strip()
        if not text or not url:
            continue
        if not frontier_list_url_keep(url):
            continue
        if url in seen:
            continue
        seen.add(url)

        dp = ""
        dm = re.search(r"发布日期：\s*([0-9]{4}-[0-9]{2}-[0-9]{2})", text)
        if dm:
            dp = dm.group(1)

        title = text
        if "发布日期：" in text:
            title = text.split("发布日期：", 1)[0].strip()
        if q:
            if q not in (title + " " + text).lower():
                pass

        out.append({"title": title, "href": url, "body": "", "_engine": "53ai", "_datePublished": dp})
        if len(out) >= max_results:
            break

    return out


def _fetch_53ai_list_results_from_pages_html(*, max_results: int) -> list[dict]:
    merged: list[dict] = []
    seen: set[str] = set()
    for page in range(1, _DEFAULT_53AI_LIST_PAGES + 1):
        html = _http_get_53ai_qianyan_html(page=page)
        if not html:
            continue
        for row in _parse_53ai_qianyan_list_html(html, max_results=None):
            href = str(row.get("href") or "").strip()
            if not href:
                continue
            key = href.split("#", 1)[0]
            if key in seen:
                continue
            seen.add(key)
            merged.append(row)
    return merged[:max_results]


def _fetch_53ai_list_results(*, query: str, max_results: int) -> list[dict]:
    max_results = max(1, min(int(max_results), _MAX_53AI_LIST_RESULTS))

    html_rows = _fetch_53ai_list_results_from_pages_html(max_results=max_results)
    if html_rows:
        return html_rows

    md_chunks: list[str] = []
    try:
        from evoflow.community.web_fetch import web_fetch_tool as _wf

        for page in range(1, _DEFAULT_53AI_LIST_PAGES + 1):
            try:
                chunk = str(
                    _wf.invoke(
                        {
                            "url": qianyan_list_url(page=page),
                            "extract": "full",
                            "max_length": 50000,
                            "timeout": 20,
                            "prefer_jina": False,
                        }
                    )
                )
                if chunk and isinstance(chunk, str):
                    md_chunks.append(chunk)
            except Exception:
                continue
    except Exception:
        pass

    md = "\n\n".join(md_chunks) if md_chunks else None

    if not md or not isinstance(md, str):
        return []

    return _fetch_53ai_list_results_from_markdown(md, query=query, max_results=max_results)


__all__ = [
    "WebNews53aiMode",
    "qianyan_list_url",
    "_53ai_qianyan_list_url",
    "frontier_list_url_keep",
    "_53ai_frontier_list_url_keep",
    "_DEFAULT_53AI_LIST_PAGES",
    "_DEFAULT_53AI_LIST_RESULTS",
    "_MAX_53AI_LIST_RESULTS",
    "_http_get_53ai_qianyan_html",
    "_parse_53ai_qianyan_list_html",
    "_fetch_53ai_list_results_from_pages_html",
    "_fetch_53ai_list_results",
]
