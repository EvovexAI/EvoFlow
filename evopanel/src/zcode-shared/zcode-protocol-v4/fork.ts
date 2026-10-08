import { z } from "zod";

/** V4 stable assistant fork 的固定 logical-turn 边界。 */
export const stableForkTargetSchema = z
  .object({
    productTurnId: z.string().min(1),
    transcriptTurnId: z.string().min(1),
    orderedMessageIds: z.array(z.string().min(1)).min(1),
    boundaryMessageId: z.string().min(1),
  })
  .strict()
  .refine((target) => target.orderedMessageIds.at(-1) === target.boundaryMessageId, {
    message: "boundaryMessageId must be the final orderedMessageId",
    path: ["boundaryMessageId"],
  });

export type StableForkTarget = z.infer<typeof stableForkTargetSchema>;

export type StableForkTargetResolution =
  | { ok: true; target: StableForkTarget }
  | {
      ok: false;
      reasonCode:
        | "guard.forkAssistantOnly"
        | "guard.forkTargetNotStable"
        | "guard.forkTargetAmbiguous"
        | "guard.compactOperationLock";
    };
