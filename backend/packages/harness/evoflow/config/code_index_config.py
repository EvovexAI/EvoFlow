"""Workspace code index configuration."""

from __future__ import annotations

import shutil

from pydantic import BaseModel, Field


class LspServerProfile(BaseModel):
    """External language server launched via stdio (JSON-RPC)."""

    name: str
    extensions: list[str] = Field(default_factory=list)
    command: list[str] = Field(default_factory=list)

    def command_available(self) -> bool:
        cmd = [str(c) for c in (self.command or []) if str(c).strip()]
        if not cmd:
            return False
        return shutil.which(cmd[0]) is not None


def _default_lsp_profiles() -> list[LspServerProfile]:
    return [
        LspServerProfile(
            name="python",
            extensions=[".py"],
            command=["pyright-langserver", "--stdio"],
        ),
        LspServerProfile(
            name="typescript",
            extensions=[".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
            command=["typescript-language-server", "--stdio"],
        ),
        LspServerProfile(
            name="java",
            extensions=[".java"],
            command=["jdtls"],
        ),
    ]


class CodeIndexConfig(BaseModel):
    enabled: bool = Field(default=True)
    max_files: int = Field(default=3000, ge=100)
    max_chars_per_file: int = Field(default=48_000, ge=1000)
    search_limit: int = Field(default=20, ge=1, le=100)
    search_wait_seconds: float = Field(
        default=2.0,
        ge=0.0,
        le=30.0,
        description="When index is building, poll index_status up to this many seconds; does not block until build completes",
    )
    reindex_min_interval_seconds: int = Field(default=300, ge=0)
    auto_index_on_search: bool = Field(default=True)
    incremental_enabled: bool = Field(default=True)
    watcher_enabled: bool = Field(
        default=False,
        description="When false, filesystem watcher does not auto-start; POST /api/workspaces/index-watch still works",
    )
    watcher_debounce_ms: int = Field(default=800, ge=100, le=10_000)
    lsp_enabled: bool = Field(default=True, description="Use LSP documentSymbol when server available")
    lsp_prefer: bool = Field(
        default=True,
        description="Prefer LSP symbols over AST/regex when both available",
    )
    lsp_timeout_seconds: float = Field(default=30.0, ge=5.0)
    lsp_max_files_per_build: int = Field(
        default=800,
        ge=0,
        description="Max files per full build that use LSP (0 = unlimited)",
    )
    lsp_profiles: list[LspServerProfile] = Field(default_factory=_default_lsp_profiles)
    index_parser_mode: str = Field(
        default="tree_sitter_first",
        description="tree_sitter_first (IDE-like) | lsp_first",
    )
    dependency_graph_enabled: bool = Field(default=True)
    dependency_search_hops: int = Field(default=1, ge=0, le=3)
    prefetch_dependency_hops: int = Field(default=1, ge=0, le=3)
    internal_refs_enabled: bool = Field(
        default=True,
        description="Index in-file uses of workspace imports (Python / JS / TS / Java)",
    )
    type_relations_enabled: bool = Field(
        default=True,
        description="Index class extends/implements within workspace (type_relations table)",
    )
    semantic_search_enabled: bool = Field(
        default=True,
        description="Generate file embeddings during indexing and use vector recall in search (hybrid FTS5 + semantic)",
    )
    semantic_embedding_dim: int = Field(
        default=512,
        ge=64,
        description="Embedding dimension for semantic search (must match the active embedding model; bge-small-zh=512)",
    )
    semantic_top_k: int = Field(
        default=15,
        ge=1,
        le=100,
        description="Max files to recall via vector similarity before merging with FTS5 results",
    )


_code_index_config = CodeIndexConfig()


def get_code_index_config() -> CodeIndexConfig:
    return _code_index_config


def load_code_index_config_from_dict(data: dict) -> None:
    global _code_index_config
    raw = dict(data or {})
    if "lsp_profiles" in raw and isinstance(raw["lsp_profiles"], list):
        raw["lsp_profiles"] = [LspServerProfile(**p) if isinstance(p, dict) else p for p in raw["lsp_profiles"]]
    _code_index_config = CodeIndexConfig(**raw)


def profile_for_suffix(suffix: str) -> LspServerProfile | None:
    suf = str(suffix or "").lower()
    if not suf.startswith("."):
        suf = f".{suf}"
    for profile in get_code_index_config().lsp_profiles:
        if suf in {str(e).lower() for e in profile.extensions}:
            if profile.command_available():
                return profile
    return None
