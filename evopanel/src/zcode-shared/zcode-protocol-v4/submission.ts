import { z } from "zod";

/** Composer 可以显式提交的 Agent mode；auto 是 Runtime 内部状态，不进入用户 Submission。 */
export const submissionModeSchema = z.enum(["build", "edit", "plan", "yolo"]);
export type SubmissionMode = z.infer<typeof submissionModeSchema>;
