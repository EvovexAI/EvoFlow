"""Short wire descriptions for workspace / host-direct tools (no Args docstring bloat).

【self-evolution-bot · 2026-11-17 · 第33轮】原来这里写着「routing policy stays in the
system prompt」——即刻意不在工具描述里写「什么时候该用它」。后果实测：用户的提问
「为什么不用 search_code_index」答案就是系统提示词里该词出现 0 次、工具描述里也只有
一句偏温和的 "Use this FIRST"。能力写着、触发条件却没写，等于把是否使用交给模型自觉。
用户 2026-11-17 明确要求：**工具描述本身要强调优先用这个**。
所以本文件允许、且要求在描述里写清默认路由策略（描述是对所有 agent 生效的公共面，
比逐个岗位改提示词更根本）。"""

from __future__ import annotations

# 【self-evolution-bot · 2026-11-17 · 第33轮】此句原文是「One-line purpose only —
# routing policy stays in the system prompt」——已废弃：正是这条规矩让工具描述
# 只管「是什么」不管「什么时候该用」，实测后果见本文件顶部 docstring。
READ_TOOL_DESCRIPTION = (
    "Read a file (workspace path or skill:<name>/relative/path); optional offset, limit, or symbol.\n"
    "Format handling:\n"
    "- Images (jpg/jpeg/png/webp local paths, http(s) image URLs, browser-snapshot refs): "
    "loaded visually, not as text; a single ref or a list of up to 8 in one call.\n"
    "- PDF: text extracted per page (scanned/image-only pages yield no text); "
    'use `pages` (e.g. "1-5", "3", "10-"; max 20 pages/request; required for PDFs over 10 pages).\n'
    "- Office (doc/docx/ppt/pptx/xls/xlsx): converted to markdown automatically "
    "(xlsx → per-sheet tables; docx → paragraphs; pptx → per-slide text); "
    "offset/limit paginate the converted text.\n"
    "- Everything else: read as UTF-8 text by line. Binary files (zip, exe, …) "
    "are rejected with an error instead of garbage."
)
WRITE_TOOL_DESCRIPTION = (
    "Write or append file content. Put path before content in tool arguments. "
    "Split very large files across calls with append=True. Overwriting an existing file "
    "requires Read first, or the call fails; re-Read if it changed since your last Read."
)
REPLACE_TOOL_DESCRIPTION = (
    "Replace text in a file. Put path before old_string/new_string in tool arguments; "
    "old_string must be unique unless regex=True (dry_run to preview). "
    "You must Read the file in this conversation before editing, or the call will fail; "
    "re-Read if it changed since your last Read."
)
DELETE_TOOL_DESCRIPTION = "Delete a single file (not directories; system paths blocked)."

RG_TOOL_DESCRIPTION = "Search file contents with ripgrep in the bound workspace. Uses native rg only (no FTS/index redirect); pipe in pattern is not search_code_index synonyms."
FIND_TOOL_DESCRIPTION = "Find files by glob pattern under a workspace directory."
SEARCH_CODE_INDEX_DESCRIPTION = (
    "**USE THIS FIRST for code questions.** Search the indexed workspace (symbols + full-text) "
    "before reaching for rg/grep/find — one call usually replaces several rg + read round-trips.\n"
    "Default to it when: locating a function/class/variable by (partial) name, finding where a "
    "concept or behavior is implemented, you remember the words but not the path, or you need "
    "path:line before editing. Bare identifiers (`_check_explore_loops`) and phrases "
    "(`循环守卫 重复探索`) both work.\n"
    "- Pipe in query means synonym terms, NOT regex: `飞书|feishu|lark`.\n"
    "- Pass `queries=[...]` to try several phrasings in ONE call — cheaper than sequential retries.\n"
    "- Set `read_limit` (<=4) to get the definition body inline instead of a follow-up read.\n"
    "- Results carry `path:line`; jump straight to `read` with offset.\n"
    "- The first output line reports index age (`[index] last updated 6m ago`). If it is absent "
    "or old, results may predate your edits — say so instead of trusting them blindly.\n"
    "Skip it only when: you already know the exact path (use read), you need regex/structural "
    "pattern matching (use rg), or you are renaming/refactoring symbols. "
    "If it returns 0 hits, the file may not be indexed yet — fall back to rg rather than "
    "retrying the same query with different wording."
)

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
    "settings.test_web_search (do not keep retrying web_search or send users into Settings UI). "
    "`allowed_domains` / `blocked_domains` filter results by domain suffix (subdomains included); "
    "specify at most one of the two, never both."
)

# Back-compat alias (prefer the named constants above).
MINIMAL_TOOL_DESCRIPTION = ""
