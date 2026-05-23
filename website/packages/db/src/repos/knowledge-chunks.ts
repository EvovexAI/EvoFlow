import { isPgvectorEnabled } from "../schema";
import { getDatabaseClient } from "../client";
import type { Sql } from "postgres";

export interface KnowledgeChunkRow {
  content: string;
  created_at: Date;
  embedding_model: string;
  id: string;
  locale: string;
  metadata: Record<string, unknown>;
  source_key: string;
  source_type: string;
  title: string;
  updated_at: Date;
}

export interface UpsertKnowledgeChunkInput {
  content: string;
  embedding?: number[];
  id: string;
  locale: string;
  metadata?: Record<string, unknown>;
  source_key: string;
  source_type: string;
  title: string;
}

export interface VectorSearchResult {
  content: string;
  id: string;
  locale: string;
  metadata: Record<string, unknown>;
  score: number;
  source_key: string;
  source_type: string;
  title: string;
}

async function withClient<T>(handler: (sql: Sql) => Promise<T>): Promise<T | undefined> {
  const client = await getDatabaseClient();
  if (!client) return undefined;
  return handler(client);
}

export async function upsertKnowledgeChunk(input: UpsertKnowledgeChunkInput) {
  return withClient(async (sql) => {
    const now = new Date();

    if (input.embedding && isPgvectorEnabled()) {
      const vectorLiteral = `[${input.embedding.join(",")}]`;
      await sql.unsafe(
        `INSERT INTO knowledge_chunks
           (id, source_type, source_key, title, content, locale, embedding_model, metadata, created_at, updated_at, embedding)
         VALUES ($1, $2, $3, $4, $5, $6, 'text-embedding-3-small', $7, $8, $8, $9::vector)
         ON CONFLICT (id) DO UPDATE SET
           title = EXCLUDED.title,
           content = EXCLUDED.content,
           locale = EXCLUDED.locale,
           embedding_model = EXCLUDED.embedding_model,
           metadata = EXCLUDED.metadata,
           updated_at = EXCLUDED.updated_at,
           embedding = EXCLUDED.embedding`,
        [
          input.id,
          input.source_type,
          input.source_key,
          input.title,
          input.content,
          input.locale,
          JSON.stringify(input.metadata ?? {}),
          now,
          vectorLiteral,
        ],
      );
    } else {
      await sql`
        INSERT INTO knowledge_chunks
          (id, source_type, source_key, title, content, locale, metadata, created_at, updated_at)
        VALUES (
          ${input.id}, ${input.source_type}, ${input.source_key},
          ${input.title}, ${input.content}, ${input.locale},
          ${JSON.stringify(input.metadata ?? {})}, ${now}, ${now}
        )
        ON CONFLICT (id) DO UPDATE SET
          title = EXCLUDED.title,
          content = EXCLUDED.content,
          locale = EXCLUDED.locale,
          metadata = EXCLUDED.metadata,
          updated_at = EXCLUDED.updated_at
      `;
    }
  });
}

export async function upsertKnowledgeChunksBatch(chunks: UpsertKnowledgeChunkInput[]) {
  for (const chunk of chunks) {
    await upsertKnowledgeChunk(chunk);
  }
}

export async function vectorSearchKnowledgeChunks({
  embedding,
  limit = 6,
  locale,
}: {
  embedding: number[];
  limit?: number;
  locale?: string;
}): Promise<VectorSearchResult[]> {
  if (!isPgvectorEnabled()) return [];

  const result = await withClient(async (sql) => {
    const vectorLiteral = `[${embedding.join(",")}]`;
    const localeFilter = locale ? `AND locale = '${locale.replace(/'/g, "''")}'` : "";

    const rows = await sql.unsafe<
      Array<{
        content: string;
        id: string;
        locale: string;
        metadata: Record<string, unknown>;
        score: number;
        source_key: string;
        source_type: string;
        title: string;
      }>
    >(
      `SELECT id, source_type, source_key, title, content, locale, metadata,
              1 - (embedding <=> $1::vector) AS score
       FROM knowledge_chunks
       WHERE embedding IS NOT NULL ${localeFilter}
       ORDER BY embedding <=> $1::vector
       LIMIT $2`,
      [vectorLiteral, limit],
    );

    return rows;
  });

  return result ?? [];
}

export async function deleteKnowledgeChunksBySource(sourceType: string, sourceKey: string) {
  return withClient(async (sql) => {
    await sql`
      DELETE FROM knowledge_chunks
      WHERE source_type = ${sourceType} AND source_key = ${sourceKey}
    `;
  });
}

/** Delete all chunks for a given source_type + locale (used for static content re-ingestion). */
export async function deleteKnowledgeChunksByTypeAndLocale(sourceType: string, locale: string) {
  return withClient(async (sql) => {
    await sql`
      DELETE FROM knowledge_chunks
      WHERE source_type = ${sourceType} AND locale = ${locale}
    `;
  });
}

export async function countKnowledgeChunks(locale?: string) {
  const result = await withClient(async (sql) => {
    if (locale) {
      const rows = await sql<[{ count: string }]>`
        SELECT COUNT(*)::text AS count FROM knowledge_chunks WHERE locale = ${locale}
      `;
      return Number(rows[0]?.count ?? 0);
    }

    const rows = await sql<[{ count: string }]>`
      SELECT COUNT(*)::text AS count FROM knowledge_chunks
    `;
    return Number(rows[0]?.count ?? 0);
  });

  return result ?? 0;
}

export async function listKnowledgeChunks({
  limit = 20,
  locale,
  sourceType,
}: {
  limit?: number;
  locale?: string;
  sourceType?: string;
} = {}): Promise<KnowledgeChunkRow[]> {
  const result = await withClient(async (sql) => {
    if (sourceType && locale) {
      return sql<KnowledgeChunkRow[]>`
        SELECT id, source_type, source_key, title, content, locale, embedding_model, metadata, created_at, updated_at
        FROM knowledge_chunks
        WHERE source_type = ${sourceType} AND locale = ${locale}
        ORDER BY updated_at DESC
        LIMIT ${limit}
      `;
    }
    if (sourceType) {
      return sql<KnowledgeChunkRow[]>`
        SELECT id, source_type, source_key, title, content, locale, embedding_model, metadata, created_at, updated_at
        FROM knowledge_chunks
        WHERE source_type = ${sourceType}
        ORDER BY updated_at DESC
        LIMIT ${limit}
      `;
    }
    if (locale) {
      return sql<KnowledgeChunkRow[]>`
        SELECT id, source_type, source_key, title, content, locale, embedding_model, metadata, created_at, updated_at
        FROM knowledge_chunks
        WHERE locale = ${locale}
        ORDER BY updated_at DESC
        LIMIT ${limit}
      `;
    }
    return sql<KnowledgeChunkRow[]>`
      SELECT id, source_type, source_key, title, content, locale, embedding_model, metadata, created_at, updated_at
      FROM knowledge_chunks
      ORDER BY updated_at DESC
      LIMIT ${limit}
    `;
  });

  return result ?? [];
}
