"""Citation policy appended to web_search / web_fetch tool schemas (not system prompt)."""

WEB_CITATION_POLICY_FOR_TOOLS = """
Citation policy:
- Cite sources in the body and list them at the end; do not state external facts as certain without reliable sources.
- If a search uses "today" or "this month", align with current system time in the workspace block; if the user names a historical period, use that instead.
""".strip()


def append_web_citation_policy(description: str) -> str:
    base = str(description or "").rstrip()
    if not base:
        return WEB_CITATION_POLICY_FOR_TOOLS
    return f"{base}\n\n{WEB_CITATION_POLICY_FOR_TOOLS}"
