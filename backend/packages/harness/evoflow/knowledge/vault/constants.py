"""Pinned third-party MCP package versions and shared Knowledge Vault constants."""

from __future__ import annotations

# Do not use @latest — bump these deliberately when upgrading.
OHS_PACKAGE = "obsidian-hybrid-search@0.13.22"
OHS_BIN = "obsidian-hybrid-search-mcp"
OHS_TOOL_PREFIX = "evo_kb_"

WRITE_MCP_PACKAGE = "obsidian-mcp-server@3.2.9"

DEFAULT_INBOX_PATH = "00-Inbox"
DEFAULT_IGNORE_PATTERNS = ".obsidian/**,templates/**,*.canvas"
DEFAULT_OBSIDIAN_BASE_URL = "http://127.0.0.1:27123"

SEARCH_SERVER_NAME_PREFIX = "evoflow-kb-search-"
WRITE_SERVER_NAME_PREFIX = "evoflow-kb-write-"

# MCP tools exposed by search provider (after OBSIDIAN_PREFIX).
REQUIRED_SEARCH_TOOLS = frozenset({"search", "read", "reindex", "status"})

# Write MCP tools exposed to EvoFlow (MVP — no delete / execute_command).
ALLOWED_WRITE_TOOLS = frozenset(
    {
        "obsidian_get_note",
        "obsidian_list_notes",
        "obsidian_search_notes",
        "obsidian_write_note",
        "obsidian_append_to_note",
        "obsidian_patch_note",
        "obsidian_replace_in_note",
        "obsidian_manage_frontmatter",
        "obsidian_manage_tags",
        "obsidian_open_in_ui",
    }
)

BLOCKED_WRITE_TOOLS = frozenset(
    {
        "obsidian_delete_note",
        "obsidian_execute_command",
    }
)

MAX_READ_PATHS = 5
MAX_CONTENT_CHARS_DEFAULT = 12000
MAX_GRAPH_DEPTH = 3
MAX_GRAPH_NODES = 80
MAX_GRAPH_EDGES = 120
MAX_FULL_GRAPH_NODES = 500
MAX_FULL_GRAPH_EDGES = 2000
MAX_SEARCH_TOP_K = 20
MCP_RESTART_MAX = 3
VECTOR_SEARCH_TIMEOUT_SEC = 20.0
# Cold MCP stdio boot (Node + OHS). Keep short so interactive paths can fall back.
SESSION_BOOT_TIMEOUT_SEC = 25.0
# How long a user-facing search/status may wait for an in-progress MCP boot.
INTERACTIVE_MCP_WAIT_SEC = 6.0
FULLTEXT_SEARCH_TIMEOUT_SEC = 15.0
SECRET_ENC_PREFIX = "enc:v1:"

VAULTS_SETTINGS_KEY = "knowledge.vaults"
SECRETS_SETTINGS_KEY = "knowledge.vault.secrets"

# Reserved ids for packaged Obsidian vaults (see vault.builtin).
BUILTIN_USER_GUIDE_VAULT_ID = "evoflow-user-guide"
BUILTIN_OPS_KNOWLEDGE_VAULT_ID = "evoflow-ops-knowledge"

# Third-party attribution (docs / NOTICE).
THIRD_PARTY = (
    {
        "name": "obsidian-hybrid-search",
        "package": OHS_PACKAGE,
        "repo": "https://github.com/flowing-abyss/obsidian-hybrid-search",
        "license": "See upstream repository",
    },
    {
        "name": "obsidian-mcp-server",
        "package": WRITE_MCP_PACKAGE,
        "repo": "https://github.com/cyanheads/obsidian-mcp-server",
        "license": "See upstream repository",
    },
)
