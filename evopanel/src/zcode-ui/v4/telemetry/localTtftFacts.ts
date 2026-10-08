import { LOCAL_TTFT_MAX_DETAILS, type LocalTtftFacts } from "@zcode/shared";

export function mergeLocalTtftFacts(
  prior: LocalTtftFacts | undefined,
  incoming: LocalTtftFacts,
): LocalTtftFacts | undefined {
  if (
    prior &&
    (prior.instanceId !== incoming.instanceId ||
      (prior.sessionId && incoming.sessionId && prior.sessionId !== incoming.sessionId) ||
      (prior.turnId && incoming.turnId && prior.turnId !== incoming.turnId))
  )
    return;
  const details = new Map(prior?.details?.map((detail) => [detail.id, detail]));
  for (const detail of incoming.details ?? []) {
    const previous = details.get(detail.id);
    if (previous?.end !== undefined) continue;
    if (details.has(detail.id) || details.size < LOCAL_TTFT_MAX_DETAILS)
      details.set(detail.id, detail);
  }
  // 累计事实只填空，不让重传的早期快照擦掉已知边界；请求 ID 随 attempt 单独保留。
  const merged: LocalTtftFacts = { ...incoming, ...prior, details: [...details.values()] };
  for (const key of [
    "sessionId",
    "turnId",
    "productTurnId",
    "queryId",
    "requestId",
    "logicalCallId",
    "cliVersion",
    "provider",
    "model",
    "admittedAt",
    "executionAt",
    "requestAt",
    "outputAt",
    "outputKind",
    "terminal",
    "excluded",
    "sendMode",
  ] as const) {
    if (merged[key] === undefined && incoming[key] !== undefined)
      Object.assign(merged, { [key]: incoming[key] });
  }
  if (
    incoming.sendMode === "guided" ||
    (incoming.sendMode === "queued" && merged.sendMode !== "guided")
  )
    merged.sendMode = incoming.sendMode;
  // 重试可更新模型请求身份；起点只填空，晚到旧 revision 不能把赢家改回旧 attempt。
  if (
    incoming.revision !== undefined &&
    (prior?.revision === undefined || incoming.revision >= prior.revision)
  ) {
    merged.revision = incoming.revision;
    for (const key of ["requestId", "logicalCallId", "provider", "model"] as const)
      if (incoming[key] !== undefined) merged[key] = incoming[key];
  }
  merged.truncated ||= incoming.truncated;
  merged.clockInvalid ||= incoming.clockInvalid;
  return merged;
}
