"""Enhanced Web Fetch tool — Hybrid HTTP + Jina fallback strategy.

Strategy C (Hybrid):
1. Primary: Built-in HTTP fetcher with HTML→Markdown conversion (zero external deps)
2. Optional: Jina Reader API as enhanced backend when available
3. Fallback: If Jina fails, falls back to pure HTTP

Features:
- 50KB content limit (vs jina_ai's 4KB limit)
- Three extract modes: full / main-content / text
- Security: blocks internal networks, enforces http/https only
- Auto-detection of portal/search pages → redirect to web_search
"""

import logging
import re
import ssl
from concurrent.futures import ThreadPoolExecutor, as_completed
from html.parser import HTMLParser
from ipaddress import ip_address as _ip_addr
from ipaddress import ip_network as _ip_net
from typing import Literal
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen

from langchain.tools import tool

from evoflow.community.web_fetch_errors import format_web_fetch_http_error, format_web_fetch_url_error
from evoflow.tools.minimal_schema import FETCH_URL_DESCRIPTION

logger = logging.getLogger(__name__)

# ── SSL Context ──────────────────────────────────────────────
_SSL_CONTEXT = ssl.create_default_context()
_SSL_CONTEXT.check_hostname = False
_SSL_CONTEXT.verify_mode = ssl.CERT_NONE

# ── Security ──────────────────────────────────────────────────
_BLOCKED_SCHEMES = {"file", "javascript", "data", "ftp"}
_BLOCKED_NETWORKS = [
    ("127.0.0.0", "255.0.0.0"),
    ("10.0.0.0", "255.0.0.0"),
    ("172.16.0.0", "255.240.0.0"),
    ("192.168.0.0", "255.255.0.0"),
    ("169.254.0.0", "255.255.0.0"),
]

_PORTAL_HOSTS = {
    "bing.com": ("/news/search", "/search"),
    "google.com": ("/search",),
    "baidu.com": ("/s",),
}


# ── HTML → Markdown Converter ────────────────────────────────


