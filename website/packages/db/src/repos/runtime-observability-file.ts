import fs from "node:fs";
import { z } from "zod";
import { resolveRuntimeFilePath } from "./runtime-files";

const runtimeObservabilityStoreSchema = z.object({
  jobRuns: z.array(z.record(z.string(), z.unknown())).default([]),
  llmRuns: z.array(z.record(z.string(), z.unknown())).default([]),
  sessions: z.array(z.record(z.string(), z.unknown())).default([]),
  toolCalls: z.array(z.record(z.string(), z.unknown())).default([]),
  uiActions: z.array(z.record(z.string(), z.unknown())).default([]),
});

export async function getRuntimeObservabilitySnapshotFile() {
  const filePath = resolveRuntimeFilePath(
    process.env.OBSERVABILITY_STORE_FILENAME || "observability-store.json",
  );

  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = runtimeObservabilityStoreSchema.safeParse(JSON.parse(raw));

    if (!parsed.success) {
      throw new Error("invalid_runtime_observability_store");
    }

    const latestToolNames = parsed.data.toolCalls
      .map((entry) => {
        const toolName = entry.toolName;
        return typeof toolName === "string" ? toolName : null;
      })
      .filter((toolName): toolName is string => Boolean(toolName))
      .filter((toolName, index, array) => array.indexOf(toolName) === index)
      .slice(0, 4);

    return {
      counts: {
        jobRuns: parsed.data.jobRuns.length,
        llmRuns: parsed.data.llmRuns.length,
        sessions: parsed.data.sessions.length,
        toolCalls: parsed.data.toolCalls.length,
        uiActions: parsed.data.uiActions.length,
      },
      latestToolNames,
    };
  } catch {
    return {
      counts: {
        jobRuns: 0,
        llmRuns: 0,
        sessions: 0,
        toolCalls: 0,
        uiActions: 0,
      },
      latestToolNames: [] as string[],
    };
  }
}
