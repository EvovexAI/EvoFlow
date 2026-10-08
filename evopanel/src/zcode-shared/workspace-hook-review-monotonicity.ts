/**
 * Review 单调性单一裁决函数。
 *
 * 背景：`reviewFlowId/generation 只在单个 Runtime controller 内单调` 这条规则若在
 * product projection（事件回放）、prompt-turn observer（live monitor）、renderer
 * review store（binding 展示）三处独立重实现且已机制性分叉，只靠逐字相同的注释脆弱
 * 同步。本模块把"裁决"收敛为纯函数；"应用策略"（drop/defer/接受新 flow）仍归各
 * 消费方。新增镜像消费方必须消费本函数，不得再手写比较。
 */

/** review 三元组身份：只比较这三个字段，其余 payload 字段不参与单调性。 */
export interface WorkspaceHookReviewIdentity {
  reviewFlowId: string;
  generation: number;
  interactionId: string;
}

/**
 * - no_current：无当前权威，candidate 接管；
 * - same_flow_advance：同 flow 更高 generation，接受（supersede）；
 * - same_flow_replay：同 flow 同 generation 且同 interactionId，幂等 replay，忽略；
 * - same_flow_conflict：同 flow 同 generation 但 interactionId 不同，违反 controller
 *   单调性，忽略；
 * - same_flow_stale：同 flow 更低 generation，迟到事件，忽略；
 * - cross_flow：不同 flow（Runtime 换代），generation 跨 flow 不可比；由调用方按 own
 *   epoch 证据裁决（projection drop / prompt-turn defer / store 接受新权威）。
 */
export type WorkspaceHookReviewMonotonicityVerdict =
  | "no_current"
  | "same_flow_advance"
  | "same_flow_replay"
  | "same_flow_conflict"
  | "same_flow_stale"
  | "cross_flow";

export function verdictWorkspaceHookReviewRequest(
  current: WorkspaceHookReviewIdentity | undefined,
  candidate: WorkspaceHookReviewIdentity,
): WorkspaceHookReviewMonotonicityVerdict {
  if (!current) return "no_current";
  if (candidate.reviewFlowId !== current.reviewFlowId) return "cross_flow";
  if (candidate.generation > current.generation) return "same_flow_advance";
  if (candidate.generation < current.generation) return "same_flow_stale";
  return candidate.interactionId === current.interactionId
    ? "same_flow_replay"
    : "same_flow_conflict";
}
