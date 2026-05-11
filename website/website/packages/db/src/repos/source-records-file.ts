import fs from "node:fs";
import { coerceTimestamp } from "./run-state";
import {
  createContentHash,
  createSourceRecordCompositeKey,
  MAX_SOURCE_RECORDS,
  normalizeSourceKey,
  sourceRecordStoreSchema,
  type SourceRecordInput,
  type SourceType,
  type StoredSourceRecord,
} from "./source-state";
import { resolveRuntimeFilePath } from "./runtime-files";

const SOURCE_RECORDS_FILE = resolveRuntimeFilePath(
  process.env.SOURCE_RECORDS_FILENAME || "source-records.json",
);

function createEmptyState() {
  return sourceRecordStoreSchema.parse({
    records: [],
  });
}

function readState() {
  try {
    const raw = fs.readFileSync(SOURCE_RECORDS_FILE, "utf8");
    const parsed = sourceRecordStoreSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : createEmptyState();
  } catch {
    return createEmptyState();
  }
}

function writeState(state: ReturnType<typeof createEmptyState>) {
  fs.writeFileSync(
    SOURCE_RECORDS_FILE,
    JSON.stringify(
      {
        records: [...state.records]
          .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
          .slice(0, MAX_SOURCE_RECORDS),
      },
      null,
      2,
    ),
    "utf8",
  );
}

function updateState<T>(
  mutator: (state: ReturnType<typeof createEmptyState>) => T,
) {
  const state = readState();
  const result = mutator(state);
  writeState(state);
  return result;
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

export async function replaceSourceRecordsFile(args: {
  records: SourceRecordInput[];
  sourceKey: string;
  sourceType: SourceType;
}) {
  return updateState((state) => {
    const normalizedSourceKey = normalizeSourceKey(args.sourceKey);
    const nextRecords = args.records.map((record) =>
      createStoredSourceRecord({
        ...record,
        sourceKey: normalizedSourceKey,
        sourceType: args.sourceType,
      }),
    );

    state.records = state.records.filter(
      (record) =>
        !(
          record.sourceType === args.sourceType &&
          record.sourceKey === normalizedSourceKey
        ),
    );
    state.records.unshift(...nextRecords);

    return nextRecords;
  });
}

export async function listSourceRecordsFile(args?: {
  limit?: number;
  sourceKey?: string;
  sourceType?: SourceType;
}) {
  const state = readState();
  const filtered = state.records.filter((record) => {
    if (args?.sourceType && record.sourceType !== args.sourceType) {
      return false;
    }

    if (args?.sourceKey && record.sourceKey !== normalizeSourceKey(args.sourceKey)) {
      return false;
    }

    return true;
  });

  return filtered
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, args?.limit ?? 24);
}

export async function countSourceRecordsFile(args?: {
  sourceKey?: string;
  sourceType?: SourceType;
}) {
  const records = await listSourceRecordsFile({
    limit: MAX_SOURCE_RECORDS,
    sourceKey: args?.sourceKey,
    sourceType: args?.sourceType,
  });

  return records.length;
}

export async function getSourceRecordFile(args: {
  sourceId: string;
  sourceKey: string;
  sourceType: SourceType;
}) {
  const state = readState();
  const targetKey = createSourceRecordCompositeKey(args);

  return (
    state.records.find(
      (record) => createSourceRecordCompositeKey(record) === targetKey,
    ) ?? null
  );
}
