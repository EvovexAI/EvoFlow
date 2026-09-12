"""Fetch URL content and convert to structured markdown."""

import re
import ssl
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

# Allow HTTPS without verification for general fetching (same as browsers)
_SSL_CONTEXT = ssl.create_default_context()
_SSL_CONTEXT.check_hostname = False
_SSL_CONTEXT.verify_mode = ssl.CERT_NONE

# Internal network ranges that are blocked
_BLOCKED_NETWORKS = [
    ("127.0.0.0", "255.0.0.0"),  # Loopback
    ("10.0.0.0", "255.0.0.0"),  # RFC1918
    ("172.16.0.0", "255.240.0.0"),  # RFC1918
    ("192.168.0.0", "255.255.0.0"),  # RFC1918
    ("169.254.0.0", "255.255.0.0"),  # Link-local
]


class _HTMLToMarkdown(HTMLParser):
    """Minimal HTML → Markdown converter focused on readability."""

    def __init__(self):
        super().__init__()
        self.output: list[str] = []
        self._in_script_style = False
        self._in_pre = False
        self._tag_stack: list[tuple[str, str]] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str]]):
        tag = tag.lower()
        attr_dict = dict(attrs)

        if tag in ("script", "style"):
            self._in_script_style = True
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
        if tag == "li":
            self._write("- ")
        if tag == "p":
            self._write("\n")
        if tag == "img":
            alt = attr_dict.get("alt", "")
            src = attr_dict.get("src", "")
            if src:
                self._write(f"![{alt}]({src})")
            elif alt:
                self._write(f"[Image: {alt}]")
        if tag == "a":
            href = attr_dict.get("href", "")
            self._tag_stack.append(("a", href))
        if tag == "tr":
            self._write("|")
        if tag in ("td", "th"):
            self._write(" ")

    def handle_endtag(self, tag: str):
        tag = tag.lower()
        if tag in ("script", "style"):
            self._in_script_style = False
            return
        if tag == "pre":
            self._in_pre = False
        if tag in ("h1", "h2", "h3", "h4", "h5", "h6", "li", "td", "th", "tr", "p"):
            self._write("\n")
        if tag == "a" and self._tag_stack:
            _, href = self._tag_stack.pop()
            if href:
                self._write(f"({href})")

    def handle_data(self, data: str):
        if self._in_script_style:
            return
        text = data if self._in_pre else " ".join(data.split())
        self._write(text)

    def _write(self, text: str):
        self.output.append(text)

    def get_markdown(self) -> str:
        raw = "".join(self.output)
        cleaned = re.sub(r"\n{3,}", "\n\n", raw)
        return cleaned.strip()


@tool("web_fetch", description=FETCH_URL_DESCRIPTION, parse_docstring=False)
def web_fetch_hd(
    url: str,
    *,
    extract: Literal["full", "main-content", "text"] = "main-content",
    max_length: int = 50000,
    timeout: int = 15,
) -> str:
    """Fetch content from a URL."""
    parsed_url = urlparse(url)

    # Validate URL scheme
    if parsed_url.scheme not in ("http", "https"):
        return f"Error: Only http/https URLs allowed, got: {parsed_url.scheme}"

    # Block internal networks by hostname
    hostname = parsed_url.hostname
    if hostname:
        for net, mask in _BLOCKED_NETWORKS:
            try:
                ip = _ip_addr(hostname)  # type: ignore[arg-type]
                ip_net_obj = _ip_net(f"{net}/{mask}", strict=False)
                if ip in ip_net_obj:
                    return f"Error: Private/internal network URL blocked: {hostname}"
            except ValueError:
                pass  # Hostname is not an IP address, that's fine

    try:
        req = Request(
            url,
            headers={
                "User-Agent": "Mozilla/5.0 (compatible; EvoFlow/1.0; ResearchTool)",
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
            },
        )

        with urlopen(req, timeout=timeout, context=_SSL_CONTEXT) as resp:
            raw_html = resp.read(max_length * 2)
            encoding = resp.headers.get_content_charset() or "utf-8"
            html_str = raw_html.decode(encoding, errors="replace")[:max_length]

        if extract == "text":
            text = re.sub(r"<[^>]+>", " ", html_str)
            text = re.sub(r"\s+", " ", text).strip()
            return text[:max_length]

        # Convert HTML to Markdown
        parser = _HTMLToMarkdown()
        parser.feed(html_str)
        md = parser.get_markdown()

        if extract == "main-content":
            extracted = _extract_main_content(md)
            if extracted:
                md = extracted

        return md if md.strip() else "(page appears empty or had no extractable content)"

    except HTTPError as e:
        return format_web_fetch_http_error(url, int(e.code), str(e.reason or ""))
    except URLError as e:
        return format_web_fetch_url_error(url, str(e.reason or e))
    except ssl.SSLError:
        return f"Error: SSL certificate error for {url}"
    except Exception as e:
        return f"Error: Fetching {url} failed: {e}"


def _extract_main_content(md: str) -> str | None:
    """Heuristic extraction of main content from Markdown.

    Looks for common markers like ## Article, ### Content, or the longest section.
    """
    sections = re.split(r"\n(?=#{1,3}\s)", md)
    if len(sections) <= 1:
        return None

    scored = []
    for sec in sections:
        text_len = len(sec)
        if text_len < 100:
            continue
        score = text_len
        header_match = re.match(
            r"^#{1,3}\s*(?:Article|Content|Main|正文|文章|内容)",
            sec,
            re.IGNORECASE,
        )
        if header_match:
            score *= 2
        scored.append((score, sec))

    if not scored:
        return None

    scored.sort(key=lambda x: -x[0])
    return scored[0][1][:50000]
