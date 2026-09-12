"""Structured hints for ``web_fetch`` failures (reduce blind retries)."""

from __future__ import annotations

_HTTP_HINTS: dict[int, str] = {
    403: "Site blocks automated fetch; use web_search snippets or another source. Do not retry the same URL.",
    404: "URL not found; pick another link from search results or verify the path.",
    502: "Bad gateway from origin; try a different source instead of long retries.",
    503: "Service unavailable; try another source.",
    429: "Rate limited; wait or use web_search instead of repeated fetch.",
}


def format_web_fetch_http_error(url: str, code: int, reason: str = "") -> str:
    rs = (reason or "").strip()
    base = f"Error: HTTP {code} {rs} for {url}".strip() if rs else f"Error: HTTP {code} for {url}"
    hint = _HTTP_HINTS.get(int(code))
    if hint:
        return f"{base}\nHint: {hint}"
    return base


def format_web_fetch_url_error(url: str, reason: str) -> str:
    base = f"Error: Failed to fetch {url}: {reason}"
    low = str(reason or "").lower()
    if "10053" in low or "connection" in low or "reset" in low:
        return f"{base}\nHint: Connection dropped; try another URL once—avoid repeated fetch loops."
    return f"{base}\nHint: Network or TLS issue; try web_search or a different URL before retrying."