class _HTMLToMarkdown(HTMLParser):
    """Minimal but effective HTML to Markdown converter.

    Handles:
    - Headings h1→h6 → # prefixes
    - Paragraphs, line breaks, horizontal rules
    - Links [text](url), images ![alt](src)
    - Lists (ul/ol/li), tables (tr/td/th)
    - Code blocks (pre/code), bold/italic
    - Strips script/style/nav/footer/header noise
    """

    def __init__(self):
        super().__init__()
        self.output: list[str] = []
        self._in_script_style = False
        self._in_pre = False
        self._tag_stack: list[tuple[str, str]] = []
        self._list_depth = 0
        self._in_table = False
        self._table_row: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str]]):
        tag = tag.lower()
        attr_dict = dict(attrs)

        # Skip content inside script/style
        if tag in ("script", "style"):
            self._in_script_style = True
            return
        if tag in ("nav", "footer", "header", "aside"):
            self._in_script_style = True  # Treat as skip for main-content mode
            return
        if tag == "pre":
            self._in_pre = True
        if tag == "br":
            self._write("\n")
        if tag == "hr":
            self._write("\n---\n")
        if tag in ("h1", "h2", "h3", "h4", "h5", "h6"):
            level = int(tag[1])
            self._write("\n" + "#" * level + " ")
        if tag in ("ul", "ol"):
            self._list_depth += 1
        if tag == "li":
            indent = "  " * max(0, self._list_depth - 1)
            self._write(f"\n{indent}- ")
        if tag == "p":
            self._write("\n")
        if tag == "img":
            alt = attr_dict.get("alt", "")
            src = attr_dict.get("src", "")
            if src and src.startswith("http"):
                self._write(f"![{alt}]({src})")
            elif alt:
                self._write(f"[Image: {alt}]")
        if tag == "a":
            href = attr_dict.get("href", "")
            self._tag_stack.append(("a", href))
        if tag in ("strong", "b"):
            self._write("**")
        if tag in ("em", "i"):
            self._write("*")
        if tag == "code" and not self._in_pre:
            self._write("`")
        if tag in ("blockquote",):
            self._write("> ")
        if tag == "table":
            self._in_table = True
        if tag == "tr":
            self._table_row = []
        if tag in ("td", "th"):
            self._table_row.append("")

    def handle_endtag(self, tag: str):
        tag = tag.lower()
        if tag in ("script", "style", "nav", "footer", "header", "aside"):
            self._in_script_style = False
            return
        if tag == "pre":
            self._in_pre = False
        if tag in ("h1", "h2", "h3", "h4", "h5", "h6", "p", "li", "blockquote"):
            self._write("\n")
        if tag in ("ul", "ol"):
            self._list_depth = max(0, self._list_depth - 1)
        if tag == "a" and self._tag_stack:
            _, href = self._tag_stack.pop()
            if href and href.startswith("http"):
                self._write(f"({href})")
        if tag in ("strong", "b"):
            self._write("**")
        if tag in ("em", "i"):
            self._write("*")
        if tag == "code" and not self._in_pre:
            self._write("`")
        if tag == "tr" and self._in_table:
            self._write("| " + " | ".join(self._table_row) + " |")
        if tag == "th" and self._in_table:
            # Add separator row after header
            self._write("\n| " + " | ".join("---" for _ in self._table_row) + " |")
        if tag == "table":
            self._in_table = False

    def handle_data(self, data: str):
        if self._in_script_style:
            return
        text = data if self._in_pre else " ".join(data.split())
        self._write(text)
        if self._in_table and self._table_row is not None:
            # Also accumulate table cell data
            last_idx = len(self._table_row) - 1
            if last_idx >= 0:
                self._table_row[last_idx] += text.strip()

    def handle_entityref(self, name: str):
        entities = {"amp": "&", "lt": "<", "gt": ">", "quot": '"', "#39": "'", "nbsp": " "}
        self._write(entities.get(name, f"&{name};"))

    def _write(self, text: str):
        self.output.append(text)

    def get_markdown(self) -> str:
        raw = "".join(self.output)
        cleaned = re.sub(r"\n{3,}", "\n\n", raw)
        return cleaned.strip()


# ── Portal Page Detection ────────────────────────────────────


def _is_portal_search_page(url: str) -> bool:
    """Detect search engine result pages that should use web_search instead."""
    try:
        p = urlparse(url)
    except Exception:
        return False
    host = (p.netloc or "").lower()
    path = (p.path or "").lower()

    for domain, paths in _PORTAL_HOSTS.items():
        if host.endswith(domain) or host.endswith("." + domain):
            for prefix in paths:
                if path.startswith(prefix):
                    return True
    return False


# ── Network Safety Check ─────────────────────────────────────


def _is_blocked_url(parsed_url) -> str | None:
    """Return error message if URL should be blocked, None otherwise."""
    scheme = parsed_url.scheme.lower()
    if scheme in _BLOCKED_SCHEMES:
        return f"Error: Blocked URL scheme '{scheme}' — only http/https allowed"
    if scheme not in ("http", "https"):
        return f"Error: Only http/https URLs allowed, got: {scheme}"

    hostname = parsed_url.hostname
    if not hostname:
        return None

    for net, mask in _BLOCKED_NETWORKS:
        try:
            ip = _ip_addr(hostname)
            net_obj = _ip_net(f"{net}/{mask}", strict=False)
            if ip in net_obj:
                return f"Error: Private/internal network URL blocked: {hostname}"
        except ValueError:
            pass  # Not an IP address hostname, that's fine
    return None


# ── Main Content Extraction ──────────────────────────────────


