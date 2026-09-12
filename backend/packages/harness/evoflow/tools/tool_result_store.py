"""UI preview helpers for large tool outputs in chat transcript.

Full tool bodies live in ``evoflow_chat_messages.content_json`` (role=tool).
Stream/history/API slim through this module at read time only — nothing is offloaded
to a separate table or store on write.
"""

from __future__ import annotations

from typing import Any

_PREVIEW_MAX_CHARS = 1200
_OFFLOAD_MIN_CHARS = 1500

# Terminal-family tools: UI keeps current inline/stream behaviour.
_UI_SKIP_TOOL_NAMES = frozenset(
    {
        "terminal",
        "bash",
        "process",
        "run_terminal_cmd",
        "claude_session",
    }
)

_UI_OFFLOAD_TOOL_NAMES = frozenset(
    {
        "read",
        "read_file",
        "read_files",
        "read_context_slice",
        "grep",
        "rg",
        "search_code_index",
        "search_content",
        "web_fetch",
        "web_search",
        "fetch_url",
        "list_dir",
        "ls",
        "find_file",
        "worker",
        "read_lints",
        "fetch_url_tool",
    }
)

_UI_ALWAYS_OFFLOAD_READ_NAMES = frozenset(
    {
        "read",
        "read_file",
        "read_files",
        "read_context_slice",
    }
)

# Lazy modal tools: zero body in transcript/history; UI fetches via tool_call_id.
_UI_ALWAYS_OFFLOAD_EMPTY_NAMES = _UI_ALWAYS_OFFLOAD_READ_NAMES | frozenset(
    {
        "grep",
        "rg",
        "search_code_index",
        "search_content",
        "find_file",
        "web_search",
        "web_fetch",
        "fetch_url",
        "fetch_url_tool",
        "preview_url",
        "ls",
        "list_dir",
        "read_lints",
    }
)

# Retired built-in browser tools (agent-browser skill + terminal now). History-only UI slim.
_UI_RETIRED_BROWSER_TOOL_NAMES = frozenset(
    {
        "preview_url",
        "browser_navigate",
        "browser_click",
        "browser_type",
        "browser_scroll",
        "browser_back",
        "browser_snapshot",
        "browser_close",
        "browser_press",
        "browser_console",
        "browser_get_images",
    }
)


def _normalize_tool_name(name: str) -> str:
    return str(name or "tool").strip().lower()


def _is_lazy_empty_ui_tool(name: str) -> bool:
    n = _normalize_tool_name(name)
    return n in _UI_ALWAYS_OFFLOAD_EMPTY_NAMES or n in _UI_RETIRED_BROWSER_TOOL_NAMES

_READ_PREVIEW_MAX_CHARS = 480


def should_offload_for_ui(tool_name: str, content: str) -> bool:
    name = _normalize_tool_name(tool_name)
    if name in _UI_SKIP_TOOL_NAMES:
        return False
    text = str(content or "")
    if _is_lazy_empty_ui_tool(name):
        # Bodies never ship to chat UI — modal lazy-loads from evoflow_chat_messages.
        return bool(text.strip())
    if name not in _UI_OFFLOAD_TOOL_NAMES:
        return False
    return len(text) >= _OFFLOAD_MIN_CHARS


def build_preview_text(content: str, *, max_chars: int = _PREVIEW_MAX_CHARS, tool_name: str | None = None) -> str:
    raw = str(content or "")
    name = _normalize_tool_name(tool_name or "")
    cap = _READ_PREVIEW_MAX_CHARS if name in _UI_ALWAYS_OFFLOAD_READ_NAMES else max_chars
    if len(raw) <= cap:
        if name in _UI_ALWAYS_OFFLOAD_READ_NAMES and len(raw) > 80:
            lines = raw.splitlines()
            if len(lines) > 8:
                head = "\n".join(lines[:4])
                return f"{head}\n…（共 {len(lines):,} 行，点击「查看完整结果」加载）"
        return raw
    lines = raw.splitlines()
    if len(lines) <= 24:
        return raw[:cap] + f"\n…（共 {len(raw):,} 字符，点击「查看完整结果」加载）"
    head = "\n".join(lines[:12])
    tail = "\n".join(lines[-6:])
    preview = f"{head}\n…（共 {len(lines):,} 行 / {len(raw):,} 字符，点击「查看完整结果」加载）\n{tail}"
    if len(preview) > cap + 400:
        preview = preview[: cap + 400] + "…"
    return preview


def slim_content_for_ui(
    tool_call_id: str,
    tool_name: str,
    content: Any,
) -> tuple[Any, dict[str, Any]]:
    """Return (display_content, ui_meta). ui_meta empty when not slimmed."""
    del tool_call_id  # full body resolved from evoflow_chat_messages on expand
    name = _normalize_tool_name(tool_name)
    if name in _UI_SKIP_TOOL_NAMES:
        return content, {}

    text = content if isinstance(content, str) else str(content or "")
    if not should_offload_for_ui(tool_name, text):
        return content, {}

    byte_len = len(text.encode("utf-8"))
    meta = {
        "truncated": True,
        "content_bytes": byte_len,
        "output_truncated": True,
        "output_bytes": byte_len,
    }
    if _is_lazy_empty_ui_tool(name):
        # No preview text in transcript/history — avoids bloating browser memory.
        return "", meta

    preview = build_preview_text(text, tool_name=tool_name)
    return preview, meta
