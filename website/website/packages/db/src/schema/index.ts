import type { Sql } from "postgres";

export const schemaVersion = "0.2.0";

const schemaStatements = [
  `CREATE TABLE IF NOT EXISTS worker_heartbeats (
    worker_id TEXT PRIMARY KEY,
    updated_at TIMESTAMPTZ NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS job_runs (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    locale TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    worker_id TEXT,
    error TEXT,
    log_lines JSONB NOT NULL DEFAULT '[]'::jsonb,
    result JSONB,
    observability_recorded BOOLEAN NOT NULL DEFAULT FALSE
  )`,
  `CREATE INDEX IF NOT EXISTS idx_job_runs_created_at ON job_runs (created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_job_runs_status ON job_runs (status)`,
  `CREATE TABLE IF NOT EXISTS evolution_runs (
    id TEXT PRIMARY KEY,
    action TEXT NOT NULL,
    locale TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    worker_id TEXT,
    error TEXT,
    log_lines JSONB NOT NULL DEFAULT '[]'::jsonb,
    result JSONB,
    observability_recorded BOOLEAN NOT NULL DEFAULT FALSE
  )`,
  `CREATE INDEX IF NOT EXISTS idx_evolution_runs_created_at ON evolution_runs (created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_evolution_runs_status ON evolution_runs (status)`,
  `CREATE TABLE IF NOT EXISTS observability_llm_runs (
    id BIGSERIAL PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL,
    route TEXT NOT NULL,
    summary TEXT NOT NULL,
    surface TEXT NOT NULL,
    session_id TEXT,
    model TEXT NOT NULL,
    prompt_type TEXT,
    status TEXT NOT NULL,
    latency_ms INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS observability_tool_calls (
    id BIGSERIAL PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL,
    detail TEXT NOT NULL,
    route TEXT NOT NULL,
    surface TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    status TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS observability_job_runs (
    id BIGSERIAL PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL,
    duration_ms INTEGER NOT NULL,
    route TEXT NOT NULL,
    summary TEXT NOT NULL,
    job_name TEXT NOT NULL,
    status TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS observability_ui_actions (
    id BIGSERIAL PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL,
    label TEXT NOT NULL,
    route TEXT NOT NULL,
    action_name TEXT NOT NULL,
    source TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS observability_visitor_sessions (
    id BIGSERIAL PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL,
    location TEXT NOT NULL,
    route TEXT NOT NULL,
    state TEXT NOT NULL,
    summary TEXT NOT NULL,
    surface TEXT NOT NULL,
    visitor_id TEXT NOT NULL,
    landing_route TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS source_sync_states (
    source_type TEXT NOT NULL,
    source_key TEXT NOT NULL,
    status TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    last_synced_at TIMESTAMPTZ,
    cursor TEXT,
    content_hash TEXT,
    item_count INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    PRIMARY KEY (source_type, source_key)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_source_sync_states_updated_at ON source_sync_states (updated_at DESC)`,
  `CREATE TABLE IF NOT EXISTS source_records (
    source_type TEXT NOT NULL,
    source_key TEXT NOT NULL,
    source_id TEXT NOT NULL,
    title TEXT NOT NULL,
    path_or_url TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    content TEXT NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    content_hash TEXT NOT NULL,
    PRIMARY KEY (source_type, source_key, source_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_source_records_updated_at ON source_records (updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_source_records_source_type ON source_records (source_type, updated_at DESC)`,
  // Knowledge chunks with pgvector embeddings (text-embedding-3-small = 1536 dims)
  // pgvector extension must be installed on the server; we attempt it gracefully.
  `CREATE TABLE IF NOT EXISTS knowledge_chunks (
    id TEXT PRIMARY KEY,
    source_type TEXT NOT NULL,
    source_key TEXT NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    locale TEXT NOT NULL DEFAULT 'zh',
    embedding_model TEXT NOT NULL DEFAULT 'text-embedding-3-small',
    metadata JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_source ON knowledge_chunks (source_type, source_key)`,
  `CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_locale ON knowledge_chunks (locale)`,
];

let schemaReadyPromise: Promise<void> | null = null;

// Whether this database instance has pgvector available
let pgvectorEnabled = false;

export function isPgvectorEnabled() {
  return pgvectorEnabled;
}

export async function ensureDatabaseSchema(client: Sql) {
  if (!schemaReadyPromise) {
    schemaReadyPromise = (async () => {
      for (const statement of schemaStatements) {
        await client.unsafe(statement);
      }

      // Attempt to enable pgvector extension and add embedding column.
      // Silently skip if pgvector is not installed on this server.
      try {
        await client.unsafe(`CREATE EXTENSION IF NOT EXISTS vector`);
        await client.unsafe(
          `ALTER TABLE knowledge_chunks ADD COLUMN IF NOT EXISTS embedding vector(1536)`,
        );
        await client.unsafe(
          `CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_embedding
           ON knowledge_chunks USING ivfflat (embedding vector_cosine_ops)
           WITH (lists = 50)`,
        );
        pgvectorEnabled = true;
      } catch {
        // pgvector not available — knowledge retrieval will use TF-IDF fallback
      }
    })();
  }

  return schemaReadyPromise;
}

