"""``web_search`` 的 ``ai_daily`` / ``news_53ai``：schema 校验与 invoke（网络层 mock）。"""

import json
from unittest.mock import patch

from evoflow.community.baidu_search import WebAiDailyMode, WebNews53aiMode, web_search_tool
from evoflow.community.baidu_search.news_53ai_frontier import (
    _53ai_qianyan_list_url,
    _fetch_53ai_list_results_from_pages_html,
    _parse_53ai_qianyan_list_html,
)
from evoflow.community.baidu_search.official_ai_news import (
    authoritative_official_news_index,
    parse_feed_entries,
    rebalance_ai_daily_rows,
)


class TestWebSearchAiDailyAnd53ai:
    """``ai_daily`` / ``news_53ai`` 工具 schema 与 ``web_search_tool.invoke`` 行为。"""

    def test_53ai_qianyan_list_url_page2_has_query(self) -> None:
        assert _53ai_qianyan_list_url(page=1) == "https://www.53ai.com/news/qianyanjishu"
        assert "page=2" in _53ai_qianyan_list_url(page=2)

    @patch("evoflow.community.baidu_search.news_53ai_frontier._http_get_53ai_qianyan_html")
    def test_fetch_53ai_merges_two_list_pages(self, mock_get) -> None:
        mock_get.side_effect = [
            '<a href="/news/LargeLanguageModel/a.html"><div class="title"><span>T1</span></div></a>',
            '<a href="/news/LargeLanguageModel/b.html"><div class="title"><span>T2</span></div></a>',
        ]
        rows = _fetch_53ai_list_results_from_pages_html(max_results=24)
        assert len(rows) == 2
        assert {r["title"] for r in rows} == {"T1", "T2"}
        assert mock_get.call_count == 2
        assert mock_get.call_args_list[0].kwargs.get("page") == 1
        assert mock_get.call_args_list[1].kwargs.get("page") == 2

    def test_parse_53ai_qianyan_html_article_links(self) -> None:
        html = '<li><a href="/news/LargeLanguageModel/2026050645730.html"><div class="title"><span>标题A 发布日期：2025-05-06</span></div></a></li><a href="/news/qianyanjishu"><div class="title"><span>skip</span></div></a>'
        rows = _parse_53ai_qianyan_list_html(html, max_results=5)
        assert len(rows) == 1
        assert rows[0]["title"] == "标题A"
        assert rows[0]["_datePublished"] == "2025-05-06"
        assert rows[0]["href"].endswith("/news/LargeLanguageModel/2026050645730.html")

    def test_parse_53ai_qianyan_html_desc_and_release_date(self) -> None:
        html = (
            '<a href="/news/LargeLanguageModel/x.html">'
            '<div class="title"><span>某标题</span></div>'
            '<div class="desc"><p>摘要<b>高亮</b>文本</p></div>'
            '<div class="release-date"><span>发布日期：</span><span>2026-05-06 10:13:00</span></div>'
            "</a>"
        )
        rows = _parse_53ai_qianyan_list_html(html, max_results=5)
        assert len(rows) == 1
        assert rows[0]["title"] == "某标题"
        assert "摘要" in rows[0]["body"] and "高亮" in rows[0]["body"] and "文本" in rows[0]["body"]
        assert rows[0]["_datePublished"] == "2026-05-06"

    def test_schema_enum_values(self) -> None:
        schema = web_search_tool.args_schema.model_json_schema()
        props = schema.get("properties") or {}
        assert set((props.get("ai_daily") or {}).get("enum") or []) >= {"off", "auto"}
        assert set((props.get("news_53ai") or {}).get("enum") or []) >= {"off", "latest"}
        assert "kind" not in props
        assert "engines" not in props
        assert "fetch_pages" not in props
        assert "fetch_extract" not in props

    def test_type_aliases(self) -> None:
        d: WebAiDailyMode = "auto"
        n: WebNews53aiMode = "latest"
        assert d == "auto" and n == "latest"

    @patch("evoflow.community.baidu_search.tools._api_licensed_search")
    def test_defaults_off_plain_search(self, mock_api) -> None:
        mock_api.return_value = [
            {"title": "T", "href": "https://example.com/page", "body": "snippet", "_engine": "tavily"},
        ]
        out = web_search_tool.invoke({"query": "hello world", "max_results": 5})
        data = json.loads(out)
        assert data["ai_daily"] == "off"
        assert data["news_53ai"] == "off"
        assert data["total_results"] >= 1
        assert data["results"][0]["url"] == "https://example.com/page"
        mock_api.assert_called()

    @patch("evoflow.community.baidu_search.tools._api_licensed_search", return_value=[])
    @patch("evoflow.community.baidu_search.tools._fetch_official_ai_news_rows")
    def test_ai_daily_auto_invokes_official_when_sufficient_rows(self, mock_official, _mock_api) -> None:
        mock_official.return_value = [
            {"title": "r1", "href": "https://d/u1", "body": "d1", "_engine": "official"},
            {"title": "r2", "href": "https://d/u2", "body": "d2", "_engine": "official"},
        ]
        out = web_search_tool.invoke({"query": "AI 今日 新闻", "max_results": 5, "ai_daily": "auto"})
        data = json.loads(out)
        assert data["ai_daily"] == "auto"
        assert data["news_53ai"] == "off"
        assert data["total_results"] >= 2
        mock_official.assert_called_once()

    @patch("evoflow.community.baidu_search.tools._api_licensed_search")
    @patch("evoflow.community.baidu_search.tools._fetch_53ai_list_results")
    def test_news_53ai_latest_omitted_max_results_uses_24(self, mock_53, mock_api) -> None:
        mock_53.return_value = []
        web_search_tool.invoke({"query": "q", "news_53ai": "latest"})
        assert mock_53.call_args.kwargs.get("max_results") == 24
        mock_api.assert_not_called()

    @patch("evoflow.community.baidu_search.tools._api_licensed_search")
    @patch("evoflow.community.baidu_search.tools._fetch_53ai_list_results")
    def test_news_53ai_latest_only_list_no_web_search(self, mock_53, mock_api) -> None:
        mock_api.return_value = [
            {"title": "B", "href": "https://zhihu.com/question/x", "body": "s", "_engine": "tavily"},
        ]
        mock_53.return_value = [
            {"title": "F", "href": "https://www.53ai.com/news/y", "body": "", "_engine": "53ai"},
        ]
        out = web_search_tool.invoke({"query": "q", "max_results": 6, "news_53ai": "latest"})
        data = json.loads(out)
        assert data["news_53ai"] == "latest"
        assert data.get("_list_level_only") is True
        assert "web_fetch" in (data.get("_body_fetch_hint") or "")
        for r in data.get("results") or []:
            assert r.get("_page_fetched") is not True
        mock_53.assert_called_once()
        mock_api.assert_not_called()
        urls = {r.get("url") for r in (data.get("results") or [])}
        assert urls == {"https://www.53ai.com/news/y"}

    @patch("evoflow.community.baidu_search.tools._api_licensed_search")
    @patch("evoflow.community.baidu_search.tools._fetch_53ai_list_results")
    def test_news_53ai_dedupes_duplicate_url(self, mock_53, mock_api) -> None:
        mock_53.return_value = [
            {"title": "First", "href": "https://www.53ai.com/news/a", "body": "1", "_engine": "53ai"},
            {"title": "Dup", "href": "https://www.53ai.com/news/a", "body": "2", "_engine": "53ai"},
        ]
        out = web_search_tool.invoke({"query": "q", "max_results": 6, "news_53ai": "latest"})
        data = json.loads(out)
        assert data["total_results"] == 1
        assert data["results"][0]["title"] == "First"
        mock_api.assert_not_called()

    @patch("evoflow.community.baidu_search.tools._api_licensed_search")
    @patch("evoflow.community.baidu_search.tools._fetch_53ai_list_results")
    def test_news_53ai_latest_skips_generic_search(self, mock_53, mock_api) -> None:
        mock_api.return_value = [{"title": "B", "href": "https://zhihu.com/z", "body": "", "_engine": "tavily"}]
        mock_53.return_value = [{"title": "F", "href": "https://www.53ai.com/news/f", "body": "", "_engine": "53ai"}]
        out = web_search_tool.invoke(
            {
                "query": "q",
                "max_results": 6,
                "news_53ai": "latest",
            }
        )
        data = json.loads(out)
        mock_53.assert_called_once()
        mock_api.assert_not_called()
        urls = {r.get("url") for r in (data.get("results") or [])}
        assert urls == {"https://www.53ai.com/news/f"}

    @patch("evoflow.community.baidu_search.tools._api_licensed_search")
    @patch("evoflow.community.baidu_search.tools._fetch_53ai_list_results")
    def test_news_53ai_latest_empty_skips_fallback_search(self, mock_53, mock_api) -> None:
        mock_53.return_value = []
        out = web_search_tool.invoke({"query": "q", "max_results": 6, "news_53ai": "latest"})
        data = json.loads(out)
        assert data["total_results"] == 0
        assert data["results"] == []
        assert "53AI" in (data.get("_note") or "")
        mock_53.assert_called_once()
        mock_api.assert_not_called()

    @patch("evoflow.community.web_fetch.web_fetch_tool")
    @patch("evoflow.community.baidu_search.news_53ai_frontier._http_get_53ai_qianyan_html", return_value=None)
    @patch("evoflow.community.baidu_search.tools._api_licensed_search", return_value=[])
    def test_news_53ai_markdown_skips_images(self, _mock_api, _no_html, mock_wf) -> None:
        """列表页转 Markdown 后常见 ![alt](*.png)；不得当作前沿条目。"""
        mock_wf.invoke.return_value = "![53AI Brain](https://static.53ai.com/uploads/x.png)\n[文章标题 发布日期：2025-03-01](https://www.53ai.com/news/z.html)\n"
        out = web_search_tool.invoke({"query": "q", "max_results": 6, "news_53ai": "latest"})
        data = json.loads(out)
        urls = [r.get("url") for r in (data.get("results") or [])]
        assert "https://www.53ai.com/news/z.html" in urls
        assert not any("uploads/" in (u or "") for u in urls)
        titles = [r.get("title") for r in (data.get("results") or [])]
        assert "文章标题" in titles


