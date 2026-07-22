# Changelog — Knowledge Vault

## Unreleased

### Added

- **Obsidian Knowledge Vault** first-class integration (separate from document RAG KB and `memory.json`).
- Harness module `evoflow.knowledge.vault` with provider abstraction, path sandboxing, MCP runtime, and response normalization.
- Agent tools: `knowledge_search`, `knowledge_read`, `knowledge_graph`, `knowledge_write`, `knowledge_ingest`, `knowledge_status`.
- Builtin subagents: `knowledge-retriever`, `knowledge-curator`; skill `skills/public/knowledge-vault`.
- Gateway API under `/api/knowledge/vaults/*`.
- EvoPanel page `#/knowledge/vaults` (wizard, search, preview, local graph).
- Guide: `docs/user/guides/integrations/obsidian-knowledge-vault.md`.
- Pinned MCP packages: `obsidian-hybrid-search@0.13.22`, `obsidian-mcp-server@3.2.9` (via `npx`, not vendored).
