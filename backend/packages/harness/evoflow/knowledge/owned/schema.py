"""SQLite schema for owned knowledge base."""

from __future__ import annotations

import sqlite3

SCHEMA_VERSION = "11"

DDL = """
CREATE TABLE IF NOT EXISTS kb_schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS kb_bases (
  id                      TEXT PRIMARY KEY,
  name                    TEXT NOT NULL,
  description             TEXT NOT NULL DEFAULT '',
  chunk_size              INTEGER NOT NULL DEFAULT 512,
  chunk_overlap           INTEGER NOT NULL DEFAULT 80,
  chunk_strategy          TEXT NOT NULL DEFAULT 'auto',
  embedding_mode          TEXT NOT NULL DEFAULT 'cloud',
  embedding_model         TEXT NOT NULL DEFAULT 'text-embedding-3-small',
  embedding_base_url      TEXT NOT NULL DEFAULT '',
  embedding_api_key_ref   TEXT NOT NULL DEFAULT '',
  embedding_model_ref     TEXT NOT NULL DEFAULT '',
  embedding_dim           INTEGER,
  vector_enabled          INTEGER NOT NULL DEFAULT 1,
  keyword_enabled         INTEGER NOT NULL DEFAULT 1,
  wiki_enabled            INTEGER NOT NULL DEFAULT 0,
  graph_enabled           INTEGER NOT NULL DEFAULT 0,
  summary_enabled         INTEGER NOT NULL DEFAULT 1,
  image_caption_enabled   INTEGER NOT NULL DEFAULT 0,
  sync_source_type        TEXT NOT NULL DEFAULT '',
  sync_source_path        TEXT NOT NULL DEFAULT '',
  sync_vault_id           TEXT NOT NULL DEFAULT '',
  last_synced_at          TEXT,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL,
  deleted_at              TEXT
);

CREATE INDEX IF NOT EXISTS idx_kb_bases_updated
  ON kb_bases(updated_at DESC);

CREATE TABLE IF NOT EXISTS kb_documents (
  id              TEXT PRIMARY KEY,
  kb_id           TEXT NOT NULL,
  title           TEXT NOT NULL DEFAULT '',
  source_type     TEXT NOT NULL DEFAULT 'upload',
  file_name       TEXT NOT NULL DEFAULT '',
  mime            TEXT NOT NULL DEFAULT '',
  size_bytes      INTEGER NOT NULL DEFAULT 0,
  content_hash    TEXT NOT NULL DEFAULT '',
  blob_path       TEXT NOT NULL DEFAULT '',
  folder_path     TEXT NOT NULL DEFAULT '',
  sort_order      INTEGER NOT NULL DEFAULT 0,
  parse_status    TEXT NOT NULL DEFAULT 'pending',
  error_message   TEXT NOT NULL DEFAULT '',
  chunk_count     INTEGER NOT NULL DEFAULT 0,
  summary_status  TEXT NOT NULL DEFAULT 'none',
  summary_text    TEXT NOT NULL DEFAULT '',
  tags_json       TEXT NOT NULL DEFAULT '[]',
  frontmatter_json TEXT NOT NULL DEFAULT '{}',
  source_rel_path TEXT NOT NULL DEFAULT '',
  latest_job_id   TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  deleted_at      TEXT
);

CREATE INDEX IF NOT EXISTS idx_kb_docs_kb
  ON kb_documents(kb_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_kb_docs_status
  ON kb_documents(kb_id, parse_status);
CREATE INDEX IF NOT EXISTS idx_kb_docs_path
  ON kb_documents(kb_id, folder_path, file_name);

CREATE TABLE IF NOT EXISTS kb_folders (
  id              TEXT PRIMARY KEY,
  kb_id           TEXT NOT NULL,
  path            TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE (kb_id, path)
);

CREATE INDEX IF NOT EXISTS idx_kb_folders_kb
  ON kb_folders(kb_id, path);

CREATE TABLE IF NOT EXISTS kb_chunks (
  id              TEXT PRIMARY KEY,
  kb_id           TEXT NOT NULL,
  doc_id          TEXT NOT NULL,
  ordinal         INTEGER NOT NULL,
  content         TEXT NOT NULL,
  context_header  TEXT NOT NULL DEFAULT '',
  token_estimate  INTEGER NOT NULL DEFAULT 0,
  heading_path    TEXT NOT NULL DEFAULT '',
  chunk_kind      TEXT NOT NULL DEFAULT 'text',
  enabled         INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE (doc_id, ordinal)
);

CREATE INDEX IF NOT EXISTS idx_kb_chunks_kb_doc
  ON kb_chunks(kb_id, doc_id);

CREATE TABLE IF NOT EXISTS kb_chunk_embeddings (
  chunk_id        TEXT PRIMARY KEY,
  kb_id           TEXT NOT NULL,
  doc_id          TEXT NOT NULL,
  dim             INTEGER NOT NULL,
  embedding       BLOB NOT NULL,
  model           TEXT NOT NULL,
  created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_kb_emb_kb ON kb_chunk_embeddings(kb_id);

CREATE TABLE IF NOT EXISTS kb_assets (
  id              TEXT PRIMARY KEY,
  kb_id           TEXT NOT NULL,
  doc_id          TEXT NOT NULL,
  chunk_id        TEXT,
  kind            TEXT NOT NULL DEFAULT 'image',
  blob_path       TEXT NOT NULL,
  alt_text        TEXT NOT NULL DEFAULT '',
  caption_status  TEXT NOT NULL DEFAULT 'none',
  caption_text    TEXT NOT NULL DEFAULT '',
  width           INTEGER,
  height          INTEGER,
  created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_kb_assets_doc ON kb_assets(doc_id);

CREATE TABLE IF NOT EXISTS kb_jobs (
  id              TEXT PRIMARY KEY,
  kb_id           TEXT NOT NULL,
  doc_id          TEXT,
  type            TEXT NOT NULL,
  state           TEXT NOT NULL DEFAULT 'queued',
  attempts        INTEGER NOT NULL DEFAULT 0,
  max_attempts    INTEGER NOT NULL DEFAULT 3,
  priority        INTEGER NOT NULL DEFAULT 100,
  run_after       TEXT NOT NULL,
  progress_json   TEXT NOT NULL DEFAULT '{}',
  error_message   TEXT NOT NULL DEFAULT '',
  locked_by       TEXT NOT NULL DEFAULT '',
  locked_at       TEXT,
  payload_json    TEXT NOT NULL DEFAULT '{}',
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  finished_at     TEXT
);

CREATE INDEX IF NOT EXISTS idx_kb_jobs_claim
  ON kb_jobs(state, run_after, priority, created_at);
CREATE INDEX IF NOT EXISTS idx_kb_jobs_kb
  ON kb_jobs(kb_id, created_at DESC);

CREATE TABLE IF NOT EXISTS kb_activity (
  id           TEXT PRIMARY KEY,
  kb_id        TEXT,
  doc_id       TEXT,
  action       TEXT NOT NULL,
  actor        TEXT NOT NULL DEFAULT 'local',
  title        TEXT NOT NULL DEFAULT '',
  detail_json  TEXT NOT NULL DEFAULT '{}',
  created_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_kb_activity_kb_time
  ON kb_activity(kb_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_kb_activity_doc_time
  ON kb_activity(doc_id, created_at DESC) WHERE doc_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_kb_activity_time
  ON kb_activity(created_at DESC);

CREATE TABLE IF NOT EXISTS kb_doc_links (
  id              TEXT PRIMARY KEY,
  kb_id           TEXT NOT NULL,
  src_doc_id      TEXT NOT NULL,
  target_raw      TEXT NOT NULL,
  target_doc_id   TEXT,
  created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_kb_doc_links_src
  ON kb_doc_links(src_doc_id);
CREATE INDEX IF NOT EXISTS idx_kb_doc_links_dst
  ON kb_doc_links(kb_id, target_doc_id);
"""

