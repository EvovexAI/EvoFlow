import { createHash } from "node:crypto";
import { z } from "zod";

export const sourceTypeSchema = z.enum(["github", "blog"]);
export const sourceSyncStatusSchema = z.enum([
  "idle",
  "syncing",
  "completed",
  "failed",
]);

export const storedSourceSyncStateSchema = z.object({
  contentHash: z.string().nullable(),
  cursor: z.string().nullable(),
  itemCount: z.number().int().min(0),
  lastError: z.string().nullable(),
  lastSyncedAt: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  sourceKey: z.string().trim().min(1),
  sourceType: sourceTypeSchema,
  status: sourceSyncStatusSchema,
  updatedAt: z.string(),
});

export const storedSourceRecordSchema = z.object({
  content: z.string(),
  contentHash: z.string().trim().min(1),
  createdAt: z.string(),
  metadata: z.record(z.string(), z.unknown()),
  pathOrUrl: z.string().trim().min(1),
  sourceId: z.string().trim().min(1),
  sourceKey: z.string().trim().min(1),
  sourceType: sourceTypeSchema,
  title: z.string().trim().min(1),
  updatedAt: z.string(),
});

export const sourceSyncStateStoreSchema = z.object({
  states: z.array(storedSourceSyncStateSchema),
});

export const sourceRecordStoreSchema = z.object({
  records: z.array(storedSourceRecordSchema),
});

export type SourceType = z.infer<typeof sourceTypeSchema>;
export type SourceSyncStatus = z.infer<typeof sourceSyncStatusSchema>;
export type StoredSourceSyncState = z.infer<typeof storedSourceSyncStateSchema>;
export type StoredSourceRecord = z.infer<typeof storedSourceRecordSchema>;

export interface SourceRecordInput {
  content: string;
  metadata?: Record<string, unknown>;
  pathOrUrl: string;
  sourceId: string;
  sourceKey: string;
  sourceType: SourceType;
  title: string;
  updatedAt: string;
}

export const MAX_SOURCE_RECORDS = 600;

export function normalizeSourceKey(value: string) {
  return value.replace(/\\/g, "/");
}

export function createSourceRecordCompositeKey(args: {
  sourceId: string;
  sourceKey: string;
  sourceType: SourceType;
}) {
  return `${args.sourceType}:${normalizeSourceKey(args.sourceKey)}:${args.sourceId}`;
}

export function createSourceSyncStateKey(args: {
  sourceKey: string;
  sourceType: SourceType;
}) {
  return `${args.sourceType}:${normalizeSourceKey(args.sourceKey)}`;
}

export function createContentHash(input: string) {
  return createHash("sha256").update(input).digest("hex");
}
