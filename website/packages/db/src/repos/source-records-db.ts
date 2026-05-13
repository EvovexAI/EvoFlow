import { withDatabase } from "../client";
import { coerceJsonRecord, coerceTimestamp } from "./run-state";
import {
  createContentHash,
  MAX_SOURCE_RECORDS,
  normalizeSourceKey,
  type SourceRecordInput,
  type SourceType,
  type StoredSourceRecord,
} from "./source-state";

interface SourceRecordRow {
  content: string;
  content_hash: string;
  created_at: string;
  metadata: unknown;
  path_or_url: string;
  source_id: string;
  source_key: string;
  source_type: SourceType;
  title: string;
  updated_at: string;
}

function mapSourceRecordRow(row: SourceRecordRow): StoredSourceRecord {
  return {
    content: row.content,
    contentHash: row.content_hash,
    createdAt: coerceTimestamp(row.created_at),
    metadata: coerceJsonRecord(row.metadata) ?? {},
    pathOrUrl: row.path_or_url,
    sourceId: row.source_id,
    sourceKey: normalizeSourceKey(row.source_key),
    sourceType: row.source_type,
    title: row.title,
    updatedAt: coerceTimestamp(row.updated_at),
  };
}

function createStoredSourceRecord(input: SourceRecordInput): StoredSourceRecord {
  const content = input.content.trim();

  return {
    content,
    contentHash: createContentHash(
      JSON.stringify({
        content,
        metadata: input.metadata ?? {},
        pathOrUrl: input.pathOrUrl,
        title: input.title,
        updatedAt: input.updatedAt,
      }),
    ),
    createdAt: new Date().toISOString(),
    metadata: input.metadata ?? {},
    pathOrUrl: input.pathOrUrl,
    sourceId: input.sourceId,
    sourceKey: normalizeSourceKey(input.sourceKey),
    sourceType: input.sourceType,
    title: input.title,
    updatedAt: coerceTimestamp(input.updatedAt),
  };
}

async function trimSourceRecords() {
  return withDatabase(async (client) => {
    await client`
      DELETE FROM source_records
      WHERE (source_type, source_key, source_id) NOT IN (
        SELECT source_type, source_key, source_id
        FROM source_records
        ORDER BY updated_at DESC
        LIMIT ${MAX_SOURCE_RECORDS}
      )
    `;
  });
}

export async function replaceSourceRecordsDatabase(args: {
  records: SourceRecordInput[];
  sourceKey: string;
  sourceType: SourceType;
}) {
  return withDatabase(async (client) => {
    const normalizedSourceKey = normalizeSourceKey(args.sourceKey);
    const nextRecords = args.records.map((record) =>
      createStoredSourceRecord({
        ...record,
        sourceKey: normalizedSourceKey,
        sourceType: args.sourceType,
      }),
    );

    await client.begin(async (transaction) => {
      await transaction`
        DELETE FROM source_records
        WHERE source_type = ${args.sourceType}
          AND source_key = ${normalizedSourceKey}
      `;

      for (const record of nextRecords) {
        await transaction`
          INSERT INTO source_records (
            source_type,
            source_key,
            source_id,
            title,
            path_or_url,
            updated_at,
            created_at,
            content,
            metadata,
            content_hash
          ) VALUES (
            ${record.sourceType},
            ${record.sourceKey},
            ${record.sourceId},
            ${record.title},
            ${record.pathOrUrl},
            ${record.updatedAt},
            ${record.createdAt},
            ${record.content},
            ${JSON.stringify(record.metadata)}::jsonb,
            ${record.contentHash}
          )
        `;
      }
    });
    await trimSourceRecords();

    return nextRecords;
  });
}

export async function listSourceRecordsDatabase(args?: {
  limit?: number;
  sourceKey?: string;
  sourceType?: SourceType;
}) {
  return withDatabase(async (client) => {
    const normalizedSourceKey = args?.sourceKey
      ? normalizeSourceKey(args.sourceKey)
      : null;

    if (args?.sourceType && normalizedSourceKey) {
      const rows = await client<SourceRecordRow[]>`
        SELECT *
        FROM source_records
        WHERE source_type = ${args.sourceType}
          AND source_key = ${normalizedSourceKey}
        ORDER BY updated_at DESC
        LIMIT ${args.limit ?? 24}
      `;

      return rows.map(mapSourceRecordRow);
    }

    if (args?.sourceType) {
      const rows = await client<SourceRecordRow[]>`
        SELECT *
        FROM source_records
        WHERE source_type = ${args.sourceType}
        ORDER BY updated_at DESC
        LIMIT ${args.limit ?? 24}
      `;

      return rows.map(mapSourceRecordRow);
    }

    if (normalizedSourceKey) {
      const rows = await client<SourceRecordRow[]>`
        SELECT *
        FROM source_records
        WHERE source_key = ${normalizedSourceKey}
        ORDER BY updated_at DESC
        LIMIT ${args?.limit ?? 24}
      `;

      return rows.map(mapSourceRecordRow);
    }

    const rows = await client<SourceRecordRow[]>`
      SELECT *
      FROM source_records
      ORDER BY updated_at DESC
      LIMIT ${args?.limit ?? 24}
    `;

    return rows.map(mapSourceRecordRow);
  });
}

export async function countSourceRecordsDatabase(args?: {
  sourceKey?: string;
  sourceType?: SourceType;
}) {
  return withDatabase(async (client) => {
    const normalizedSourceKey = args?.sourceKey
      ? normalizeSourceKey(args.sourceKey)
      : null;

    if (args?.sourceType && normalizedSourceKey) {
      const rows = await client<{ total: number }[]>`
        SELECT COUNT(*)::int AS total
        FROM source_records
        WHERE source_type = ${args.sourceType}
          AND source_key = ${normalizedSourceKey}
      `;

      return Number(rows[0]?.total ?? 0);
    }

    if (args?.sourceType) {
      const rows = await client<{ total: number }[]>`
        SELECT COUNT(*)::int AS total
        FROM source_records
        WHERE source_type = ${args.sourceType}
      `;

      return Number(rows[0]?.total ?? 0);
    }

    if (normalizedSourceKey) {
      const rows = await client<{ total: number }[]>`
        SELECT COUNT(*)::int AS total
        FROM source_records
        WHERE source_key = ${normalizedSourceKey}
      `;

      return Number(rows[0]?.total ?? 0);
    }

    const rows = await client<{ total: number }[]>`
      SELECT COUNT(*)::int AS total
      FROM source_records
    `;

    return Number(rows[0]?.total ?? 0);
  });
}

export async function getSourceRecordDatabase(args: {
  sourceId: string;
  sourceKey: string;
  sourceType: SourceType;
}) {
  return withDatabase(async (client) => {
    const rows = await client<SourceRecordRow[]>`
      SELECT *
      FROM source_records
      WHERE source_type = ${args.sourceType}
        AND source_key = ${normalizeSourceKey(args.sourceKey)}
        AND source_id = ${args.sourceId}
      LIMIT 1
    `;

    return rows[0] ? mapSourceRecordRow(rows[0]) : null;
  });
}
