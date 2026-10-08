import type { WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import { laneRefsById, type LaneRef } from "@/components/workflow-graph/lane-name.js";
import {
  collapseStatuses,
  liveParticipantView,
  participantStatus,
  participantsOfPhase,
  withImplicitPhase,
} from "@/components/workflow-graph/participant-model.js";
import { phaseBinder } from "@/components/workflow-graph/instance-phases.js";
import { phaseNameMatches, type PhaseNaming } from "@/components/workflow-graph/phase-name.js";
import { phaseMembers } from "@/components/workflow-graph/phase-model.js";
import { workflowRunOverlay } from "@/components/workflow-graph/run-status.js";
import {
  laneClassOf,
  type LaneClass,
  type StepRunStatus,
  type WorkflowCausalityGraphData,
} from "@/components/workflow-graph/types.js";
import { sharedTimelineModel } from "./timeline-cache.js";
import {
  observePhase,
  phaseEntryFor,
  siteIdsOf,
  stationUnlisted,
  type StationUnlisted,
} from "./station-observation.js";
import {
  assignAirLanes,
  bandOf,
  foldPhaseBands,
  foldPhaseEdges,
  trackOf,
  type RailSpec,
  type TimelineRailKind,
} from "./timeline-bands.js";

/**
 * 时间线模型。
 *
 * 一个纯函数把有界 display 与 `workflowRuns` 投影折成三样东西：站（阶段）、轨道段（相邻且
 * 有边的两站之间）、弧（非相邻的边）。聊天卡、确认窗与侧栏清单都从这里出发——不变式 1
 * 「一个模型，三处消费」。无 React、无 DOM、无时间。
 *
 * 顺序是**声明序**（载荷 `phases[]` = 首个 `phase()` 标记的顺序），不再分秩：两个只共享前驱的
 * 兄弟阶段照声明序排成一列，它们之间的边成为弧。回边按**方向**判定（目标站在左），不读载荷
 * 的 `back`——分析器把再入（第二个 `phase("plan")` 标记）标成前向边，画面上它仍然向左。
 */

export type TimelineInk = "faint" | "strong" | "march";
export type { TimelineRailKind } from "./timeline-bands.js";
// 弧的分道是纯下标的组合学，与带的折叠同住 timeline-bands.ts；这里转出去，渲染层的入口不变。
export { arcLaneCount, assignArcLanes } from "./timeline-bands.js";

export interface TimelinePill {
  /** 拆分后的参与者 id（实例卡 `${participant}@${ordinal}`）；React key 与打开实例的抓手。 */
  key: string;
  lane: LaneRef;
  laneClass: LaneClass;
  /** 引擎发出的运行时名（persona 可能改写脚本里的名字）；缺席时渲染车道显示名。 */
  runtimeName?: string;
  /** workflow 内按代理身份分配的头像编号，跨阶段复用。 */
  avatarIndex?: number;
  /** 无 run 时 undefined（静态药丸，与 pending 逐像素相同）。 */
  status: StepRunStatus | undefined;
  /** 该药丸在投影里对应的实例；合成车道（workspace / unknown）没有。 */
  instance?: { siteId: string; ordinal: number; sessionId?: string };
  /**
   * 药丸交出的槽位身份：有实例就是实例的序号；没有实例就是它**将来**
   * 的序号——成员卡 `member.index + 1`，单卡与 `many` 卡 1（引擎按站点顺序发号）。只有活的 run
   * 里的 agent 车道才有；有了它，还没启动的子代理也能开一个占位的 transcript tab。
   */
  slot?: { siteId: string; ordinal: number };
  /**
   * 脚本药丸交出的抓手：
   * 它没有实例、没有会话，能开的是**整个 run 的脚本 transcript**，落到这一站的第一张卡。
   * 与 `slot` 互斥：只有活的 run 里的 workspace 车道才有；没有 run 就没有可开的东西。
   */
  workspace?: { phaseId: string };
  /** 该参与者在本阶段的 step id（侧栏行的活动与计数素材）。 */
  stepIds: string[];
  /** 该实例有待答的升级问题（`run.pendingQuestions`）；名册的钉位规则读它。 */
  asking?: true;
}

export interface TimelineStation {
  id: string;
  naming: PhaseNaming;
  pills: TimelinePill[];
  /** 成员 step 状态的折叠；无 run 时 undefined。 */
  status: StepRunStatus | undefined;
  /** 投影里存在任一节点落在该站的站点上。 */
  visited: boolean;
  /** 该站站点上节点的最大 ordinal；0 = 未到。 */
  rounds: number;
  /** 是任一回边（向左的弧）的源或目标——只有这样的站才显示 `⟳ n`。 */
  onLoop: boolean;
  /** 所在的轨道（`timeline-bands.ts`）；带外一律 0，也就是主线。 */
  track: number;
  /** `settled / observed`；一个节点都没观察到时缺席。表外已结算的实例也在这两个数里。 */
  fraction?: { settled: number; observed: number };
  /** 界在这一站花掉的表外条目（`station-observation.ts`）；一条都没少时缺席。 */
  unlisted?: StationUnlisted;
  /** 流式草稿里尚未闭合的最后一站。 */
  typing?: true;
}

/** 一条轨道上前后相接的两站之间的一段轨道；下标指向 `stations`。 */
export interface TimelineRail {
  from: number;
  to: number;
  ink: TimelineInk;
  /** 缺席 = 一条轨道上的普通段；带的两端是 `fork` / `merge`，带内跨轨道的相邻两站是 `twin`。 */
  kind?: TimelineRailKind;
}

/**
 * 非相邻的边：`to < from` 是回边。`lane` 从 0 起，贴近轨道的是 0；只有在 x 上**相交**的弧才分道
 * （见 {@link assignArcLanes}），互不相干的弧同高。
 */
export interface TimelineArc {
  from: number;
  to: number;
  lane: number;
  ink: TimelineInk;
  /** 画在哪条轨道的空中；分道按空各算各的，所以 `arcLaneCount` 要先按 `air` 筛。 */
  air: number;
}

/** 带内的一条轨道；`stations` 是它的成员，声明序。 */
export interface TimelineTrack {
  stations: number[];
  /** 分叉进入这条轨道的墨；没有前驱时按首站到没到过。 */
  entry: TimelineInk;
  /** 这条轨道汇合出去的墨；没有汇合站时按末站到没到过。 */
  exit: TimelineInk;
}

/** 一条带：声明序上连续的一段站，拆到若干轨道上；弧把它当一个节点（`timeline-bands.ts`）。 */
export interface TimelineBand {
  from: number;
  to: number;
  /** 分叉所在的前驱站；缺席时画面上只有一小截尾巴。 */
  pred?: number;
  /** 汇合所在的后继站；缺席时画面上只有一小截残段。 */
  join?: number;
  tracks: TimelineTrack[];
}

export interface WorkflowTimelineModel {
  stations: TimelineStation[];
  rails: TimelineRail[];
  arcs: TimelineArc[];
  /** 并行阶段折成的带，按 `from` 升序；没有 `alongside` 的时间线是空的。 */
  bands: TimelineBand[];
  /** 正在运行的站（多个时取最右）；无则 undefined。 */
  runningIndex: number | undefined;
  /** 是否有 run 投影参与（决定灯 / 墨迹是否有话说）。 */
  live: boolean;
  /** 流式草稿：站由笔逐字写出，子代理只计数不画（`draft-scan.ts`）。分析器的模型没有它。 */
  draft?: { agents: number };
}

/** `currentPhase` 与一站的关联，与 `phaseEntryFor` 同一条名字规则。 */
function isCurrentPhase(run: WorkflowRunState | undefined, name: string | undefined): boolean {
  return phaseNameMatches(name, run?.currentPhase);
}

/**
 * 站的灯。成员节点先说话——running / failed 是硬事实；
 * 之后才轮到控制流：这一站是当前阶段且 run 还在跑，就是 running（第一个 ask 派发之前、最后
 * 一个 ask 结算之后下一个标记到来之前，控制流都在这一站）；一个节点都没观察到的站（零成员，
 * 或整站被跳过）只能靠进入记录点灯。`nodeStatus` 是折叠的结果，缺席（undefined）就是「没有
 * 节点」——折叠不会为控制流没走的站点造一个 pending。
 */
function stationStatus(
  run: WorkflowRunState | undefined,
  nodeStatus: StepRunStatus | undefined,
  current: boolean,
  entered: boolean,
): StepRunStatus | undefined {
  if (run === undefined) return undefined;
  if (nodeStatus === "running" || nodeStatus === "failed") return nodeStatus;
  const live = run.status === "running" || run.status === "pending";
  if (current && live) return "running";
  // 当前阶段随 run 的终态收场：失败发生在这一站（不管它有没有节点）；cancelled 与节点的画法
  // 一致，同样是 failed。
  if (current) return run.status === "completed" ? "done" : "failed";
  if (nodeStatus !== undefined) return nodeStatus;
  return entered ? "done" : "pending";
}

/**
 * 一个模型，三处消费（不变式 1）：卡、详情页与侧栏清单在同一帧里拿到**同一个**模型对象，
 * 按 (graph, run) 的对象身份记忆——为什么身份是正确的键见 `timeline-cache.ts`。模型是只读的，
 * 没有消费者改它，所以共享顺带也是引用稳定性的来源。
 */
export function buildWorkflowTimeline(
  input: WorkflowCausalityGraphData,
  run: WorkflowRunState | undefined,
): WorkflowTimelineModel {
  return sharedTimelineModel(input, run, () => computeWorkflowTimeline(input, run));
}

function computeWorkflowTimeline(
  input: WorkflowCausalityGraphData,
  run: WorkflowRunState | undefined,
): WorkflowTimelineModel {
  const graph = withImplicitPhase(input);
  const phases = graph.phases ?? [];
  const index = new Map(phases.map((phase, i) => [phase.id, i]));
  const members = phaseMembers(graph);
  const overlay = workflowRunOverlay(run, graph);
  const live = liveParticipantView(graph, run);
  const binder = phaseBinder(graph, run);
  const laneRefs = laneRefsById(graph.lanes);
  const sessionByInstance = new Map(
    (run?.actors ?? []).map((actor) => [`${actor.siteId}@${actor.ordinal}`, actor.sessionId]),
  );
  const askingInstances = new Set(
    (run?.pendingQuestions ?? [])
      .filter(
        (question) => question.actorSiteId !== undefined && question.actorOrdinal !== undefined,
      )
      .map((question) => `${question.actorSiteId}@${question.actorOrdinal}`),
  );

  // 边：先按下标去重（自环与指向未列出阶段的边在这一粒度上没有话说），再交给带的折叠——
  // 相邻的成轨道段，其余成弧，带把分叉与汇合那几条吃掉（`timeline-bands.ts`）。
  const edges: { from: number; to: number }[] = [];
  const seen = new Set<string>();
  for (const edge of graph.phaseEdges ?? []) {
    const from = index.get(edge.from);
    const to = index.get(edge.to);
    if (from === undefined || to === undefined || from === to) continue;
    const key = `${from}>${to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ from, to });
  }
  const folded = foldPhaseBands(
    phases.length,
    phases.map((phase) =>
      (phase.alongside ?? []).flatMap((id) => {
        const at = index.get(id);
        return at === undefined ? [] : [at];
      }),
    ),
  );
  const fold = foldPhaseEdges(phases.length, folded, edges);
  const arcPairs = [...fold.arcs].sort(
    (left, right) => Math.abs(left.from - left.to) - Math.abs(right.from - right.to),
  );
  // 回边的两端上环；端点在带里时整条带都上环——带是一个节点，再入的是整条带。
  const onLoop = new Set<number>();
  for (const arc of arcPairs) {
    if (arc.to >= arc.from) continue;
    for (const end of [arc.from, arc.to]) {
      const band = bandOf(folded, end);
      if (band === undefined) onLoop.add(end);
      else for (let i = band.from; i <= band.to; i += 1) onLoop.add(i);
    }
  }

  // 名称哈希会碰撞；以实例身份分配连续编号，同一代理跨阶段保持同一头像。
  const avatarIndexes = new Map<string, number>();
  const stations: TimelineStation[] = phases.map((phase, i) => {
    const memberSteps = members.get(phase.id) ?? [];
    const unlisted = stationUnlisted(run, binder, phase.id);
    const observed = observePhase(
      run,
      siteIdsOf(memberSteps),
      phaseEntryFor(run, phase.name),
      (node) => binder.has(phase.id, node.phaseName),
      unlisted,
    );
    const pills: TimelinePill[] = participantsOfPhase(live.graph, phase.id).map((participant) => {
      const instance = live.instances[participant.id];
      const lane = laneRefs.get(participant.lane) ?? {
        id: participant.lane,
        laneClass: laneClassOf(participant.lane),
      };
      // 折叠为空 = 这个子代理在这一站、这一次 run 里什么都没做：空心是诚实的。undefined 只留给
      // 无 run 的静态药丸。
      const status =
        run === undefined
          ? undefined
          : (participantStatus(participant, overlay.statuses, live.participantStatuses) ??
            "pending");
      const sessionId =
        instance === undefined
          ? undefined
          : sessionByInstance.get(`${participant.lane}@${instance.ordinal}`);
      const slot =
        run !== undefined && lane.laneClass === "agent"
          ? {
              ordinal: instance?.ordinal ?? (participant.member?.index ?? 0) + 1,
              siteId: participant.lane,
            }
          : undefined;
      const avatarKey = `${participant.lane}@${instance?.ordinal ?? (participant.member?.index ?? 0) + 1}`;
      if (lane.laneClass === "agent" && !avatarIndexes.has(avatarKey)) {
        avatarIndexes.set(avatarKey, avatarIndexes.size);
      }
      return {
        ...(lane.laneClass === "agent" ? { avatarIndex: avatarIndexes.get(avatarKey)! } : {}),
        key: participant.id,
        lane,
        laneClass: lane.laneClass,
        ...(instance?.name === undefined ? {} : { runtimeName: instance.name }),
        status,
        ...(instance === undefined
          ? {}
          : {
              instance: {
                ordinal: instance.ordinal,
                siteId: participant.lane,
                ...(sessionId === undefined ? {} : { sessionId }),
              },
            }),
        ...(slot === undefined ? {} : { slot }),
        ...(run !== undefined && lane.laneClass === "workspace"
          ? { workspace: { phaseId: phase.id } }
          : {}),
        stepIds: [...participant.steps],
        ...(instance !== undefined && askingInstances.has(`${participant.lane}@${instance.ordinal}`)
          ? { asking: true as const }
          : {}),
      };
    });
    return {
      id: phase.id,
      naming: { id: phase.id, ...(phase.name === undefined ? {} : { name: phase.name }) },
      pills,
      status: stationStatus(
        run,
        collapseStatuses(
          memberSteps.map((step) => step.id),
          overlay.statuses,
        ),
        isCurrentPhase(run, phase.name),
        observed.entered,
      ),
      visited: observed.visited,
      rounds: observed.rounds,
      onLoop: onLoop.has(i),
      track: trackOf(folded, i),
      ...(observed.observed === 0
        ? {}
        : { fraction: { observed: observed.observed, settled: observed.settled } }),
      ...(unlisted === undefined ? {} : { unlisted }),
    };
  });

  const visited = (i: number): boolean => stations[i]?.visited === true;
  let runningIndex: number | undefined;
  for (let i = stations.length - 1; i >= 0; i -= 1) {
    if (stations[i]?.status === "running") {
      runningIndex = i;
      break;
    }
  }

  const rails: TimelineRail[] = fold.rails.map((rail: RailSpec) => ({
    from: rail.from,
    ink: visited(rail.from) && visited(rail.to) ? ("strong" as TimelineInk) : "faint",
    ...(rail.kind === undefined ? {} : { kind: rail.kind }),
    to: rail.to,
  }));
  const lanes = assignAirLanes(arcPairs);
  const arcs: TimelineArc[] = arcPairs.map((arc, at) => {
    const back = arc.to < arc.from;
    const strong = back
      ? visited(arc.from) && (stations[arc.to]?.rounds ?? 0) >= 2
      : visited(arc.from) && visited(arc.to);
    return {
      air: arc.air,
      from: arc.from,
      ink: strong ? "strong" : "faint",
      lane: lanes[at] ?? 0,
      to: arc.to,
    };
  });

  // 行进边：从上一个已结算的阶段进入正在运行的阶段的那一条。投影没有时间戳，所以按三条规则
  // 取最诚实的一条：再入的回边 > 进入该站的轨道段 > 任一落在该站的弧。
  // 每个正在运行的站各走一遍——带里两条轨道可以同时在跑，它们各自的分叉都该亮。
  for (let r = 0; r < stations.length; r += 1) {
    if (stations[r]?.status !== "running") continue;
    const entry = bandOf(folded, r)?.from ?? r;
    const reentry = arcs.find(
      (arc) =>
        arc.to === entry && arc.from > arc.to && visited(arc.from) && stations[r]!.rounds >= 2,
    );
    if (reentry !== undefined) {
      reentry.ink = "march";
      continue;
    }
    // 双线段不是控制流走的路，它只说「这两站并行」，永不行进。
    const inbound = rails.filter(
      (rail) => rail.to === r && rail.kind !== "twin" && visited(rail.from),
    );
    if (inbound.length > 0) {
      for (const rail of inbound) rail.ink = "march";
      continue;
    }
    const landing = arcs.find((arc) => arc.to === r && visited(arc.from));
    if (landing !== undefined) landing.ink = "march";
  }

  const railInk = (from: number, to: number): TimelineInk =>
    rails.find((rail) => rail.from === from && rail.to === to && rail.kind !== "twin")?.ink ??
    "faint";
  const bands: TimelineBand[] = fold.bands.map((band) => ({
    from: band.from,
    ...(band.join === undefined ? {} : { join: band.join }),
    ...(band.pred === undefined ? {} : { pred: band.pred }),
    to: band.to,
    tracks: band.tracks.map((members) => {
      const head = members[0]!;
      const tail = members[members.length - 1]!;
      return {
        entry:
          band.pred === undefined
            ? ((visited(head) ? "strong" : "faint") as TimelineInk)
            : railInk(band.pred, head),
        exit:
          band.join === undefined
            ? ((visited(tail) ? "strong" : "faint") as TimelineInk)
            : railInk(tail, band.join),
        stations: [...members],
      };
    }),
  }));

  return { arcs, bands, live: run !== undefined, rails, runningIndex, stations };
}

/** 一枚药丸「正在做什么」：优先正在跑的 step 的 label，其次最后一个已结算的，再次第一个。 */
export function pillActivity(
  graph: WorkflowCausalityGraphData,
  run: WorkflowRunState | undefined,
  pill: TimelinePill,
): { label: string; asks: number; reads: number } {
  const stepsById = new Map(graph.steps.map((step) => [step.id, step]));
  const statuses = run === undefined ? {} : workflowRunOverlay(run, graph).statuses;
  let asks = 0;
  let reads = 0;
  let running: string | undefined;
  let done: string | undefined;
  let first: string | undefined;
  for (const id of pill.stepIds) {
    const step = stepsById.get(id);
    if (step === undefined) continue;
    if (step.kind === "world-read") reads += 1;
    else asks += 1;
    first ??= step.label;
    const status = statuses[id];
    if (status === "running") running ??= step.label;
    else if (status === "done" || status === "failed") done = step.label;
  }
  return { asks, label: running ?? done ?? first ?? "", reads };
}