def _extract_main_content(md: str, max_len: int = 50000) -> str | None:
    """Extract the most likely article body from converted Markdown.

    Uses heuristics:
    1. Split by heading boundaries
    2. Score each section by length × content keywords
    3. Return the highest-scoring section
    """
    sections = re.split(r"\n(?=#{1,4}\s)", md)
    if len(sections) <= 1:
        return None

    scored = []
    for sec in sections:
        text_len = len(sec)
        if text_len < 80:
            continue
        score = text_len

        # Boost sections with article-like headers
        header_match = re.match(
            r"^#{1,4}\s*"
            r"(?:Article|Content|Main|正文|文章|内容|Introduction|"
            r"Abstract|Summary|Overview|Background|Discussion|"
            r"Conclusion|Methodology|Results)",
            sec,
            re.IGNORECASE,
        )
        if header_match:
            score *= 2.5

        # Penalize navigation-heavy sections
        nav_indicators = len(re.findall(r"(?:menu|nav|sidebar|footer|header|subscribe)", sec, re.IGNORECASE))
        score *= max(0.5, 1.0 - nav_indicators * 0.2)

        # Prefer sections with paragraph-like density (longer lines)
        lines = sec.splitlines()
        long_lines = sum(1 for line in lines if len(line.strip()) > 60)
        if long_lines > 3:
            score *= 1.3

        scored.append((score, sec))

    if not scored:
        return None

    scored.sort(key=lambda x: -x[0])
    return scored[0][1][:max_len]


def _extract_links_from_markdown(md: str, *, limit: int = 5) -> list[str]:
    """Extract unique http(s) links from markdown produced by this tool."""
    if not md or limit <= 0:
        return []
    urls: list[str] = []
    seen: set[str] = set()

    # Prefer markdown link targets: [text](url)
    for m in re.finditer(r"\((https?://[^)\s]+)\)", md):
        u = m.group(1).strip()
        if not u:
            continue
        key = u.split("#", 1)[0]
        if key in seen:
            continue
        seen.add(key)
        urls.append(u)
        if len(urls) >= limit:
            return urls

    # Fallback: bare URLs
    for m in re.finditer(r"(https?://[^\s)>\"]+)", md):
        u = m.group(1).strip()
        if not u:
            continue
        key = u.split("#", 1)[0]
        if key in seen:
            continue
        seen.add(key)
        urls.append(u)
        if len(urls) >= limit:
            return urls

    return urls


# ── Jina Fallback (optional) ──────────────────────────────────


def _try_jina_fetch(url: str, timeout: int) -> str | None:
    """Attempt Jina Reader API fetch. Returns content or None on failure / when disabled."""
    try:
        from evoflow.community.jina_ai.jina_client import JinaClient, jina_enabled

        if not jina_enabled():
            return None

        client = JinaClient()
        result = client.crawl(url, return_format="markdown", timeout=timeout)
        if result and isinstance(result, str) and not result.lower().startswith("error:"):
            return result[:50000]
    except ImportError:
        logger.debug("Jina client not available, skipping")
    except Exception as e:
        logger.debug("Jina fetch failed: %s", e)
    return None


# ── Core HTTP Fetcher ─────────────────────────────────────────


def _http_fetch(url: str, timeout: int, max_length: int) -> tuple[str, str]:
    """Fetch URL via HTTP and return (html_str, encoding)."""
    req = Request(
        url,
        headers={
            "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"),
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
            "Accept-Encoding": "identity",  # No compression for simplicity
        },
    )

    with urlopen(req, timeout=timeout, context=_SSL_CONTEXT) as resp:
        raw_bytes = resp.read(max_length * 2)
        encoding = resp.headers.get_content_charset() or "utf-8"
        html_str = raw_bytes.decode(encoding, errors="replace")[:max_length]

    return html_str, encoding


# ── Public Tool ───────────────────────────────────────────────


