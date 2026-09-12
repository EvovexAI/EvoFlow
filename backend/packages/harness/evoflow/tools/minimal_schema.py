"""Short wire descriptions for workspace / host-direct tools (no Args docstring bloat)."""

from __future__ import annotations

# One-line purpose only — routing policy stays in the system prompt.
READ_TOOL_DESCRIPTION = (
    "Read a file (workspace path or skill:<name>/relative/path); optional offset, limit, or symbol."
)
WRITE_TOOL_DESCRIPTION = (
    "Write or append file content. Put path before content in tool arguments. "
    "Split very large files across calls with append=True."
)
REPLACE_TOOL_DESCRIPTION = (
    "Replace text in a file. Put path before old_string/new_string in tool arguments; "
    "old_string must be unique unless regex=True (dry_run to preview)."
)
DELETE_TOOL_DESCRIPTION = "Delete a single file (not directories; system paths blocked)."

RG_TOOL_DESCRIPTION = (
    "Search file contents with ripgrep in the bound workspace. "
    "Uses native rg only (no FTS/index redirect); pipe in pattern is not search_code_index synonyms."
)
FIND_TOOL_DESCRIPTION = "Find files by glob pattern under a workspace directory."
SEARCH_CODE_INDEX_DESCRIPTION = (
    "Search workspace code index (symbols/FTS). Pipe in query means synonym terms, not regex."
)
TRACE_CALL_CHAIN_DESCRIPTION = (
    "Trace callers/callees from a symbol or file path via the workspace code index."
)

TERMINAL_TOOL_DESCRIPTION = (
    "Short shell command. workdir: path or skill:<name>. Long jobs → process."
)
READ_LINTS_DESCRIPTION = "Run linter/diagnostics on one Python/JS/TS/Java source file."
VIEW_IMAGE_DESCRIPTION = "Load or analyze a local image path or http(s) URL."
PROCESS_TOOL_DESCRIPTION = (
    "Background shell start|log|wait|kill; start supports workdir skill:<name>."
)

FETCH_URL_DESCRIPTION = "Fetch a URL and return readable markdown/text (http/https only)."
WEB_SEARCH_DESCRIPTION = (
    "Search the web. Use ai_daily or news_53ai for AI-news feeds; otherwise generic API search."
)

# Back-compat alias (prefer the named constants above).
MINIMAL_TOOL_DESCRIPTION = ""
