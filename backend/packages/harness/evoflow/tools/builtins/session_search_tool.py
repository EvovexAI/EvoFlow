"""Session Search Tool — retired; use ``evoflow sessions search`` via terminal + evoflow-admin skill."""

from __future__ import annotations

import json

from langchain.tools import tool

from evoflow.admin import sessions as sessions_admin
from evoflow.admin.errors import AdminError


@tool("session_search", parse_docstring=True)
def session_search_tool(
    query: str,
    *,
    search_titles: bool = False,
    max_results: int = 5,
    max_age_days: int = 90,
) -> str:
    """[Retired] Search past conversations — use ``evoflow sessions search --query …`` instead."""
    try:
        payload = sessions_admin.search_sessions(
            query,
            search_titles=search_titles,
            max_results=max_results,
            max_age_days=max_age_days,
        )
        return json.dumps(payload, ensure_ascii=False)
    except AdminError as e:
        return json.dumps({"error": e.message}, ensure_ascii=False)