class TestWebSearchAiDailyInvokeFullJson:
    """``ai_daily=auto`` 成功路径：整份解析后的 JSON 与预期 ``dict`` 完全一致（便于锁定字段形状）。"""

    @patch("evoflow.community.baidu_search.tools._api_licensed_search", return_value=[])
    @patch("evoflow.community.baidu_search.tools._fetch_official_ai_news_rows")
    def test_ai_daily_auto_exact_payload(self, mock_official, _mock_api) -> None:
        mock_official.return_value = [
            {
                "title": "r1",
                "href": "https://d/u1",
                "body": "d1",
                "_engine": "official",
                "_topic": "OpenAI",
                "_datePublished": "2026-01-01",
            },
            {"title": "r2", "href": "https://d/u2", "body": "d2", "_engine": "official"},
        ]
        out = web_search_tool.invoke(
            {
                "query": "plain q",
                "max_results": 5,
                "ai_daily": "auto",
            }
        )
        expected = {
            "query": "plain q",
            "total_results": 2,
            "engines": ["official"],
            "results": [
                {
                    "title": "r1",
                    "url": "https://d/u1",
                    "content": "d1",
                    "_engine": "official",
                    "_snippet": "d1",
                    "_topic": "OpenAI",
                    "_datePublished": "2026-01-01",
                },
                {
                    "title": "r2",
                    "url": "https://d/u2",
                    "content": "d2",
                    "_engine": "official",
                    "_snippet": "d2",
                },
            ],
            "_engine_version": "EvoFlowProviderSearch",
            "ai_daily": "auto",
            "news_53ai": "off",
            "_official_news_index": authoritative_official_news_index(),
        }
        assert json.loads(out) == expected
        mock_official.assert_called_once_with(query="plain q", max_results=5)


