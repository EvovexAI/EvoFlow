import { workflowRunStepCounts, type WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import type { WorkflowCausalityGraphData } from "@/components/workflow-graph/types.js";
import { workflowSubagentModelCardLabel } from "./subagent-model-label.js";
import type { WorkflowTimelineModel } from "./timeline-model.js";

/**
 * 卡片表头细节与页脚摘要行的文案素材。侧栏状态头的摘要行也读这里——同一个 run 在两个面上必须说同一句话。
 *
 * 纯函数 + 注入的 formatMessage：本仓的轻量 intl 没有 ICU 复数，单复数各自一个 key。
 */
type FormatMessage = (
  descriptor: { id: string },
  values?: Record<string, string | number>,
) => string;

export interface TimelineCounts {
  phases: number;
  /** 不重复的子代理车道数（合成车道不算）。 */
  agents: number;
  steps: number;
}

export function timelineCounts(
  model: WorkflowTimelineModel,
  graph: WorkflowCausalityGraphData | undefined,
): TimelineCounts {
  const lanes = new Set<string>();
  for (const station of model.stations) {
    for (const pill of station.pills) if (pill.laneClass === "agent") lanes.add(pill.lane.id);
  }
  // 草稿不画药丸，子代理数由扫描器直接给。
  const agents = model.draft?.agents ?? lanes.size;
  return { agents, phases: model.stations.length, steps: graph?.steps.length ?? 0 };
}

/** 循环上的站到过的最多轮次；没有循环或还没到过时 0。 */
export function timelineRounds(model: WorkflowTimelineModel): number {
  let rounds = 0;
  for (const station of model.stations) {
    if (station.onLoop && station.rounds > rounds) rounds = station.rounds;
  }
  return rounds;
}

function count(format: FormatMessage, one: string, many: string, value: number): string {
  return format({ id: value === 1 ? one : many }, { count: value.toLocaleString() });
}

/**
 * 确认窗表头右侧只说阶段数——子代理数与步数
 * 在下方时间线上一眼可见，表头再复述只是噪音。
 */
export function workflowPhasesDetail(
  format: FormatMessage,
  model: WorkflowTimelineModel,
  graph: WorkflowCausalityGraphData | undefined,
): string {
  const counts = timelineCounts(model, graph);
  return count(
    format,
    "chat.toolCall.workflow.card.phase",
    "chat.toolCall.workflow.card.phases",
    counts.phases,
  );
}

/** 子代理那一段：跑着时数工作中的，结束后数总数（投影与静态图取大）。 */
function agentsPart(
  format: FormatMessage,
  model: WorkflowTimelineModel,
  run: WorkflowRunState | undefined,
): string {
  if (run !== undefined && (run.status === "pending" || run.status === "running")) {
    const working = run.actors.filter((actor) => actor.status === "running").length;
    return count(
      format,
      "chat.toolCall.workflow.card.agentWorking",
      "chat.toolCall.workflow.card.agentsWorking",
      working,
    );
  }
  const agents = Math.max(run?.actors.length ?? 0, timelineCounts(model, undefined).agents);
  return count(
    format,
    "chat.toolCall.workflow.card.agent",
    "chat.toolCall.workflow.card.agents",
    agents,
  );
}

/**
 * 卡片表头右侧的细节：**只说阶段数与子代理数**（卡上不要出现「步」，只留
 * 阶段与子代理）。编写中 / 待确认按静态图数；联接到 run 后阶段数不变、子代理改成
 * 「n 个工作中」（跑着）或总数（结束）。步数、token、轮次、产物数都不再上表头——它们留在
 * run 详情页的摘要行（`workflowSummaryParts`）。
 */
export function workflowHeaderDetail(
  format: FormatMessage,
  model: WorkflowTimelineModel,
  graph: WorkflowCausalityGraphData | undefined,
  run: WorkflowRunState | undefined,
  /**
   * 子代理模型名（已解析，见 subagent-model-label.ts）：细节串已经在说「几个子代理」，模型名
   * 跟在它后面当最后一段，同一段淡色文字——不加芯片、不加前缀。强度与规范串留给 tooltip。
   * 没指定过模型的 run 缺席这一段。
   */
  subagentModelName?: string,
): string {
  const parts = [workflowPhasesDetail(format, model, graph), agentsPart(format, model, run)];
  if (subagentModelName !== undefined) {
    parts.push(subagentModelName);
  }
  return parts.join(" · ");
}

/**
 * 表头细节串 + 它的 tooltip，一次算完：两张卡（v4 轮尾摘要、旧宿主运行卡）必须说同一句话，
 * 所以「模型名加不加」「tooltip 里放什么」只有这一份实现。建不出时间线模型时整块缺席。
 */
export function workflowCardDetail(
  format: FormatMessage,
  model: WorkflowTimelineModel | undefined,
  graph: WorkflowCausalityGraphData | undefined,
  run: WorkflowRunState | undefined,
  /** providerId → provider 名；缺席即拼名退回裸 modelId（永远不显示 provider id）。 */
  providerName?: (providerId: string) => string | undefined,
): { detail: string; title?: string } | undefined {
  if (model === undefined) {
    return undefined;
  }
  const subagentModel = workflowSubagentModelCardLabel(run?.subagentModel, {
    formatMessage: format,
    ...(providerName === undefined ? {} : { providerName }),
  });
  return {
    detail: workflowHeaderDetail(format, model, graph, run, subagentModel?.name),
    ...(subagentModel === undefined ? {} : { title: subagentModel.title }),
  };
}

/**
 * run 详情页摘要行的各段：`1 agent working · 4/7 steps · 42,118 tokens · round 2`；终态换成
 * `3 agents · 11/11 steps · … · 3 rounds · 2 artifacts`。返回值只是字符串，间隔符由渲染方画。
 * 末段数的是**产物**（脚本经 `artifact.*` 交付给用户的产出），不是 `report` 条目：Results 区已
 * 撤走，「results」在屏幕上再没有落点。
 * 聊天里的卡片（工具卡页脚、轮尾摘要）不再用它——卡上只说阶段与子代理
 * （`workflowHeaderDetail`）；这一行只剩详情页在读。
 */
export function workflowSummaryParts(
  format: FormatMessage,
  model: WorkflowTimelineModel,
  run: WorkflowRunState,
  options: {
    tokens?: boolean;
    /**
     * 子代理模型名（已解析，见 subagent-model-label.ts）：在场时是摘要行的**第一段**——
     * 这一行本来就是「这条 run 的几个数」，模型是它的第一个词。状态头因此不再摆模型芯片。
     */
    subagentModelName?: string;
  } = {},
): string[] {
  const parts: string[] = [];
  if (options.subagentModelName !== undefined) {
    parts.push(
      format(
        { id: "chat.toolCall.workflow.run.subagentModel.label" },
        { model: options.subagentModelName },
      ),
    );
  }
  const active = run.status === "pending" || run.status === "running";
  if (active) {
    const working = run.actors.filter((actor) => actor.status === "running").length;
    parts.push(
      count(
        format,
        "chat.toolCall.workflow.card.agentWorking",
        "chat.toolCall.workflow.card.agentsWorking",
        working,
      ),
    );
  } else {
    const agents = Math.max(run.actors.length, timelineCounts(model, undefined).agents);
    parts.push(
      count(
        format,
        "chat.toolCall.workflow.card.agent",
        "chat.toolCall.workflow.card.agents",
        agents,
      ),
    );
  }
  // 步数走 @zcode/shared 的唯一实现：表内 + 表外（撞界后没进表的实例仍算步数）。
  const { settled, total } = workflowRunStepCounts(run);
  parts.push(format({ id: "chat.toolCall.workflow.card.steps" }, { done: settled, total }));
  if (options.tokens !== false) {
    parts.push(
      format(
        { id: "chat.toolCall.workflow.card.tokens" },
        { count: run.usage.spentTokens.toLocaleString() },
      ),
    );
  }
  const rounds = timelineRounds(model);
  if (rounds >= 2) {
    parts.push(
      active
        ? format({ id: "chat.toolCall.workflow.card.round" }, { count: rounds })
        : format({ id: "chat.toolCall.workflow.card.rounds" }, { count: rounds }),
    );
  }
  const artifacts = run.artifacts?.length ?? 0;
  if (artifacts > 0) {
    parts.push(
      count(
        format,
        "chat.toolCall.workflow.card.artifact",
        "chat.toolCall.workflow.card.artifacts",
        artifacts,
      ),
    );
  }
  return parts;
}
