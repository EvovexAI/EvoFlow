import { z } from "zod";

export const sharedContextRefSchema = z
  .object({
    kind: z.literal("shared_context_import"),
    context_id: z.string().trim().min(1),
  })
  .strict();

export type SharedContextRef = z.infer<typeof sharedContextRefSchema>;
