import { z } from "zod";

// Bash 原始文件不会进入协议；仅传递有界头部与真实截断/文件保留事实。
export const bashOutputDisplaySchema = z
  .object({
    kind: z.literal("bash_output"),
    output: z.string().max(150_000),
    truncated: z.boolean(),
    outputPath: z.string().min(1).max(32_768).optional(),
  })
  .strict();
