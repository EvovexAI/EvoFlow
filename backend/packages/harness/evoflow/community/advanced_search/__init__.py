"""
Advanced Search Tool - LangChain 工具封装

当前活跃版本：tools_fast_v2（快速深度搜索 V2）
历史版本已归档到 _deprecated/ 目录
"""

try:
    import json
    import logging

    from langchain.tools import tool

    # 从活跃版本导入
    from .tools_fast_v2 import FastSearchEngineV2, SearchResult, fast_search_v2

    LANGCHAIN_AVAILABLE = True
except ImportError:
    LANGCHAIN_AVAILABLE = False
    # 如果没有 langchain，只导出基础函数
    try:
        from .tools_fast_v2 import FastSearchEngineV2, SearchResult, fast_search_v2
    except ImportError:
        fast_search_v2 = None
        FastSearchEngineV2 = None
        SearchResult = None

    __all__ = ["fast_search_v2", "FastSearchEngineV2", "SearchResult"]

    # 如果尝试使用工具函数会抛出友好提示
    def _langchain_not_available():
        raise ImportError("LangChain tools require 'langchain' package. Install it with: pip install langchain\nOr use direct Python API: fast_search_v2()")

    advanced_search_tool = _langchain_not_available
else:
    # LangChain 可用时的正常导出
    logger = logging.getLogger(__name__)

    @tool("advanced_search", parse_docstring=True)
    def advanced_search_tool(
        query: str,
        max_results: int = 10,
        level: str = "standard",
        time_range: str | None = None,
    ) -> str:
        """
        Advanced web search using fast_search_v2 engine.

        Features:
        - Multi-engine search (Baidu + Bing)
        - Intelligent quality scoring and authority evaluation
        - Deep content extraction (up to 5000 chars per result)
        - Async architecture for speed

        Search Levels:
        - quick: 1-2 seconds, cached results
        - standard: 3-5 seconds, dual engine parallel
        - deep: 10-15 seconds, triple engine + content extraction

        Args:
            query: Search query keywords
            max_results: Maximum number of results to return (default: 10)
            level: Search depth - 'quick', 'standard', or 'deep' (default: 'standard')
            time_range: Time filter - 'day', 'week', 'month', 'year' (optional)

        Returns:
            JSON array of search results with title, url, snippet, score, and content
        """
        try:
            results = fast_search_v2(
                query=query,
                max_results=max_results,
                level=level,
                time_range=time_range,
            )

            output = {
                "query": query,
                "level": level,
                "total_results": len(results),
                "results": [
                    {
                        "title": r.title,
                        "url": r.url,
                        "snippet": r.snippet,
                        "content": r.content[:1000] if r.content else "",
                        "score": round(r.score, 2),
                        "source": getattr(r, "source", ""),
                        "authority_score": round(getattr(r, "authority_score", 0), 2),
                        "quality_score": round(getattr(r, "quality_score", 0), 2),
                    }
                    for r in results
                ],
            }

            return json.dumps(output, indent=2, ensure_ascii=False)

        except Exception as e:
            logger.error(f"Advanced search failed: {e}")
            return json.dumps({"error": str(e), "query": query}, ensure_ascii=False)

    @tool("quick_search", parse_docstring=False)
    def quick_search_tool(query: str, max_results: int = 5) -> str:
        """Fast web search using quick level.

        Args:
            query: Search query keywords
            max_results: Maximum number of results (default: 5)
        """
        try:
            results = fast_search_v2(query=query, max_results=max_results, level="quick")

            output = {
                "query": query,
                "total_results": len(results),
                "results": [
                    {
                        "title": r.title,
                        "url": r.url,
                        "snippet": r.snippet,
                        "score": round(r.score, 2),
                    }
                    for r in results
                ],
            }

            return json.dumps(output, indent=2, ensure_ascii=False)

        except Exception as e:
            logger.error(f"Quick search failed: {e}")
            return json.dumps({"error": str(e), "query": query}, ensure_ascii=False)

    @tool("deep_search", parse_docstring=False)
    def deep_search_tool(query: str, max_results: int = 10) -> str:
        """Deep web search with full content extraction.

        Args:
            query: Search query keywords
            max_results: Maximum number of results (default: 10)
        """
        try:
            results = fast_search_v2(query=query, max_results=max_results, level="deep")

            output = {
                "query": query,
                "total_results": len(results),
                "results": [
                    {
                        "title": r.title,
                        "url": r.url,
                        "snippet": r.snippet,
                        "content": r.content[:2000] if r.content else "",
                        "score": round(r.score, 2),
                        "source": getattr(r, "source", ""),
                    }
                    for r in results
                ],
            }

            return json.dumps(output, indent=2, ensure_ascii=False)

        except Exception as e:
            logger.error(f"Deep search failed: {e}")
            return json.dumps({"error": str(e), "query": query}, ensure_ascii=False)

    __all__ = [
        "advanced_search_tool",
        "quick_search_tool",
        "deep_search_tool",
        "fast_search_v2",
        "FastSearchEngineV2",
        "SearchResult",
    ]
