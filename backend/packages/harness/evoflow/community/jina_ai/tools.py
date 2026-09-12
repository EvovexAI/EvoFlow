import re
import urllib.parse
import urllib.request

from langchain.tools import tool

from evoflow.community.jina_ai.jina_client import JinaClient
from evoflow.config import get_app_config
from evoflow.utils.readability import ReadabilityExtractor

readability_extractor = ReadabilityExtractor()


def _is_portal_search_page(url: str) -> bool:
    """Pages like Bing News search are unstable for scraping; require web_search instead."""
    try:
        p = urllib.parse.urlparse(url)
    except Exception:
        return False
    host = (p.netloc or "").lower()
    path = (p.path or "").lower()
    if host.endswith("bing.com") and path.startswith("/news/search"):
        return True
    if host.endswith("bing.com") and path.startswith("/search"):
        return True
    if host.endswith("google.com") and path.startswith("/search"):
        return True
    if host.endswith("baidu.com") and path.startswith("/s"):
        return True
    return False


def _strip_html(s: str) -> str:
    s = re.sub(r"<script[\s\S]*?</script>", " ", s, flags=re.I)
    s = re.sub(r"<style[\s\S]*?</style>", " ", s, flags=re.I)
    s = re.sub(r"<[^>]+>", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s


def _direct_fetch_html(url: str, timeout: int) -> str:
    headers = {
        "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36"),
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.7",
    }
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read()
    try:
        return raw.decode("utf-8", errors="ignore")
    except Exception:
        return raw.decode("gb18030", errors="ignore")


@tool("web_fetch", parse_docstring=True)
def web_fetch_tool(url: str) -> str:
    """Fetch the contents of a web page at a given URL.
    Only fetch EXACT URLs that have been provided directly by the user or have been returned in results from the web_search and web_fetch tools.
    This tool can NOT access content that requires authentication, such as private Google Docs or pages behind login walls.
    Do NOT add www. to URLs that do NOT have them.
    URLs must include the schema: https://example.com is a valid URL while example.com is an invalid URL.

    Args:
        url: The URL to fetch the contents of.
    """
    if _is_portal_search_page(url):
        return "Error: This URL looks like a search/portal page (e.g. Bing News search). Use the `web_search` tool to search first, then call `web_fetch` only on a specific result URL."

    jina_client = JinaClient()
    timeout = 10
    config = get_app_config().get_tool_config("web_fetch")
    if config is not None and "timeout" in config.model_extra:
        timeout = config.model_extra.get("timeout")
    html_content = jina_client.crawl(url, return_format="html", timeout=timeout)
    # If Jina failed (common in restricted networks), fall back to direct fetch.
    if isinstance(html_content, str) and html_content.strip().lower().startswith("error:"):
        try:
            html_content = _direct_fetch_html(url, timeout=timeout)
        except Exception as e:
            return f"Error: Direct fetch failed: {e}"

    if not html_content or not str(html_content).strip():
        return f"Error: No content fetched from {url}"

    try:
        article = readability_extractor.extract_article(html_content)
        md = (article.to_markdown() or "").strip()
        if md:
            return md[:4096]
    except Exception:
        pass
    return _strip_html(str(html_content))[:4096]
