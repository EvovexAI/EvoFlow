import { z } from "zod";

export const BACKGROUND_BASH_OUTPUT_MAX_BYTES = 8192;

/** 后台详情的单次文件快照；不进入 conversation snapshot 或持久化事件。 */
export const backgroundBashOutputSchema = z.strictObject({
  kind: z.literal("output"),
  workId: z.string().min(1),
  status: z.enum(["running", "completed", "failed", "timed_out", "cancelled", "spawn_error"]),
  output: z.string().max(BACKGROUND_BASH_OUTPUT_MAX_BYTES),
  truncated: z.boolean(),
  outputPath: z.string().min(1),
});

export const backgroundBashOutputResultSchema = z.union([
  backgroundBashOutputSchema,
  z.strictObject({
    kind: z.enum(["unavailable", "unsupported", "read_failed"]),
    workId: z.string().min(1),
    code: z.string().optional(),
  }),
]);
export type BackgroundBashOutput = z.infer<typeof backgroundBashOutputSchema>;
export type BackgroundBashOutputResult = z.infer<typeof backgroundBashOutputResultSchema>;
