import {
  getSourceSyncStateDatabase,
  listSourceSyncStatesDatabase,
  upsertSourceSyncStateDatabase,
} from "./source-sync-state-db";
import {
  getSourceSyncStateFile,
  listSourceSyncStatesFile,
  upsertSourceSyncStateFile,
} from "./source-sync-state-file";
import type {
  SourceType,
  SourceSyncStatus,
  StoredSourceSyncState,
} from "./source-state";

export type { StoredSourceSyncState, SourceType, SourceSyncStatus };

export async function getSourceSyncState(args: {
  sourceKey: string;
  sourceType: SourceType;
}) {
  const result = await getSourceSyncStateDatabase(args);
  return result === undefined ? getSourceSyncStateFile(args) : result;
}

export async function listSourceSyncStates(limit = 8) {
  const result = await listSourceSyncStatesDatabase(limit);
  return result ?? listSourceSyncStatesFile(limit);
}

export async function upsertSourceSyncState(args: {
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
  const result = await upsertSourceSyncStateDatabase(args);
  return result ?? upsertSourceSyncStateFile(args);
}
