import type { WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import { phaseBinder } from "./instance-phases.js";
import { aggregateRunStatuses, statusOfRunNode } from "./run-status.js";
import {
  IMPLICIT_PHASE_ID,
  type StepRunStatus,
  type StepStatusTable,
  type WorkflowCausalityGraphData,
  type WorkflowHandoffData,
  type WorkflowParticipantData,
  type WorkflowPhaseData,
} from "./types.js";

/**
 * 参与者层的纯选择器。
 *
 * 载荷的 `participants` 已经是分析器排好的**交接序**（第一张是开局者），`handoffs` 已经
 * 归约过；这里只做分桶、状态折叠、计数，以及两件 UI 自己的事：
 *   - 无标记脚本合成一个隐式阶段（`withImplicitPhase`），让板面只有一种画法；
 *   - 运行中把 `many` 卡按真实实例拆开、成员卡按 ordinal 收窄、单卡绑定它唯一的实例或在
 *     多实例时同样拆开（`liveParticipantView`）。
 *
 * 无 React、无 DOM：投影层与组件都消费它，测试直接调。
 */

export { IMPLICIT_PHASE_ID };

/** 视图切换的唯一判定曾经是它；现在它只回答「这张图要不要合成隐式阶段」。 */
export function hasPhaseVocabulary(graph: WorkflowCausalityGraphData): boolean {
  return graph.phases !== undefined && graph.phases.length > 0;
}

/**
 * 无 `phase()` 标记的脚本 → 一个隐式模块：阶段表只有 `workflow`（无 name，UI 本地化为
 * 「Workflow」），没有阶段边，控制流到达正常完成当且仅当脚本有返回物；每个 step 与每张卡
 * 归入它（分析器给它们的 `unphased` 只是「没有阶段」的占位，卡 id 不变）。
 * 有词汇表的图原样返回（引用相等，memo 友好）。
 */
export function withImplicitPhase(graph: WorkflowCausalityGraphData): WorkflowCausalityGraphData {
  if (hasPhaseVocabulary(graph)) return graph;
  return {
    ...graph,
    exits: graph.sink !== undefined && graph.sink.length > 0 ? [IMPLICIT_PHASE_ID] : [],
    participants: graph.participants.map((participant) => ({
      ...participant,
      phase: IMPLICIT_PHASE_ID,
    })),
    phaseEdges: [],
    phases: [{ id: IMPLICIT_PHASE_ID }],
    steps: graph.steps.map((step) => ({ ...step, phase: IMPLICIT_PHASE_ID })),
  };
}

/** 一个阶段的参与者，保持载荷顺序（= 交接序）。 */
export function participantsOfPhase(
  graph: WorkflowCausalityGraphData,
  phaseId: string,
): WorkflowParticipantData[] {
  return graph.participants.filter((participant) => participant.phase === phaseId);
}

export function participantById(
  graph: WorkflowCausalityGraphData,
  id: string,
): WorkflowParticipantData | undefined {
  return graph.participants.find((participant) => participant.id === id);
}

/** 两端都在给定集合里的交接边（阶段内部的边）。 */
export function handoffsWithin(
  graph: WorkflowCausalityGraphData,
  ids: ReadonlySet<string>,
): WorkflowHandoffData[] {
  return graph.handoffs.filter((edge) => ids.has(edge.from) && ids.has(edge.to));
}

export function handoffsAround(
  graph: WorkflowCausalityGraphData,
  id: string,
): { incoming: WorkflowHandoffData[]; outgoing: WorkflowHandoffData[] } {
  return {
    incoming: graph.handoffs.filter((edge) => edge.to === id),
    outgoing: graph.handoffs.filter((edge) => edge.from === id),
  };
}

/** 卡片次行的计数素材：ask 数与工作区读取数（一张卡只会有其中一种非零）。 */
export interface ParticipantCounts {
  asks: number;
  reads: number;
}

export function participantCounts(
  graph: WorkflowCausalityGraphData,
  participant: WorkflowParticipantData,
): ParticipantCounts {
  const kinds = new Map(graph.steps.map((step) => [step.id, step.kind]));
  let asks = 0;
  let reads = 0;
  for (const id of participant.steps) {
    if (kinds.get(id) === "world-read") reads += 1;
    else asks += 1;
  }
  return { asks, reads };
}

/** 任一 step 带 `repeat` ⇒ 卡片显示重复图元（自环在参与者粒度上消失，这是它留下的线索）。 */
export function participantRepeats(
  graph: WorkflowCausalityGraphData,
  participant: WorkflowParticipantData,
): boolean {
  const repeating = new Set(
    graph.steps.filter((step) => step.repeat !== undefined).map((step) => step.id),
  );
  return participant.steps.some((id) => repeating.has(id));
}

/**
 * 多个 step 状态的折叠：收集名下**存在条目**的 step 的状态，交给 `aggregateRunStatuses`
 * （唯一的折叠，格见那里）。没有条目的 step 不参与——它是控制流没走的站点，不是排队中的
 * 节点；一个条目都没有（或静态渲染）返回 undefined。卡、站、检视器标题灯三处共用。
 */
export function collapseStatuses(
  stepIds: readonly string[],
  statuses: StepStatusTable | undefined,
): StepRunStatus | undefined {
  if (statuses === undefined) return undefined;
  const values: StepRunStatus[] = [];
  for (const id of stepIds) {
    const status = statuses[id];
    if (status !== undefined) values.push(status);
  }
  return aggregateRunStatuses(values);
}

/**
 * 一张卡的状态：实时视图给出的按实例收窄的覆盖值优先（成员卡 / 拆分出的实例卡），
 * 否则由它的 step 折叠。
 */
export function participantStatus(
  participant: WorkflowParticipantData,
  statuses: StepStatusTable | undefined,
  participantStatuses?: Record<string, StepRunStatus>,
): StepRunStatus | undefined {
  return participantStatuses?.[participant.id] ?? collapseStatuses(participant.steps, statuses);
}

/** 同一条车道还出现在哪些其他阶段（检视器「also in」一行）。 */
export function participantAlsoIn(
  graph: WorkflowCausalityGraphData,
  participant: WorkflowParticipantData,
): WorkflowPhaseData[] {
  const phases = new Set(
    graph.participants
      .filter((other) => other.lane === participant.lane && other.phase !== participant.phase)
      .map((other) => other.phase),
  );
  return (graph.phases ?? []).filter((phase) => phases.has(phase.id));
}

/** 拆分出的实例卡 id：`${participant.id}@${ordinal}`。 */
export function instanceCardId(participantId: string, ordinal: number): string {
  return `${participantId}@${ordinal}`;
}

/**
 * 一张卡名下的实例：
 * 拆分出的实例卡（`many` 卡、多实例的单卡）各自的那一个，或者原卡**绑定**的那一个
 * （恰有一个实例的单卡、成员卡的第 i 个）。名字就是引擎发出的有效名，卡面优先念它。
 */
export interface ParticipantInstance {
  /** 拆分前的参与者 id（绑定时就是这张卡自己的 id）。 */
  participant: string;
  ordinal: number;
  name?: string;
  /**
   * 原卡绑定而非拆分：卡 id 没变，标签规则也不变（成员卡仍 `#i`，单卡无标签）——
   * 运行时名不做视觉标记。缺席 = 拆分出的实例卡，标签念 `#ordinal`。
   */
  bound?: true;
}

export interface LiveParticipantView {
  /** 参与者与交接已按实例拆分的图；无 run 时就是输入图（引用相等）。 */
  graph: WorkflowCausalityGraphData;
  /** 按实例收窄后的卡片状态（成员卡、实例卡）；其余卡由 step 折叠。 */
  participantStatuses: Record<string, StepRunStatus>;
  /** 实例卡 id → 身份。 */
  instances: Record<string, ParticipantInstance>;
}

/**
 * 实时视图
 *
 *  - `many` 卡：该车道上每个已出现的 actor 实例各出一张卡，交接边按原卡复制到每张实例卡；
 *    实例尚未出现时保留原来那一张（状态由 step 折叠）。
 *  - 单卡：车道上恰有一个实例 → 原卡绑定它（id 不变、状态仍由 step 折叠，只是名字有了）；
 *    两个以上 → 与 `many` 同一条拆分路径——运行时基数胜过静态基数。
 *  - 成员卡（字面量基数展开）：第 i 个成员对应该车道上按 ordinal 排序的第 i 个实例，绑定它，
 *    状态只看那个实例的节点；实例未出现 → pending、不绑定。多出 `of` 的实例不出卡。
 *  - 工作区等合成车道上没有实例，卡不动。
 *
 * 节点按 `(siteId ∈ 卡的站点, actorSiteId === lane, actorOrdinal === ordinal, 卡的阶段 ∈
 * phasesOf(节点))` 收窄；站点取 `step.source ?? step.id`（may-set 拷贝报的是站点 id，与
 * run-status.ts 的关联键同源）。实例在场而它的站点上一个节点都没有 → pending：实例是观察到
 * 的事实，只是还没在这一站动（折叠自己对空集只说 undefined，解缺席是这里的事）。
 *
 * 「实例绑定」：一张卡认领的实例不再是**整条车道**上的实例——同一个站点被 k
 * 个阶段再入时，k 张卡共享一条车道，按车道认领就是一次广播（每站都列全部 100 个）。见
 * {@link instancesOfCard}。
 */
export function liveParticipantView(
  graph: WorkflowCausalityGraphData,
  run: WorkflowRunState | undefined,
): LiveParticipantView {
  if (run === undefined) return { graph, instances: {}, participantStatuses: {} };
  const siteOf = new Map(graph.steps.map((step) => [step.id, step.source ?? step.id]));
  const binder = phaseBinder(graph, run);
  const sitesOf = (participant: WorkflowParticipantData) =>
    new Set(participant.steps.map((id) => siteOf.get(id) ?? id));
  const index = runIndex(run);
  /**
   * 这张卡名下的实例：车道上在**这张卡的站点**留下过节点、且该节点的戳落在这张卡的阶段的
   * actor；在这些站点上还一个节点都没有的 actor（建了还没被 ask，或还没走到这一站）则按它
   * **自己的出生戳**归位。无戳的 run 里 `phasesOf` 恒是全部阶段，两条合起来正是今天的
   * 「按车道」——旧 run 逐字节不变。
   *
   * 走车道索引而不是每张卡重扫一遍 `run.nodes`：见 {@link runIndex}。整条车道只排一次序，
   * 与原来「先筛后排」同序——排序稳定，筛选保序。
   */
  const instancesOfCard = (participant: WorkflowParticipantData, sites: ReadonlySet<string>) => {
    const claimed: WorkflowRunState["actors"][number][] = [];
    for (const actor of index.actorsBySite.get(participant.lane) ?? []) {
      let seen = false;
      let here = false;
      for (const node of index.nodesByActor.get(actorKey(participant.lane, actor.ordinal)) ?? []) {
        if (!sites.has(node.siteId)) continue;
        seen = true;
        if (binder.has(participant.phase, node.phaseName)) {
          here = true;
          break;
        }
      }
      if (here || (!seen && binder.has(participant.phase, actor.phaseName))) claimed.push(actor);
    }
    return claimed;
  };
  const statusFor = (
    participant: WorkflowParticipantData,
    ordinal: number,
    sites: ReadonlySet<string>,
  ): StepRunStatus => {
    const values: StepRunStatus[] = [];
    for (const node of index.nodesByActor.get(actorKey(participant.lane, ordinal)) ?? []) {
      if (!sites.has(node.siteId) || !binder.has(participant.phase, node.phaseName)) continue;
      values.push(statusOfRunNode(node));
    }
    return aggregateRunStatuses(values) ?? "pending";
  };

  const participants: WorkflowParticipantData[] = [];
  const replacements = new Map<string, string[]>();
  const participantStatuses: Record<string, StepRunStatus> = {};
  const instances: Record<string, ParticipantInstance> = {};
  let changed = false;
  for (const participant of graph.participants) {
    const sites = sitesOf(participant);
    const actors = instancesOfCard(participant, sites);
    if (participant.member !== undefined) {
      const actor = actors[participant.member.index];
      participantStatuses[participant.id] =
        actor === undefined ? "pending" : statusFor(participant, actor.ordinal, sites);
      if (actor !== undefined) instances[participant.id] = boundInstance(participant.id, actor);
      participants.push(participant);
      continue;
    }
    if (participant.many !== true && actors.length === 1) {
      instances[participant.id] = boundInstance(participant.id, actors[0]!);
      participants.push(participant);
      continue;
    }
    if (participant.many === true || actors.length > 1) {
      if (actors.length === 0) {
        participants.push(participant);
        continue;
      }
      changed = true;
      const ids: string[] = [];
      for (const actor of actors) {
        const id = instanceCardId(participant.id, actor.ordinal);
        const { many: _many, ...rest } = participant;
        participants.push({ ...rest, id });
        participantStatuses[id] = statusFor(participant, actor.ordinal, sites);
        instances[id] = {
          ordinal: actor.ordinal,
          participant: participant.id,
          ...(actor.name === undefined ? {} : { name: actor.name }),
        };
        ids.push(id);
      }
      replacements.set(participant.id, ids);
      continue;
    }
    participants.push(participant);
  }
  if (!changed) return { graph, instances, participantStatuses };

  const handoffs: WorkflowHandoffData[] = [];
  for (const edge of graph.handoffs) {
    const froms = replacements.get(edge.from) ?? [edge.from];
    const tos = replacements.get(edge.to) ?? [edge.to];
    for (const from of froms) for (const to of tos) handoffs.push({ ...edge, from, to });
  }
  return { graph: { ...graph, handoffs, participants }, instances, participantStatuses };
}

/**
 * 键用 `\0` 连接，与 shared 的 `workflow-runs-actor-status.ts` 同一条理由：siteId 是引擎给的
 * 任意字符串，用 `-` 之类可打印分隔符会让 ("a-1", 2) 与 ("a", "1-2") 撞车。
 */
function actorKey(siteId: string, ordinal: number): string {
  return `${siteId}\0${ordinal}`;
}

interface RunIndex {
  /** `actorKey` → 该实例名下的节点，保持 `run.nodes` 的顺序。 */
  nodesByActor: ReadonlyMap<string, WorkflowRunState["nodes"][number][]>;
  /** 车道 → 该车道上的 actor，已按 ordinal 升序（认领顺序）。 */
  actorsBySite: ReadonlyMap<string, WorkflowRunState["actors"][number][]>;
}

/**
 * 一次视图建一遍的两张索引。没有它们，每张实例卡都要重扫一遍 `run.nodes` 才能收自己的状态——表界是 1024
 * 个实例 × 1024 个节点，也就是每帧一百万次比较。
 * 索引之后建模按 actors + nodes 线性。
 *
 * 没有 actor 的节点（world-read）与不带 ordinal 的旧载荷不进索引：原来的筛选条件
 * `node.actorSiteId === lane && node.actorOrdinal === ordinal` 对它们恒假，丢掉等价。
 */
function runIndex(run: WorkflowRunState): RunIndex {
  const nodesByActor = new Map<string, WorkflowRunState["nodes"][number][]>();
  for (const node of run.nodes) {
    if (node.actorSiteId === undefined || node.actorOrdinal === undefined) continue;
    const key = actorKey(node.actorSiteId, node.actorOrdinal);
    const bucket = nodesByActor.get(key);
    if (bucket === undefined) nodesByActor.set(key, [node]);
    else bucket.push(node);
  }
  const actorsBySite = new Map<string, WorkflowRunState["actors"][number][]>();
  for (const actor of run.actors) {
    const bucket = actorsBySite.get(actor.siteId);
    if (bucket === undefined) actorsBySite.set(actor.siteId, [actor]);
    else bucket.push(actor);
  }
  for (const actors of actorsBySite.values()) actors.sort((a, b) => a.ordinal - b.ordinal);
  return { actorsBySite, nodesByActor };
}

function boundInstance(
  participantId: string,
  actor: WorkflowRunState["actors"][number],
): ParticipantInstance {
  return {
    bound: true,
    ordinal: actor.ordinal,
    participant: participantId,
    ...(actor.name === undefined ? {} : { name: actor.name }),
  };
}
