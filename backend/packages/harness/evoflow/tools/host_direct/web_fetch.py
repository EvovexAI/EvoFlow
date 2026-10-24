"""HostDirect web fetch tool — thin wrapper over the shared community web_fetch core.

The full implementation (security checks, 15-min cache, HTML→Markdown,
main-content extraction, cross-host redirect guard, prompt-driven processing)
lives in ``evoflow.community.web_fetch.tools``. This module keeps the
``web_fetch`` tool name used in HostDirect mode so the two execution modes
share one implementation instead of duplicating a parser.
"""

from typing import Literal

from langchain.tools import tool

from evoflow.community.web_fetch.prompt_processing import process_fetched_content_with_prompt
from evoflow.community.web_fetch.tools import (
    _is_portal_search_page,
    _resolve_session_model_name,
    fetch_page_markdown,
)
from evoflow.tools.minimal_schema import FETCH_URL_DESCRIPTION


@tool("web_fetch", description=FETCH_URL_DESCRIPTION, parse_docstring=False)
def web_fetch_hd(
    url: str,
    prompt: str = "",
    *,
    extract: Literal["full", "main-content", "text"] = "main-content",
    max_length: int = 50000,
    timeout: int = 15,
) -> str:
    """Fetch content from a URL."""
    if _is_portal_search_page(url):
        return "Error: This looks like a search/portal page. Use the `web_search` tool instead, then call `web_fetch` on specific result URLs."

    out_md, err, cache_hit = fetch_page_markdown(
        url,
        extract=extract,
        max_length=max_length,
        timeout=timeout,
        use_jina=False,  # HostDirect keeps HTTP-only fetch (no Jina dependency)
    )
    if out_md is None:
        return err or f"Error: Fetching {url} failed"

    # zcode alignment: prompt-driven processing via small model.
    if prompt and prompt.strip():
        model_name = _resolve_session_model_name()
        answer = process_fetched_content_with_prompt(out_md, prompt, model_name=model_name)
        if answer:
            meta = f"[WebFetch] url={url} | cached={str(cache_hit).lower()}"
            return f"{meta}\n\n{answer}"
        return f"{out_md}\n\n(note: prompt processing unavailable — full page content returned instead)"

    return out_md
