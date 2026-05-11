import fs from "node:fs";
import {
  createSourceSyncStateKey,
  normalizeSourceKey,
  sourceSyncStateStoreSchema,
  type SourceType,
  type SourceSyncStatus,
  type StoredSourceSyncState,
} from "./source-state";
import { resolveRuntimeFilePath } from "./runtime-files";

const SOURCE_SYNC_STATE_FILE = resolveRuntimeFilePath(
  process.env.SOURCE_SYNC_STATE_FILENAME || "source-sync-state.json",
);

function createEmptyState() {
  return sourceSyncStateStoreSchema.parse({
    states: [],
  });
}

function readState() {
  try {
    const raw = fs.readFileSync(SOURCE_SYNC_STATE_FILE, "utf8");
    const parsed = sourceSyncStateStoreSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : createEmptyState();
  } catch {
    return createEmptyState();
  }
}

function writeState(state: ReturnType<typeof createEmptyState>) {
  fs.writeFileSync(SOURCE_SYNC_STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}

function updateState<T>(
  mutator: (state: ReturnType<typeof createEmptyState>) => T,
) {
  const state = readState();
  const result = mutator(state);
  writeState(state);
  return result;
}

export async function getSourceSyncStateFile(args: {
  sourceKey: string;
  sourceType: SourceType;
}) {
  const state = readState();
  const targetKey = createSourceSyncStateKey(args);

  return (
    state.states.find(
      (entry) =>
        createSourceSyncStateKey({
          sourceKey: entry.sourceKey,
          sourceType: entry.sourceType,
        }) === targetKey,
    ) ?? null
  );
}

export async function listSourceSyncStatesFile(limit = 8) {
  const state = readState();

  return [...state.states]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, limit);
}

export async function upsertSourceSyncStateFile(args: {
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
  return updateState((state) => {
    const nextState: StoredSourceSyncState = {
      contentHash: args.contentHash,
      cursor: args.cursor,
      itemCount: args.itemCount,
      lastError: args.lastError,
      lastSyncedAt: args.lastSyncedAt,
      metadata: args.metadata ?? {},
      sourceKey: normalizeSourceKey(args.sourceKey),
      sourceType: args.sourceType,
      status: args.status,
      updatedAt: new Date().toISOString(),
    };
    const stateKey = createSourceSyncStateKey(nextState);
    const existingIndex = state.states.findIndex(
      (entry) => createSourceSyncStateKey(entry) === stateKey,
    );

    if (existingIndex >= 0) {
      state.states[existingIndex] = nextState;
    } else {
      state.states.unshift(nextState);
    }

    return nextState;
  });
}
