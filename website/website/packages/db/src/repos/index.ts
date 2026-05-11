export * from "./evolution-runs";
export * from "./job-runs";
export * from "./knowledge-chunks";
export * from "./observability-runtime";
export * from "./runtime-files";
export * from "./runtime-observability";
export * from "./source-records";
export * from "./source-sync-state";

export const repositories = {
  evolutionRuns: "postgres-or-file",
  jobRuns: "postgres-or-file",
  runtimeObservability: "postgres-or-file",
  observabilityRuntime: "postgres-or-file",
  runtimeFiles: "workspace-runtime",
  sourceRecords: "postgres-or-file",
  sourceSyncState: "postgres-or-file",
} as const;

