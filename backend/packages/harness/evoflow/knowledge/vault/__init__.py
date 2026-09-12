"""Knowledge Vault — Obsidian-backed first-class knowledge integration.

Separate from ``evoflow.knowledge`` document RAG datasets and from ``memory.json``.
"""

from evoflow.knowledge.vault import service as vault_service
from evoflow.knowledge.vault.models import (
    AccessMode,
    EmbeddingMode,
    KnowledgeCitation,
    KnowledgeGraph,
    KnowledgeGraphEdge,
    KnowledgeGraphNode,
    KnowledgeIngestRequest,
    KnowledgeNote,
    KnowledgeProviderStatus,
    KnowledgeSearchRequest,
    KnowledgeSearchResult,
    KnowledgeVaultConfig,
    KnowledgeWriteRequest,
    LaunchMode,
    ProviderType,
)
from evoflow.knowledge.vault.provider import KnowledgeProvider, ObsidianKnowledgeProvider, get_knowledge_provider

__all__ = [
    "AccessMode",
    "EmbeddingMode",
    "KnowledgeCitation",
    "KnowledgeGraph",
    "KnowledgeGraphEdge",
    "KnowledgeGraphNode",
    "KnowledgeNote",
    "KnowledgeProvider",
    "KnowledgeProviderStatus",
    "KnowledgeSearchRequest",
    "KnowledgeSearchResult",
    "KnowledgeVaultConfig",
    "KnowledgeWriteRequest",
    "KnowledgeIngestRequest",
    "LaunchMode",
    "ObsidianKnowledgeProvider",
    "ProviderType",
    "get_knowledge_provider",
    "vault_service",
]
