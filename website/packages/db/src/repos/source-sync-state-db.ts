import { withDatabase } from "../client";
import { coerceJsonRecord, coerceTimestamp } from "./run-state";
import {
  normalizeSourceKey,
  type SourceType,
  type SourceSyncStatus,
  type StoredSourceSyncState,
} from "./source-state";

interface SourceSyncStateRow {
  content_hash: string | null;
  cursor: string | null;
  item_count: number;
  last_error: string | null;
  last_synced_at: string | null;
  metadata: unknown;
  source_key: string;
  source_type: SourceType;
  status: SourceSyncStatus;
  updated_at: string;
}

function mapSourceSyncStateRow(row: SourceSyncStateRow): StoredSourceSyncState {
  return {
    contentHash: row.content_hash,
    cursor: row.cursor,
    itemCount: Number(row.item_count ?? 0),
    lastError: row.last_error,
    lastSyncedAt: row.last_synced_at ? coerceTimestamp(row.last_synced_at) : null,
    metadata: coerceJsonRecord(row.metadata) ?? {},
    sourceKey: normalizeSourceKey(row.source_key),
    sourceType: row.source_type,
    status: row.status,
    updatedAt: coerceTimestamp(row.updated_at),
  };
}

export async function getSourceSyncStateDatabase(args: {
  sourceKey: string;
  sourceType: SourceType;
}) {
  return withDatabase(async (client) => {
    const rows = await client<SourceSyncStateRow[]>`
      SELECT *
      FROM source_sync_states
      WHERE source_type = ${args.sourceType}
        AND source_key = ${normalizeSourceKey(args.sourceKey)}
      LIMIT 1
    `;

    return rows[0] ? mapSourceSyncStateRow(rows[0]) : null;
  });
}

export async function listSourceSyncStatesDatabase(limit = 8) {
  return withDatabase(async (client) => {
    const rows = await client<SourceSyncStateRow[]>`
      SELECT *
      FROM source_sync_states
      ORDER BY updated_at DESC
      LIMIT ${limit}
    `;

    return rows.map(mapSourceSyncStateRow);
  });
}

export async function upsertSourceSyncStateDatabase(args: {
  contentHash: string | null;
  cursor: string | null;
  itemCount: number;
  lastError: string | null;
  lastSyncedAt: string | null;
  metadata?: Record<string, unknown>;
  sourceKey: string;
  sourceType: SourceType;
  status: SourceSyncStatus;
}) {
  return withDatabase(async (client) => {
    const updatedAt = new Date().toISOString();
    const rows = await client<SourceSyncStateRow[]>`
      INSERT INTO source_sync_states (
        source_type,
        source_key,
        status,
        updated_at,
        last_synced_at,
        cursor,
        content_hash,
        item_count,
        last_error,
        metadata
      ) VALUES (
        ${args.sourceType},
        ${normalizeSourceKey(args.sourceKey)},
        ${args.status},
        ${updatedAt},
        ${args.lastSyncedAt},
        ${args.cursor},
        ${args.contentHash},
        ${args.itemCount},
        ${args.lastError},
        ${JSON.stringify(args.metadata ?? {})}::jsonb
      )
      ON CONFLICT (source_type, source_key)
      DO UPDATE SET
        status = EXCLUDED.status,
        updated_at = EXCLUDED.updated_at,
        last_synced_at = EXCLUDED.last_synced_at,
        cursor = EXCLUDED.cursor,
        content_hash = EXCLUDED.content_hash,
        item_count = EXCLUDED.item_count,
        last_error = EXCLUDED.last_error,
        metadata = EXCLUDED.metadata
      RETURNING *
    `;

    return rows[0] ? mapSourceSyncStateRow(rows[0]) : null;
  });
}
