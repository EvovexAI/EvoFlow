"""Workspace code index (FTS5 + multi-language symbol extraction).

**When parsed**: during ``build_index()`` (explicit API/UI) or lazily on first search.

**Where stored**: ``$EVOFLOW_DATA_DIR/code_index/<workspace-hash>.db`` (see ``index_db_path``).

**Parsers**: LSP ``documentSymbol`` when a language server is on PATH (pyright, typescript-language-server);
Symbols: tree-sitter first (py/js/ts/java) via ``tree_sitter_core``; LSP optional; AST/regex fallback.
File import graph: ``file_deps`` table (py/js/ts/java). tree-sitter / javalang ship with evoflow-harness by default.
"""

from evoflow.code_index.hooks import notify_file_changed, notify_tool_result
from evoflow.code_index.store import (
    build_index,
    index_db_path,
    index_file,
    index_status,
    resolve_index_root,
    schedule_build_index,
    search_index,
)
from evoflow.code_index.watcher import index_watch_status, start_index_watch, stop_index_watch

__all__ = [
    "build_index",
    "index_db_path",
    "index_file",
    "index_status",
    "index_watch_status",
    "notify_file_changed",
    "notify_tool_result",
    "resolve_index_root",
    "schedule_build_index",
    "search_index",
    "start_index_watch",
    "stop_index_watch",
]