WIKI_DDL = """
CREATE TABLE IF NOT EXISTS wiki_folders (
  id              TEXT PRIMARY KEY,
  kb_id           TEXT NOT NULL,
  parent_id       TEXT NOT NULL DEFAULT '',
  name            TEXT NOT NULL,
  path            TEXT NOT NULL,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  deleted_at      TEXT,
  UNIQUE (kb_id, path)
);

CREATE TABLE IF NOT EXISTS wiki_pages (
  id              TEXT PRIMARY KEY,
  kb_id           TEXT NOT NULL,
  slug            TEXT NOT NULL,
  title           TEXT NOT NULL,
  page_type       TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'published',
  folder_id       TEXT NOT NULL DEFAULT '',
  body_md         TEXT NOT NULL DEFAULT '',
  summary         TEXT NOT NULL DEFAULT '',
  aliases_json    TEXT NOT NULL DEFAULT '[]',
  source_refs_json TEXT NOT NULL DEFAULT '[]',
  chunk_refs_json TEXT NOT NULL DEFAULT '[]',
  in_links_json   TEXT NOT NULL DEFAULT '[]',
  out_links_json  TEXT NOT NULL DEFAULT '[]',
  version         INTEGER NOT NULL DEFAULT 1,
  last_edit_source TEXT NOT NULL DEFAULT 'pipeline',
  last_editor_id  TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  deleted_at      TEXT,
  UNIQUE (kb_id, slug)
);

CREATE INDEX IF NOT EXISTS idx_wiki_pages_kb_type
  ON wiki_pages(kb_id, page_type);

CREATE TABLE IF NOT EXISTS wiki_page_revisions (
  id              TEXT PRIMARY KEY,
  page_id         TEXT NOT NULL,
  version         INTEGER NOT NULL,
  title           TEXT NOT NULL,
  body_md         TEXT NOT NULL,
  summary         TEXT NOT NULL DEFAULT '',
  page_type       TEXT NOT NULL,
  status          TEXT NOT NULL,
  aliases_json    TEXT NOT NULL DEFAULT '[]',
  edit_source     TEXT NOT NULL,
  editor_id       TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL,
  UNIQUE (page_id, version)
);
"""

