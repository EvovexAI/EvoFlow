import { z } from "zod";

const OUTPUT_PREVIEW_MAX_CHARACTERS = 4096;
/** 两端共用的 Bash 有界输出内容；不包含 replayable 传输恢复状态。 */
export const executionOutputPreviewSchema = z
  .object({
    text: z.string().max(OUTPUT_PREVIEW_MAX_CHARACTERS),
    fullText: z.string().max(OUTPUT_PREVIEW_MAX_CHARACTERS),
    totalLines: z.number().int().nonnegative(),
    totalBytes: z.number().int().nonnegative(),
    linesEstimated: z.boolean(),
  })
  .strict();
export type ExecutionOutputPreview = z.infer<typeof executionOutputPreviewSchema>;
