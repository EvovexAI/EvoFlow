"""Short wire descriptions for workspace / host-direct tools (no Args docstring bloat)."""

from __future__ import annotations

# One-line purpose only — routing policy stays in the system prompt.
READ_TOOL_DESCRIPTION = (
    "Read a file (workspace path or skill:<name>/relative/path); optional offset, limit, or symbol. "
    "Image refs (jpg/jpeg/png/webp local paths, http(s) image URLs, browser-snapshot refs) are loaded "
    "visually instead; accepts a single ref or a list of image refs (up to 8) in one call."
)
WRITE_TOOL_DESCRIPTION = "Write or append file content. Put path before content in tool arguments. Split very large files across calls with append=True."
REPLACE_TOOL_DESCRIPTION = "Replace text in a file. Put path before old_string/new_string in tool arguments; old_string must be unique unless regex=True (dry_run to preview)."
DELETE_TOOL_DESCRIPTION = "Delete a single file (not directories; system paths blocked)."

RG_TOOL_DESCRIPTION = "Search file contents with ripgrep in the bound workspace. Uses native rg only (no FTS/index redirect); pipe in pattern is not search_code_index synonyms."
FIND_TOOL_DESCRIPTION = "Find files by glob pattern under a workspace directory."
SEARCH_CODE_INDEX_DESCRIPTION = "Search workspace code index (symbols/FTS). Pipe in query means synonym terms, not regex."

TERMINAL_TOOL_DESCRIPTION = "Short shell command. workdir: path or skill:<name>. Long jobs → process."
READ_LINTS_DESCRIPTION = "Run linter/diagnostics on one Python/JS/TS/Java source file."
VIEW_IMAGE_DESCRIPTION = (
    "Load or analyze image(s): image_path is one local path / http(s) URL, "
    "or a list of paths/URLs (up to 8) for multiple images in one call."
)
PROCESS_TOOL_DESCRIPTION = "Background shell start|log|wait|kill; start supports workdir skill:<name>."

FETCH_URL_DESCRIPTION = (
    "Fetches a URL, converts the page to markdown, and — when `prompt` is given — "
    "answers the prompt against the page using a small fast model.\n"
    "- Public http/https URLs only; private/internal network URLs are blocked.\n"
    "- Cross-host redirects are returned to you rather than followed; call again with the redirect URL.\n"
    "- Responses are cached for 15 minutes per URL.\n"
    "- Prefer passing `prompt` so the conversation receives a distilled answer instead of the full page."
)
WEB_SEARCH_DESCRIPTION = (
    "Search the web. Use ai_daily or news_53ai for AI-news feeds; otherwise generic API search. "
    "If the result has needs_configuration=true: tell the user assistant_guide.say_to_user, "
    "then help configure via platform settings.get_web_search / settings.patch_web_search / "
    "settings.test_web_search (do not keep retrying web_search or send users into Settings UI)."
)

# Back-compat alias (prefer the named constants above).
MINIMAL_TOOL_DESCRIPTION = ""