class TestLegacySerpHelpersAbsent:
    def test_legacy_serp_helper_symbols_absent(self) -> None:
        import evoflow.community.baidu_search.tools as mod

        for name in (
            "_baidu_html_search",
            "_bing_html_search",
            "_sogou_html_search",
            "_baidu_playwright_search",
            "_ddg_html_search",
            "_search_text",
            "_get_baidu_storage_state_path",
        ):
            assert not hasattr(mod, name), f"{name} should be absent"


class TestOfficialAiNewsFeedParse:
    """``official_ai_news``：RSS 解析与厂商索引。"""

    def test_parse_minimal_rss2(self) -> None:
        xml = """<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
<item><title>Hello &amp; Co</title><link>https://example.com/a</link><description>Desc A</description></item>
<item><title>Second</title><link>https://example.com/b</link></item>
</channel></rss>"""
        rows = parse_feed_entries(xml, max_items=5)
        assert rows == [
            ("Hello & Co", "https://example.com/a", "Desc A"),
            ("Second", "https://example.com/b", ""),
        ]

    def test_authoritative_index_has_openai_zh_research_index(self) -> None:
        idx = authoritative_official_news_index()
        openai = next((x for x in idx if "OpenAI" in x.get("vendor", "")), None)
        assert openai is not None
        assert openai["news_home"] == "https://openai.com/zh-Hans-CN/research/index/"
        cursor = next((x for x in idx if x.get("vendor") == "Cursor"), None)
        assert cursor is not None
        assert "cursor.com" in (cursor.get("news_home") or "")

    def test_rebalance_one_per_vendor_before_second(self) -> None:
        rows = [
            {"title": "o1", "href": "https://openai.com/a", "_topic": "OpenAI", "_engine": "official"},
            {"title": "o2", "href": "https://openai.com/b", "_topic": "OpenAI", "_engine": "official"},
            {"title": "m1", "href": "https://ms.com/1", "_topic": "Microsoft AI", "_engine": "official"},
            {"title": "m2", "href": "https://ms.com/2", "_topic": "Microsoft AI", "_engine": "official"},
            {
                "title": "a1",
                "href": "https://aws.com/1",
                "_topic": "AWS Machine Learning Blog",
                "_engine": "official",
            },
        ]
        out = rebalance_ai_daily_rows(rows, max_results=5, max_per_topic=2)
        assert [r["title"] for r in out] == ["o1", "m1", "a1", "o2", "m2"]