@tool("fetch_url", description=FETCH_URL_DESCRIPTION, parse_docstring=False)
def web_fetch_tool(
    url: str,
    *,
    extract: Literal["full", "main-content", "text"] = "main-content",
    max_length: int = 50000,
    timeout: int = 15,
    prefer_jina: bool = False,
    follow_links: int = 0,
    follow_extract: Literal["full", "main-content", "text"] = "main-content",
    follow_max_length: int = 12000,
    follow_timeout: int | None = None,
) -> str:
    """Fetch content from a URL."""
    # Validate URL
    parsed_url = urlparse(url)
    block_err = _is_blocked_url(parsed_url)
    if block_err:
        return block_err

    # Detect search portals
    if _is_portal_search_page(url):
        return "Error: This looks like a search/portal page. Use the `web_search` tool instead, then call `web_fetch_tool` on specific result URLs."

    fetched_md = None

    # Only hit Jina when JINA_API_KEY is set; otherwise HTTP-only (no r.jina.ai timeout).
    use_jina = bool(prefer_jina)
    if use_jina:
        try:
            from evoflow.community.jina_ai.jina_client import jina_enabled

            use_jina = jina_enabled()
        except Exception:
            use_jina = False

    if use_jina:
        fetched_md = _try_jina_fetch(url, timeout)
        if not fetched_md:
            logger.info("Jina failed, falling back to HTTP for %s", url)

    if not fetched_md:
        # Primary: built-in HTTP fetcher
        try:
            html_str, encoding = _http_fetch(url, timeout, max_length)

            if extract == "text":
                # Plain text mode: strip all tags
                text = re.sub(r"<[^>]+>", " ", html_str)
                text = re.sub(r"\s+", " ", text).strip()
                return text[:max_length]

            # Convert to Markdown
            parser = _HTMLToMarkdown()
            parser.feed(html_str)
            fetched_md = parser.get_markdown()

        except HTTPError as e:
            return format_web_fetch_http_error(url, int(e.code), str(e.reason or ""))
        except URLError as e:
            # If HTTP fails, try Jina as fallback only when enabled
            if not use_jina:
                fetched_md = _try_jina_fetch(url, timeout)
            if not fetched_md:
                return format_web_fetch_url_error(url, str(e.reason or e))
        except ssl.SSLError:
            return f"Error: SSL certificate error for {url}"
        except Exception as e:
            return f"Error: Fetching {url} failed: {e}"

    if not fetched_md:
        return f"Error: No content extracted from {url}"

    # Main content extraction
    if extract == "main-content":
        extracted = _extract_main_content(fetched_md, max_len=max_length)
        if extracted:
            fetched_md = extracted

    if not fetched_md.strip():
        return "(page appears empty or had no extractable content)"

    out_md = fetched_md[:max_length]

    try:
        follow_links_n = max(0, int(follow_links))
    except Exception:
        follow_links_n = 0
    if follow_links_n <= 0:
        return out_md

    if follow_timeout is None:
        follow_timeout = timeout

    # One-level deep follow: extract links from page markdown and fetch each.
    links = _extract_links_from_markdown(out_md, limit=min(10, follow_links_n))
    if not links:
        return out_md

    # Avoid fetching the same page again.
    links = [u for u in links if u and u.split("#", 1)[0] != url.split("#", 1)[0]]
    if not links:
        return out_md

    results: list[tuple[str, str]] = []

    def _fetch_child(u: str) -> str:
        # Important: do not recurse further.
        try:
            return str(
                web_fetch_tool.invoke(
                    {
                        "url": u,
                        "extract": follow_extract,
                        "max_length": follow_max_length,
                        "timeout": int(follow_timeout or timeout),
                        "prefer_jina": prefer_jina,
                        "follow_links": 0,
                    }
                )
            )
        except Exception as e:
            return f"Error: fetch failed: {e}"

    with ThreadPoolExecutor(max_workers=min(4, len(links))) as ex:
        futs = {ex.submit(_fetch_child, u): u for u in links}
        for fut in as_completed(futs):
            u = futs[fut]
            try:
                body = str(fut.result() or "").strip()
            except Exception as e:
                body = f"Error: fetch failed: {e}"
            if not body:
                continue
            results.append((u, body))

    if not results:
        return out_md

    # Append followed content sections.
    appended: list[str] = [out_md, "\n\n---\n\n## Followed links\n"]
    for u, body in results[:follow_links_n]:
        appended.append(f"\n### {u}\n\n{body[:follow_max_length]}\n")

    final = "".join(appended)
    return final[:max_length] if len(final) > max_length else final
