export type SkillSyncImportStatus = "synced" | "skipped" | "failed";

export const SKILL_SYNC_SIZE_LIMIT_ERROR_CODE = "SKILL_SYNC_SIZE_LIMIT_EXCEEDED" as const;

export type SkillSyncSizeLimitPhase = "selected-content" | "archive" | "extracted-content";

export interface SkillSyncSizeLimitErrorData {
  actualBytes: number;
  maxBytes: number;
  phase: SkillSyncSizeLimitPhase;
}

export interface SkillSyncCandidate {
  id: string;
  name: string;
  directoryName: string;
  description: string;
  path: string;
  sizeBytes: number;
}

export interface SkillSyncCandidateListResult {
  candidates: SkillSyncCandidate[];
  maxArchiveBytes: number;
}

export interface SkillSyncRemoteStatus {
  directoryName: string;
  exists: boolean;
  path?: string;
}

export interface SkillSyncRemoteStatusResult {
  statuses: SkillSyncRemoteStatus[];
}

export interface SkillSyncArchiveExportResult {
  archive: Uint8Array;
  archiveBytes: number;
  skills: Array<{
    id: string;
    name: string;
    directoryName: string;
  }>;
}

export interface SkillSyncImportResultItem {
  name: string;
  directoryName: string;
  status: SkillSyncImportStatus;
  path?: string;
  error?: string;
}

export interface SkillSyncImportResult {
  results: SkillSyncImportResultItem[];
}
