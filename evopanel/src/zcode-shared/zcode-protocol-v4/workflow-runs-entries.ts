// 出生事实的读取：按协议容量上限生成 actor 条目。
// 纯函数，不读取时钟或执行 I/O。
//
// 名字与阶段名由脚本生成，可能超过协议长度限制。渲染端会严格校验每一帧，超长值可能使
// 增量和恢复快照都被拒绝。因此生产者按 schema 上限裁剪，完整值仍保留在 journal 中。

import { WORKFLOW_RUNS_LIMITS, type WorkflowRunActor } from "./workflow-runs.js";

/**
 * 一个 actor 条目的铸造。两处调用必须**逐字同形**：`actor-created`，以及带出生事实的
 * `node-dispatched`（workflow-runs-eviction.ts 的 activation）——同一个子代理按到达路径长出
 * 两种条目，就是两条会在冷回放里对不上的记录。
 *
 * `status` 落的是占位值：紧接着的 `withDerivedWorkflowActorStatuses` 会按节点与 run 终态重算。
 */
export function workflowActorEntry(
  ref: { siteId: string; ordinal: number },
  name: unknown,
  phaseName: string | undefined,
  sessionId: string | undefined,
): WorkflowRunActor {
  const bounded = boundedActorName(nonEmptyString(name));
  return {
    siteId: ref.siteId,
    ordinal: ref.ordinal,
    ...(bounded === undefined ? {} : { name: bounded }),
    ...(sessionId ? { sessionId } : {}),
    ...(phaseName === undefined ? {} : { phaseName }),
    status: "waiting",
  };
}

/** 子代理展示名的线上界（见文件头那次订阅失效）。 */
export function boundedActorName(name: string | undefined): string | undefined {
  return name === undefined ? undefined : name.slice(0, WORKFLOW_RUNS_LIMITS.maxActorNameLength);
}

/**
 * 实例出生阶段名的线上界。与 {@link boundedActorName}
 * 同族、同理由，但**直接截断、不加省略号**——这个字段不是给人读的文本而是一个关联键，
 * UI 的 `phaseNameMatches` 正是按前缀把截断的名字关联回 display 阶段。
 */
export function boundedPhaseName(name: string | undefined): string | undefined {
  return name === undefined ? undefined : name.slice(0, WORKFLOW_RUNS_LIMITS.maxPhaseNameLength);
}

/** 空串按缺席处理：协议线上只有「键在场」与「键缺席」两态。 */
export function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