KG_DDL = """
CREATE TABLE IF NOT EXISTS kg_nodes (
  id              TEXT PRIMARY KEY,
  kb_id           TEXT NOT NULL,
  name            TEXT NOT NULL,
  attrs_json      TEXT NOT NULL DEFAULT '[]',
  chunk_ids_json  TEXT NOT NULL DEFAULT '[]',
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE (kb_id, name)
);

CREATE TABLE IF NOT EXISTS kg_edges (
  id              TEXT PRIMARY KEY,
  kb_id           TEXT NOT NULL,
  src_node_id     TEXT NOT NULL,
  dst_node_id     TEXT NOT NULL,
  rel_type        TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  UNIQUE (kb_id, src_node_id, dst_node_id, rel_type)
);

CREATE INDEX IF NOT EXISTS idx_kg_edges_src ON kg_edges(kb_id, src_node_id);
CREATE INDEX IF NOT EXISTS idx_kg_edges_dst ON kg_edges(kb_id, dst_node_id);
CREATE INDEX IF NOT EXISTS idx_kg_nodes_kb ON kg_nodes(kb_id);
"""

FTS_DDL = """
CREATE VIRTUAL TABLE IF NOT EXISTS kb_chunks_fts USING fts5(
  chunk_id UNINDEXED,
  kb_id UNINDEXED,
  doc_id UNINDEXED,
  content,
  tokenize = 'unicode61'
);
"""

# Unified agent memory atoms (see internal design docs (not published in this repository)).
# Same engine as owned KB; not user documents (kb_documents).
MEM_DDL = """
CREATE TABLE IF NOT EXISTS mem_namespaces (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,
  owner_ref     TEXT NOT NULL,
  title         TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mem_atoms (
  id                TEXT PRIMARY KEY,
  namespace_id       TEXT NOT NULL,
  layer             TEXT NOT NULL,
  kind              TEXT NOT NULL DEFAULT 'fact',
  content           TEXT NOT NULL,
  summary           TEXT NOT NULL DEFAULT '',
  importance        REAL NOT NULL DEFAULT 0.5,
  confidence        REAL NOT NULL DEFAULT 0.7,
  vitality          REAL NOT NULL DEFAULT 1.0,
  subject_key       TEXT NOT NULL DEFAULT '',
  evidence_json     TEXT NOT NULL DEFAULT '{}',
  tags_json         TEXT NOT NULL DEFAULT '[]',
  source            TEXT NOT NULL DEFAULT '',
  revision          INTEGER NOT NULL DEFAULT 1,
  pin               INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  last_accessed_at  TEXT,
  superseded_by     TEXT,
  deleted_at        TEXT,
  embedding         BLOB,
  embedding_dim     INTEGER,
  source_path       TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_mem_atoms_ns_layer
  ON mem_atoms(namespace_id, layer, importance DESC);
CREATE INDEX IF NOT EXISTS idx_mem_atoms_subject
  ON mem_atoms(namespace_id, subject_key);
CREATE INDEX IF NOT EXISTS idx_mem_atoms_pin
  ON mem_atoms(namespace_id, pin DESC, importance DESC);
CREATE INDEX IF NOT EXISTS idx_mem_meta_migrated
  ON mem_namespaces(kind, owner_ref);
"""

