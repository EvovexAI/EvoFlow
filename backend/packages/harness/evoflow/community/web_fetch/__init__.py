"""Enhanced Web Fetch tool — hybrid HTTP + Jina fallback strategy.

Usage:
    from evoflow.community.web_fetch import web_fetch_tool
    result = web_fetch_tool.invoke({'url': 'https://example.com'})
    # or with options
    result = web_fetch_tool.invoke({
        'url': 'https://example.com/article',
        'extract': 'main-content',
        'max_length': 30000,
    })
"""

from evoflow.community.web_fetch.tools import web_fetch_tool

__all__ = ["web_fetch_tool"]
