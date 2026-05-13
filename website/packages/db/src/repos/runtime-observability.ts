import { getRuntimeObservabilitySnapshotDatabase } from "./runtime-observability-db";
import { getRuntimeObservabilitySnapshotFile } from "./runtime-observability-file";

export async function getRuntimeObservabilitySnapshot() {
  const result = await getRuntimeObservabilitySnapshotDatabase();
  return result ?? getRuntimeObservabilitySnapshotFile();
}