MEM_FTS_DDL = """
CREATE VIRTUAL TABLE IF NOT EXISTS mem_atoms_fts USING fts5(
  atom_id UNINDEXED,
  namespace_id UNINDEXED,
  content,
  tokenize = 'unicode61'
);
"""

MEM_ATOM_ENTITIES_DDL = """
CREATE TABLE IF NOT EXISTS mem_atom_entities (
  atom_id    TEXT NOT NULL,
  node_id    TEXT NOT NULL,
  kb_id      TEXT NOT NULL,
  role       TEXT NOT NULL DEFAULT 'about',
  PRIMARY KEY (atom_id, node_id, role)
);
CREATE INDEX IF NOT EXISTS idx_mem_atom_entities_node
  ON mem_atom_entities(kb_id, node_id);
CREATE INDEX IF NOT EXISTS idx_mem_atom_entities_atom
  ON mem_atom_entities(atom_id);
"""


def ensure_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(DDL)
    conn.executescript(WIKI_DDL)
    conn.executescript(KG_DDL)
    conn.executescript(MEM_DDL)
    try:
        conn.executescript(FTS_DDL)
    except sqlite3.OperationalError:
        # Some builds may lack FTS5; keyword search will degrade.
        pass
    try:
        conn.executescript(MEM_FTS_DDL)
    except sqlite3.OperationalError:
        pass
    conn.executescript(MEM_ATOM_ENTITIES_DDL)
    # Additive migrations for existing DBs (CREATE IF NOT EXISTS won't alter columns).
    doc_cols = {
        str(r[1]) for r in conn.execute("PRAGMA table_info(kb_documents)").fetchall()
    }
    if "sort_order" not in doc_cols:
        conn.execute(
            "ALTER TABLE kb_documents ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0"
        )
    if "tags_json" not in doc_cols:
        conn.execute(
            "ALTER TABLE kb_documents ADD COLUMN tags_json TEXT NOT NULL DEFAULT '[]'"
        )
    if "frontmatter_json" not in doc_cols:
        conn.execute(
            "ALTER TABLE kb_documents ADD COLUMN frontmatter_json TEXT NOT NULL DEFAULT '{}'"
        )
    if "source_rel_path" not in doc_cols:
        conn.execute(
            "ALTER TABLE kb_documents ADD COLUMN source_rel_path TEXT NOT NULL DEFAULT ''"
        )
    mem_cols = {
        str(r[1]) for r in conn.execute("PRAGMA table_info(mem_atoms)").fetchall()
    }
    if "source_path" not in mem_cols:
        conn.execute(
            "ALTER TABLE mem_atoms ADD COLUMN source_path TEXT NOT NULL DEFAULT ''"
        )
    ns_cols = {
        str(r[1]) for r in conn.execute("PRAGMA table_info(mem_namespaces)").fetchall()
    }
    for col, decl in (
        ("org_id", "TEXT"),
        ("owner_scope_id", "TEXT"),
        ("created_by", "TEXT"),
    ):
        if col not in ns_cols:
            conn.execute(f"ALTER TABLE mem_namespaces ADD COLUMN {col} {decl}")
    if ns_cols or True:
        conn.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_mem_namespaces_owner
                ON mem_namespaces(owner_scope_id)
            """
        )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS kb_doc_links (
          id              TEXT PRIMARY KEY,
          kb_id           TEXT NOT NULL,
          src_doc_id      TEXT NOT NULL,
          target_raw      TEXT NOT NULL,
          target_doc_id   TEXT,
          created_at      TEXT NOT NULL
        )
        """
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_kb_doc_links_src ON kb_doc_links(src_doc_id)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_kb_doc_links_dst ON kb_doc_links(kb_id, target_doc_id)"
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS kb_activity (
          id           TEXT PRIMARY KEY,
          kb_id        TEXT,
          doc_id       TEXT,
          action       TEXT NOT NULL,
          actor        TEXT NOT NULL DEFAULT 'local',
          title        TEXT NOT NULL DEFAULT '',
          detail_json  TEXT NOT NULL DEFAULT '{}',
          created_at   TEXT NOT NULL
        )
        """
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_kb_activity_kb_time ON kb_activity(kb_id, created_at DESC)"
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_kb_activity_doc_time
          ON kb_activity(doc_id, created_at DESC) WHERE doc_id IS NOT NULL
        """
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_kb_activity_time ON kb_activity(created_at DESC)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_kb_docs_path ON kb_documents(kb_id, folder_path, file_name)"
    )
    base_cols = {
        str(r[1]) for r in conn.execute("PRAGMA table_info(kb_bases)").fetchall()
    }
    for col, decl in (
        ("sync_source_type", "TEXT NOT NULL DEFAULT ''"),
        ("sync_source_path", "TEXT NOT NULL DEFAULT ''"),
        ("sync_vault_id", "TEXT NOT NULL DEFAULT ''"),
        ("last_synced_at", "TEXT"),
        ("embedding_model_ref", "TEXT NOT NULL DEFAULT ''"),
        ("org_id", "TEXT"),
        ("owner_scope_id", "TEXT"),
        ("created_by", "TEXT"),
    ):
        if col not in base_cols:
            conn.execute(f"ALTER TABLE kb_bases ADD COLUMN {col} {decl}")
    # Backfill unstamped KBs to primary org admin so non-admins don't see them.
    try:
        admin_row = conn.execute(
            """
            SELECT principal_id FROM evoflow_admin_grants
            WHERE org_id = 'local' AND role = 'org_admin'
            ORDER BY created_at ASC LIMIT 1
            """
        ).fetchone()
        # evoflow_admin_grants may live in the main app DB, not owned KB DB.
    except Exception:
        admin_row = None
    if not admin_row:
        # Owned KB uses a separate SQLite file — try resolving via harness principals.
        try:
            from evoflow.authz.principals import get_or_create_local_admin

            admin = get_or_create_local_admin()
            pid = str(admin.get("principal_id") or "").strip()
        except Exception:
            pid = ""
    else:
        pid = str(admin_row[0] or "").strip()
    if pid:
        try:
            conn.execute(
                """
                UPDATE kb_bases
                SET
                  org_id = COALESCE(NULLIF(org_id, ''), 'local'),
                  created_by = COALESCE(NULLIF(created_by, ''), ?),
                  owner_scope_id = COALESCE(NULLIF(owner_scope_id, ''), ?)
                WHERE deleted_at IS NULL
                  AND NULLIF(TRIM(COALESCE(owner_scope_id, '')), '') IS NULL
                """,
                (pid, f"personal:{pid}"),
            )
        except Exception:
            pass
    # Best-effort: bind legacy rows to registry names when possible.
    try:
        from evoflow.knowledge.owned.embedding_bind import match_registry_ref

        rows = conn.execute(
            """
            SELECT id, embedding_mode, embedding_model, embedding_base_url, embedding_model_ref
            FROM kb_bases
            WHERE deleted_at IS NULL
              AND (embedding_model_ref IS NULL OR embedding_model_ref = '')
            """
        ).fetchall()
        for r in rows:
            matched = match_registry_ref(
                mode=r["embedding_mode"] if isinstance(r, sqlite3.Row) else r[1],
                model=r["embedding_model"] if isinstance(r, sqlite3.Row) else r[2],
                base_url=r["embedding_base_url"] if isinstance(r, sqlite3.Row) else r[3],
            )
            if matched:
                kid = r["id"] if isinstance(r, sqlite3.Row) else r[0]
                conn.execute(
                    "UPDATE kb_bases SET embedding_model_ref=? WHERE id=?",
                    (matched, kid),
                )
    except Exception:
        pass
    row = conn.execute(
        "SELECT value FROM kb_schema_meta WHERE key = ?", ("schema_version",)
    ).fetchone()
    if not row:
        conn.execute(
            "INSERT INTO kb_schema_meta(key, value) VALUES (?, ?)",
            ("schema_version", SCHEMA_VERSION),
        )
    elif str(row["value"] if isinstance(row, sqlite3.Row) else row[0]) != SCHEMA_VERSION:
        conn.execute(
            "UPDATE kb_schema_meta SET value=? WHERE key=?",
            (SCHEMA_VERSION, "schema_version"),
        )
    conn.commit()
