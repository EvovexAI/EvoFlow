"""Pydantic domain models for Knowledge Vault (provider-agnostic)."""

from __future__ import annotations

from enum import Enum
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from evoflow.knowledge.vault.constants import (
    DEFAULT_IGNORE_PATTERNS,
    DEFAULT_INBOX_PATH,
    DEFAULT_OBSIDIAN_BASE_URL,
)


class ProviderType(str, Enum):
    obsidian = "obsidian"


class AccessMode(str, Enum):
    read_only = "read_only"
    read_write = "read_write"


class LaunchMode(str, Enum):
    managed_stdio = "managed_stdio"
    external_http = "external_http"


class EmbeddingMode(str, Enum):
    local = "local"
    openai_compatible = "openai_compatible"


class KnowledgeCitation(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    uri: str
    path: str
    heading: str | None = None


class KnowledgeSearchResult(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    vault_id: str = Field(alias="vaultId")
    path: str
    title: str = ""
    score: float | None = None
    snippet: str = ""
    tags: list[str] = Field(default_factory=list)
    aliases: list[str] = Field(default_factory=list)
    links: list[str] = Field(default_factory=list)
    backlinks: list[str] = Field(default_factory=list)
    provider: str = "obsidian-hybrid-search"
    citation: KnowledgeCitation | None = None


class KnowledgeNote(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    vault_id: str = Field(alias="vaultId")
    path: str
    title: str = ""
    content: str = ""
    frontmatter: dict[str, Any] = Field(default_factory=dict)
    tags: list[str] = Field(default_factory=list)
    aliases: list[str] = Field(default_factory=list)
    links: list[str] = Field(default_factory=list)
    backlinks: list[str] = Field(default_factory=list)
    modified_at: str | None = Field(default=None, alias="modifiedAt")
    citation: KnowledgeCitation | None = None


class KnowledgeGraphNode(BaseModel):
    id: str
    path: str
    title: str = ""
    tags: list[str] = Field(default_factory=list)


class KnowledgeGraphEdge(BaseModel):
    source: str
    target: str
    type: Literal["wikilink", "backlink"] = "wikilink"


class KnowledgeGraph(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    center_path: str = Field(alias="centerPath")
    depth: int = 1
    nodes: list[KnowledgeGraphNode] = Field(default_factory=list)
    edges: list[KnowledgeGraphEdge] = Field(default_factory=list)
    unresolved: list[str] = Field(default_factory=list)
    truncated: bool = False


class KnowledgeProviderStatus(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    vault_id: str = Field(alias="vaultId")
    enabled: bool = False
    access_mode: AccessMode = Field(default=AccessMode.read_write, alias="accessMode")
    launch_mode: LaunchMode = Field(default=LaunchMode.managed_stdio, alias="launchMode")
    vault_path_valid: bool = Field(default=False, alias="vaultPathValid")
    search_ready: bool = Field(default=False, alias="searchReady")
    write_ready: bool = Field(default=False, alias="writeReady")
    write_degraded: bool = Field(default=False, alias="writeDegraded")
    # Actual OHS MCP session readiness (distinct from filesystem searchReady).
    mcp_ready: bool = Field(default=False, alias="mcpReady")
    mcp_warming: bool = Field(default=False, alias="mcpWarming")
    note_count: int | None = Field(default=None, alias="noteCount")
    last_indexed_at: str | None = Field(default=None, alias="lastIndexedAt")
    obsidian_reachable: bool | None = Field(default=None, alias="obsidianReachable")
    allowed_read_paths: list[str] = Field(default_factory=list, alias="allowedReadPaths")
    allowed_write_paths: list[str] = Field(default_factory=list, alias="allowedWritePaths")
    search_error: str | None = Field(default=None, alias="searchError")
    write_error: str | None = Field(default=None, alias="writeError")
    node_runtime_ok: bool | None = Field(default=None, alias="nodeRuntimeOk")
    index_initialized: bool | None = Field(default=None, alias="indexInitialized")
    semantic_ready: bool | None = Field(default=None, alias="semanticReady")
    embedding_model: str | None = Field(default=None, alias="embeddingModel")
    runtime_status: dict[str, Any] | None = Field(default=None, alias="runtimeStatus")
    message: str = ""


class KnowledgeVaultConfig(BaseModel):
    """Persistent configuration for one Knowledge Vault connection."""

    model_config = ConfigDict(populate_by_name=True)

    id: str
    name: str
    enabled: bool = True
    # Product-shipped vault (e.g. docs/user). Protected from delete; path managed by materialize.
    builtin: bool = False
    provider_type: ProviderType = Field(default=ProviderType.obsidian, alias="providerType")
    vault_path: str = Field(alias="vaultPath")
    access_mode: AccessMode = Field(default=AccessMode.read_write, alias="accessMode")
    launch_mode: LaunchMode = Field(default=LaunchMode.managed_stdio, alias="launchMode")

    search_server_name: str = Field(default="", alias="searchServerName")
    search_server_url: str = Field(default="", alias="searchServerUrl")
    write_server_name: str = Field(default="", alias="writeServerName")
    write_server_url: str = Field(default="", alias="writeServerUrl")
    headers: dict[str, str] = Field(default_factory=dict)
    auth_secret_ref: str = Field(default="", alias="authSecretRef")
    allow_remote_http: bool = Field(default=False, alias="allowRemoteHttp")

    allowed_read_paths: list[str] = Field(default_factory=lambda: ["*"], alias="allowedReadPaths")
    allowed_write_paths: list[str] = Field(
        default_factory=lambda: ["*"],
        alias="allowedWritePaths",
    )
    default_inbox_path: str = Field(default=DEFAULT_INBOX_PATH, alias="defaultInboxPath")

    embedding_mode: EmbeddingMode = Field(default=EmbeddingMode.local, alias="embeddingMode")
    embedding_base_url: str = Field(default="", alias="embeddingBaseUrl")
    embedding_model: str = Field(default="", alias="embeddingModel")
    embedding_api_key_secret_ref: str = Field(default="", alias="embeddingApiKeySecretRef")

    obsidian_base_url: str = Field(default=DEFAULT_OBSIDIAN_BASE_URL, alias="obsidianBaseUrl")
    obsidian_api_key_secret_ref: str = Field(default="", alias="obsidianApiKeySecretRef")

    ignore_patterns: str = Field(default=DEFAULT_IGNORE_PATTERNS, alias="ignorePatterns")
    respect_gitignore: bool = Field(default=True, alias="respectGitignore")
    auto_reindex: bool = Field(default=True, alias="autoReindex")

    created_at: str = Field(default="", alias="createdAt")
    updated_at: str = Field(default="", alias="updatedAt")
    org_id: str | None = Field(default=None, alias="orgId")
    owner_scope_id: str | None = Field(default=None, alias="ownerScopeId")
    created_by: str | None = Field(default=None, alias="createdBy")

    @field_validator("id")
    @classmethod
    def _id_ok(cls, v: str) -> str:
        s = str(v or "").strip()
        if not s or len(s) > 64:
            raise ValueError("id must be 1-64 characters")
        if not all(c.isalnum() or c in "-_" for c in s):
            raise ValueError("id must be alphanumeric / hyphen / underscore")
        return s

    @field_validator("name")
    @classmethod
    def _name_ok(cls, v: str) -> str:
        s = str(v or "").strip()
        if not s:
            raise ValueError("name is required")
        return s[:200]

    @field_validator("vault_path")
    @classmethod
    def _path_ok(cls, v: str) -> str:
        s = str(v or "").strip()
        if not s:
            raise ValueError("vaultPath is required")
        return s

    @model_validator(mode="after")
    def _defaults(self) -> KnowledgeVaultConfig:
        if not self.search_server_name:
            self.search_server_name = f"evoflow-kb-search-{self.id}"
        if not self.write_server_name:
            self.write_server_name = f"evoflow-kb-write-{self.id}"
        if self.access_mode == AccessMode.read_only:
            # Keep write paths for when user upgrades; do not clear.
            pass
        if not self.allowed_read_paths:
            self.allowed_read_paths = ["*"]
        if not self.allowed_write_paths:
            self.allowed_write_paths = ["*"]
        return self

    def public_dict(self, *, has_obsidian_key: bool = False, has_embedding_key: bool = False) -> dict[str, Any]:
        """Serialize for API — never include secret values."""
        data = self.model_dump(by_alias=True, mode="json")
        data["hasObsidianApiKey"] = has_obsidian_key
        data["hasEmbeddingApiKey"] = has_embedding_key
        # Never echo secret refs as if they were values
        return data


class KnowledgeSearchRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    query: str
    vault_id: str | None = Field(default=None, alias="vaultId")
    mode: Literal["hybrid", "semantic", "fulltext", "title"] = "hybrid"
    top_k: int = Field(default=8, alias="topK", ge=1, le=20)
    tags: list[str] = Field(default_factory=list)
    scopes: list[str] = Field(default_factory=list)
    threshold: float | None = None
    rerank: bool = False


class KnowledgeWriteRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    vault_id: str = Field(alias="vaultId")
    operation: Literal["create", "append", "patch", "set_frontmatter", "update_tags"]
    path: str
    content: str = ""
    target: str = ""
    section: str | None = None
    key: str = ""
    value: Any = None
    add_tags: list[str] = Field(default_factory=list, alias="addTags")
    remove_tags: list[str] = Field(default_factory=list, alias="removeTags")


class KnowledgeIngestRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    vault_id: str = Field(alias="vaultId")
    title: str
    content: str
    summary: str = ""
    source: str = "evoflow"
    source_description: str = ""
    confidence: float = Field(default=0.7, ge=0.0, le=1.0)
    tags: list[str] = Field(default_factory=list)
    related_paths: list[str] = Field(default_factory=list, alias="relatedPaths")
    inbox_path: str | None = Field(default=None, alias="inboxPath")
