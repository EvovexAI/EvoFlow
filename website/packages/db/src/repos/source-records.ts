import {
  countSourceRecordsDatabase,
  getSourceRecordDatabase,
  listSourceRecordsDatabase,
  replaceSourceRecordsDatabase,
} from "./source-records-db";
import {
  countSourceRecordsFile,
  getSourceRecordFile,
  listSourceRecordsFile,
  replaceSourceRecordsFile,
} from "./source-records-file";
import type {
  SourceRecordInput,
  SourceType,
  StoredSourceRecord,
} from "./source-state";

export type { StoredSourceRecord, SourceRecordInput, SourceType };

export async function replaceSourceRecords(args: {
  records: SourceRecordInput[];
  sourceKey: string;
  sourceType: SourceType;
}) {
  const result = await replaceSourceRecordsDatabase(args);
  return result ?? replaceSourceRecordsFile(args);
}

export async function listSourceRecords(args?: {
  limit?: number;
  sourceKey?: string;
  sourceType?: SourceType;
}) {
  const result = await listSourceRecordsDatabase(args);
  return result ?? listSourceRecordsFile(args);
}

export async function countSourceRecords(args?: {
  sourceKey?: string;
  sourceType?: SourceType;
}) {
  const result = await countSourceRecordsDatabase(args);
  return result ?? countSourceRecordsFile(args);
}

export async function getSourceRecord(args: {
  sourceId: string;
  sourceKey: string;
  sourceType: SourceType;
}) {
  const result = await getSourceRecordDatabase(args);
  return result === undefined ? getSourceRecordFile(args) : result;
}
