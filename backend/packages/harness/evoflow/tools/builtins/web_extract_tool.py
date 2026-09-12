"""Web Extract Tool — fetch URL content as structured markdown.

Extracts content from web page URLs. Returns page content in markdown format.
Also works with PDF URLs (arxiv papers, documents, etc.).
"""

import json
import logging
import re
import urllib.request
from html.parser import HTMLParser
from urllib.parse import urlparse

from langchain.tools import tool

logger = logging.getLogger(__name__)


class _HTMLToMarkdown(HTMLParser):
    """Minimal HTML → Markdown converter."""

    def __init__(self):
        super().__init__()
        self.output: list[str] = []
        self._in_script_style = False
        self._in_pre = False
        self._tag_stack: list[tuple[str, str]] = []

    def handle_starttag(self, tag, attrs):
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
            self._write("\n" + "#" * int(tag[1]) + " ")
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

    def handle_endtag(self, tag):
        tag = tag.lower()
        if tag in ("script", "style"):
            self._in_script_style = False
            return
        if tag == "pre":
            self._in_pre = False
        if tag == "p":
            self._write("\n")
        if tag in ("td", "th"):
            self._write(" |")
        if tag in ("h1", "h2", "h3", "h4", "h5", "h6", "li"):
            self._write("\n")
        # Pop matching anchor
        if tag == "a" and self._tag_stack and self._tag_stack[-1][0] == "a":
            _, href = self._tag_stack.pop()
            if href and href != "#":
                self._write(f"({href})")

    def handle_data(self, data):
        if self._in_script_style:
            return
        if self._in_pre:
            self._write(data)
        else:
            data = re.sub(r"\s+", " ", data)
            if data.strip():
                self._write(data)

    def handle_entityref(self, name):
        char = {"amp": "&", "lt": "<", "gt": ">", "quot": '"', "apos": "'"}.get(name)
        self._write(char or f"&{name};")

    def _write(self, text):
        self.output.append(text)

    def get_text(self) -> str:
        return "".join(self.output)


def _html_to_markdown(html: str) -> str:
    parser = _HTMLToMarkdown()
    parser.feed(html)
    text = parser.get_text()
    # Clean up excessive blank lines
    text = re.sub(r"\n{4,}", "\n\n\n", text)
    text = re.sub(r"[ \t]+\n", "\n", text)
    return text.strip()


def _is_blocked_url(url: str) -> str | None:
    """Check if URL should be blocked."""
    ip_addresses = __import__("ipaddress", fromlist=["ip_address", "ip_network"])
    try:
        parsed = urlparse(url)
        hostname = parsed.hostname
        if not hostname:
            return "Invalid URL (no hostname)"
        if parsed.scheme not in ("http", "https"):
            return f"Only http/https URLs allowed, got: {parsed.scheme}"
        if hostname in ("localhost", "127.0.0.1", "0.0.0.0", "::1"):
            return "Internal URL blocked"
        # Check private IP ranges
        try:
            addr = ip_addresses.ip_address(hostname)
            if addr.is_private or addr.is_loopback or addr.is_link_local:
                return "Private IP address blocked"
        except ValueError:
            pass
        return None
    except Exception as e:
        return f"Invalid URL: {e}"


@tool("web_extract", parse_docstring=True)
def web_extract_tool(
    urls: list[str],
) -> str:
    """Extract content from web page URLs.

    Returns page content in markdown format. Also works with PDF URLs
    (arxiv papers, documents, etc.).

    Args:
        urls: List of URLs to extract content from (max 5 URLs per call).
    """
    if not urls or not isinstance(urls, list):
        return json.dumps({"error": "No URLs provided"})

    urls = urls[:5]
    results = []

    for url in urls:
        block = _is_blocked_url(url)
        if block:
            results.append({"url": url, "error": block})
            continue

        try:
            req = urllib.request.Request(
                url,
                headers={"User-Agent": "Mozilla/5.0 (compatible; EvoFlow/1.0)"},
            )
            resp = urllib.request.urlopen(req, timeout=30)
            html = resp.read().decode("utf-8", errors="replace")

            # Check if it's a PDF
            content_type = resp.headers.get("Content-Type", "")
            if "pdf" in content_type.lower():
                results.append(
                    {
                        "url": url,
                        "title": url.rsplit("/", 1)[-1],
                        "content": f"[PDF document: {len(html)} bytes. PDF parsing not available in web_extract. Use the browser tool to view this PDF.]",
                    }
                )
                continue

            title_match = re.search(r"<title[^>]*>(.*?)</title>", html, re.IGNORECASE | re.DOTALL)
            title = title_match.group(1).strip() if title_match else url

            content = _html_to_markdown(html)

            # Cap content length
            if len(content) > 10000:
                content = content[:10000] + f"\n\n... [truncated, total {len(content)} chars]"

            results.append({"url": url, "title": title, "content": content})

        except Exception as e:
            results.append({"url": url, "error": str(e)})

    return json.dumps({"results": results}, ensure_ascii=False)
