import type {
  ConversationRow,
  TurnHeaderRow,
  UserInputRow,
  WorkflowLaunchMeta,
} from "@zcode/shared/zcode-protocol-v4";

/**
 * 中枢直接启动轮在转写里的规则。
 *
 * 启动元数据 turnHeader 优先（活投影权威），回落到用户可见行上的同一份（冷恢复 hydration 也写在
 * userInput 行）。元数据在场时该轮的 workflowLaunch 用户行**不是**可见输入——它的正文是面向模型的
 * 规范英文句，轮由 run 卡呈现；两处都缺席
 * 即退回普通渲染（那句话成气泡）。
 */
export function resolveWorkflowLaunchMeta(
  header: TurnHeaderRow | undefined,
  userInputs: readonly UserInputRow[],
): WorkflowLaunchMeta | undefined {
  if (header?.origin !== "workflowLaunch") return undefined;
  return (
    header.workflowLaunch ??
    userInputs.find((row) => row.workflowLaunch !== undefined)?.workflowLaunch
  );
}

/** 启动轮的用户行：元数据在场时由 run 卡代言，不进可见输入也不进流。 */
export function isWorkflowLaunchUserInputRow(row: ConversationRow): boolean {
  return row.kind === "userInput" && row.origin === "workflowLaunch";
}
