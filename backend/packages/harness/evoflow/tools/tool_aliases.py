"""Normalize plan / agent YAML tool names to the host-direct tool catalog."""

from __future__ import annotations

# Plan and legacy agent configs often use retired sandbox names; map to current catalog.
_TOOL_NAME_ALIASES: dict[str, str] = {
    "read_file": "read",
    "write_file": "write",
    "write_to_file": "write",
    "str_replace": "replace",
    "replace_in_file": "replace",
    "delete_file": "delete",
    "find_file": "find",
    "list_dir": "terminal",
    "ls": "terminal",
    "search_content": "search_code_index",
    "ripgrep": "rg",
    "grep": "rg",
    "process_start": "process",
    "process_log": "process",
    "process_wait": "process",
    "process_kill": "process",
    "process_poll": "process",
    # fetch_url 已改名 fetch_url（短名）；旧配置白名单经此映射兼容，不失效
    "web_fetch_enhanced": "fetch_url",
    # Knowledge Vault: six tools → single ``knowledge(action=…)`` dispatcher
    "knowledge_search": "knowledge",
    "knowledge_read": "knowledge",
    "knowledge_graph": "knowledge",
    "knowledge_status": "knowledge",
    "knowledge_write": "knowledge",
    "knowledge_ingest": "knowledge",
    # Asset Hub: unified ``assets(action=…)`` — legacy names alias here (not separate LLM tools)
    "experience_save": "assets",
    "experience_list": "assets",
    "experience_get": "assets",
    "experience_update": "assets",
    "experience_mark_used": "assets",
    "experience_delete": "assets",
    "memory_remember": "assets",
    "person_memory_edit": "assets",
    "assets_search": "assets",
    "assets_read": "assets",
}

_FILE_IO_CANONICAL = frozenset(
    {
        "read",
        "write",
        "replace",
        "delete",
    }
)

# Long-running shell jobs: terminal alone is insufficient (skills reference process_*).
PROCESS_TOOL_SUITE = frozenset({"process"})


def augment_process_tools(matched: list[str], allowed: set[str]) -> list[str]:
    """If worker has ``terminal`` or any process tool, add the full process suite from catalog."""
    if not matched:
        return matched
    has_terminal = "terminal" in matched
    has_process = any(n in matched for n in PROCESS_TOOL_SUITE) or any(
        n in matched for n in ("process_start", "process_log", "process_wait", "process_kill", "process_poll")
    )
    if not has_terminal and not has_process:
        return matched
    out = list(matched)
    seen = set(out)
    for name in PROCESS_TOOL_SUITE:
        if name in allowed and name not in seen:
            seen.add(name)
            out.append(name)
    return out


def augment_worker_tool_allowlist(matched: list[str], allowed: set[str]) -> list[str]:
    """Apply alias normalization, file I/O and process/terminal augmentations after catalog resolution."""
    normalized = normalize_worker_tool_names(matched)
    return augment_process_tools(augment_file_io_tools(normalized, allowed), allowed)


def canonical_tool_name(name: str) -> str:
    """Map alias to catalog name; unknown names pass through unchanged."""
    raw = str(name or "").strip()
    if not raw:
        return ""
    return _TOOL_NAME_ALIASES.get(raw.lower(), raw)


def normalize_worker_tool_names(names: list[str] | None) -> list[str]:
    """Dedupe while preserving order after alias resolution."""
    if not names:
        return []
    out: list[str] = []
    seen: set[str] = set()
    for item in names:
        canon = canonical_tool_name(str(item))
        if canon and canon not in seen:
            seen.add(canon)
            out.append(canon)
    return out


def resolve_tools_against_catalog(
    requested: list[str] | None,
    allowed: set[str],
) -> tuple[list[str], list[str]]:
    """Return (matched catalog names, requested names with no catalog match after alias)."""
    normalized = normalize_worker_tool_names(requested)
    matched = [n for n in normalized if n in allowed]
    unknown = [n for n in normalized if n not in allowed]
    return matched, unknown


def augment_file_io_tools(matched: list[str], allowed: set[str]) -> list[str]:
    """If worker asked for any file tool, add siblings from the catalog when missing."""
    if not matched or not _FILE_IO_CANONICAL.intersection(matched):
        return matched
    out = list(matched)
    seen = set(out)
    for name in _FILE_IO_CANONICAL:
        if name in allowed and name not in seen:
            seen.add(name)
            out.append(name)
    return out


__all__ = [
    "canonical_tool_name",
    "normalize_worker_tool_names",
    "resolve_tools_against_catalog",
    "augment_file_io_tools",
    "augment_process_tools",
    "augment_worker_tool_allowlist",
    "PROCESS_TOOL_SUITE",
]
