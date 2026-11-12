/**
 * EvoFlow collab 任务 → ZCode workflowRuns 协议投影。
 * 让 ConversationWorkflowDigests / WorkflowRunDigest 走同一套 join，不必另画一套卡。
 */
import type { WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import type { WorkflowCausalityGraphData } from "@/components/workflow-graph/types.js";
import type { WorkflowRunCardSummary } from "@/ToolCallBlocks/shared.js";
import { workflowRunStepCounts } from "@zcode/shared/zcode-protocol-v4";
import type { CollabSubtaskSnapshot, CollabTaskSnapshot } from "../../react/chat-types.js";
import { mapTaskStatusToWorkflowCardStatus } from "@/ToolCallBlocks/renderers/platformWorkflowProgress.js";

function clip(s: string, max: number): string {
  const t = s.trim();
  if (!t) return "";
  return t.length <= max ? t : t.slice(0, max);
}

function siteIdFor(sub: CollabSubtaskSnapshot, index: number): string {
  // Prefer real subtaskId：Agent 药丸 / 右栏节点详情用 siteId 联回 collab 子任务。
  const id = String(sub.subtaskId || "").trim();
  if (id) return clip(id.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64), 64) || `s${index}`;
  const ref = String(sub.ref || "").trim();
  if (ref) return clip(`s${ref}`, 64) || `s${index}`;
  return `s${index}`;
}

function laneIdFor(sub: CollabSubtaskSnapshot, index: number): string {
  // Prefer assignedAgent code：对话卡头像覆盖靠 laneId 联 AssignedAgentAvatar。
  const code = String(sub.assignedAgent || "").trim();
  if (code) {
    const slug = code.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 48);
    return clip(slug || `lane${index}`, 64);
  }
  const display = String(sub.assignedAgentDisplay || "").trim();
  if (display) {
    const slug = display.replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, "").slice(0, 48);
    return clip(slug || `lane${index}`, 64);
  }
  return `lane${index}`;
}

function stationLabel(sub: CollabSubtaskSnapshot, index: number): string {
  const name = String(sub.name || "").trim();
  if (name) return clip(name, 128);
  const desc = String(sub.description || "").trim();
  if (desc) return clip(desc, 128);
  const ref = String(sub.ref || "").trim();
  return ref ? clip(`步骤 ${ref}`, 128) : `步骤 ${index + 1}`;
}

function nodePhase(status: string | undefined): WorkflowRunState["nodes"][number]["phase"] {
  const st = mapTaskStatusToWorkflowCardStatus(status);
  if (st === "completed" || st === "errored" || st === "stopped") return "settled";
  if (st === "running") return "executing";
  return "queued";
}

function nodeOutcome(
  status: string | undefined,
): WorkflowRunState["nodes"][number]["outcome"] | undefined {
  const st = mapTaskStatusToWorkflowCardStatus(status);
  if (st === "completed") return "ok";
  if (st === "errored") return "failed";
  if (st === "stopped") return "cancelled";
  return undefined;
}

function actorStatus(
  status: string | undefined,
): WorkflowRunState["actors"][number]["status"] {
  const st = mapTaskStatusToWorkflowCardStatus(status);
  if (st === "running") return "running";
  if (st === "pending") return "waiting";
  return "completed";
}

function sortSubs(subs: readonly CollabSubtaskSnapshot[]): CollabSubtaskSnapshot[] {
  return [...subs].sort((a, b) => {
    const ra = Number(a.ref);
    const rb = Number(b.ref);
    if (Number.isFinite(ra) && Number.isFinite(rb) && ra !== rb) return ra - rb;
    return String(a.subtaskId).localeCompare(String(b.subtaskId));
  });
}

export type CollabWorkflowProjection = {
  run: WorkflowRunState;
  graph: WorkflowCausalityGraphData;
  summary: WorkflowRunCardSummary;
  name: string;
};

/**
 * 把一次 collab 主任务 + 子任务投影成协议形状。
 * runId 默认用 mainTaskId（与右栏 collab-workflow / openStage 同源）。
 */
export function projectCollabToWorkflowRun(input: {
  mainTask: CollabTaskSnapshot | null | undefined;
  subtasks: readonly CollabSubtaskSnapshot[] | null | undefined;
  toolCallId?: string;
  runId?: string;
  name?: string;
  lastEventSequence?: number;
}): CollabWorkflowProjection | null {
  const mainTaskId = String(input.mainTask?.taskId || input.runId || "").trim();
  if (!mainTaskId) return null;

  const runId = clip(String(input.runId || mainTaskId), 128) || mainTaskId;
  const name =
    clip(String(input.name || input.mainTask?.name || "工作流"), 128) || "工作流";
  const status = mapTaskStatusToWorkflowCardStatus(input.mainTask?.status);
  const stations = sortSubs(Array.isArray(input.subtasks) ? input.subtasks : []);

  const lanes: WorkflowCausalityGraphData["lanes"] = [];
  const laneSeen = new Set<string>();
  const steps: WorkflowCausalityGraphData["steps"] = [];
  const participants: WorkflowCausalityGraphData["participants"] = [];
  const phases: NonNullable<WorkflowCausalityGraphData["phases"]> = [];
  const phaseEdges: NonNullable<WorkflowCausalityGraphData["phaseEdges"]> = [];
  const actors: WorkflowRunState["actors"] = [];
  const nodes: WorkflowRunState["nodes"] = [];
  const runPhases: NonNullable<WorkflowRunState["phases"]> = [];
  const phaseNames: string[] = [];

  stations.forEach((sub, index) => {
    const sid = siteIdFor(sub, index);
    const lid = laneIdFor(sub, index);
    const label = stationLabel(sub, index);
    const phaseId = `p${index + 1}`;
    const phaseName = label;

    if (!laneSeen.has(lid)) {
      laneSeen.add(lid);
      const agent =
        String(sub.assignedAgentDisplay || "").trim() ||
        String(sub.assignedAgent || "").trim();
      lanes.push({
        id: lid,
        ...(agent ? { name: clip(agent, 128) } : {}),
      });
    }

    steps.push({
      id: sid,
      kind: "ask",
      label,
      lane: lid,
      phase: phaseId,
      line: index + 1,
    });

    participants.push({
      id: `part-${sid}`,
      phase: phaseId,
      lane: lid,
      steps: [sid],
    });

    phases.push({ id: phaseId, name: phaseName, line: index + 1 });
    if (index > 0) {
      phaseEdges.push({ from: `p${index}`, to: phaseId });
    }

    actors.push({
      siteId: lid,
      ordinal: index,
      name: clip(
        String(sub.assignedAgentDisplay || sub.assignedAgent || label || `agent-${index + 1}`),
        128,
      ) || `agent-${index + 1}`,
      status: actorStatus(sub.status),
      phaseName,
    });

    const phase = nodePhase(sub.status);
    const outcome = nodeOutcome(sub.status);
    nodes.push({
      siteId: sid,
      ordinal: index,
      kind: "ask",
      phase,
      ...(outcome ? { outcome } : {}),
      actorSiteId: lid,
      actorOrdinal: index,
      phaseName,
      ...(String(sub.description || "").trim()
        ? { instructionsHead: clip(String(sub.description), 240) }
        : {}),
    });

    runPhases.push({ name: phaseName, rounds: 1 });
    phaseNames.push(phaseName);
  });

  const settled = nodes.filter((n) => n.phase === "settled").length;
  const run: WorkflowRunState = {
    runId,
    ...(input.toolCallId ? { toolCallId: clip(input.toolCallId, 128) } : {}),
    status,
    usage: {
      spentTokens: 0,
      nodesUsed: nodes.length,
    },
    actors,
    nodes,
    lastEventSequence: Math.max(0, Number(input.lastEventSequence) || Date.now()),
    ...(runPhases.length ? { phases: runPhases } : {}),
    ...(phaseNames.length ? { phaseNames } : {}),
    ...(phaseNames.length
      ? {
          currentPhase:
            phaseNames[
              Math.max(
                0,
                nodes.findIndex((n) => n.phase === "executing") >= 0
                  ? nodes.findIndex((n) => n.phase === "executing")
                  : settled > 0
                    ? Math.min(settled, phaseNames.length) - 1
                    : 0,
              )
            ],
        }
      : {}),
  };

  const graph: WorkflowCausalityGraphData = {
    steps,
    lanes,
    participants,
    handoffs: [],
    ...(phases.length
      ? {
          phases,
          phaseEdges,
          exits: phases.length ? [phases[phases.length - 1]!.id] : [],
        }
      : {}),
  };

  const counts = workflowRunStepCounts(run);
  const summary: WorkflowRunCardSummary = {
    runId,
    ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
    status,
    nodesSettled: counts.settled,
    nodesTotal: counts.total,
    agents: actors.length,
    run,
  };

  return { run, graph, summary, name };
}

/**
 * 从已投影的 ``WorkflowRunState`` 反推静态因果图（无 CreateWorkflow display 时用）。
 * 阶段名 / actor / node 都在 run 上，够画时间线站与药丸。
 */
export function buildCausalityGraphFromWorkflowRun(
  run: WorkflowRunState,
): WorkflowCausalityGraphData | undefined {
  const phaseNames =
    run.phaseNames?.length
      ? [...run.phaseNames]
      : (run.phases ?? []).map((p) => p.name).filter(Boolean);
  if (phaseNames.length === 0 && run.nodes.length === 0) return undefined;

  const names =
    phaseNames.length > 0
      ? phaseNames
      : run.nodes.map((n, i) => n.phaseName || n.instructionsHead || `步骤 ${i + 1}`);

  const lanes: WorkflowCausalityGraphData["lanes"] = [];
  const laneSeen = new Set<string>();
  const steps: WorkflowCausalityGraphData["steps"] = [];
  const participants: WorkflowCausalityGraphData["participants"] = [];
  const phases: NonNullable<WorkflowCausalityGraphData["phases"]> = [];
  const phaseEdges: NonNullable<WorkflowCausalityGraphData["phaseEdges"]> = [];

  names.forEach((phaseName, index) => {
    const phaseId = `p${index + 1}`;
    const node = run.nodes.find((n) => n.phaseName === phaseName) ?? run.nodes[index];
    const actor =
      run.actors.find(
        (a) =>
          (node?.actorSiteId && a.siteId === node.actorSiteId && a.ordinal === node.actorOrdinal) ||
          a.phaseName === phaseName,
      ) ?? run.actors[index];
    const lid = clip(actor?.siteId || `lane${index}`, 64) || `lane${index}`;
    const sid = clip(node?.siteId || `s${index + 1}`, 64) || `s${index + 1}`;
    const label = clip(phaseName || `步骤 ${index + 1}`, 128) || `步骤 ${index + 1}`;

    if (!laneSeen.has(lid)) {
      laneSeen.add(lid);
      lanes.push({
        id: lid,
        ...(actor?.name ? { name: clip(actor.name, 128) } : {}),
      });
    }
    steps.push({
      id: sid,
      kind: "ask",
      label,
      lane: lid,
      phase: phaseId,
      line: index + 1,
    });
    participants.push({
      id: `part-${sid}`,
      phase: phaseId,
      lane: lid,
      steps: [sid],
    });
    phases.push({ id: phaseId, name: label, line: index + 1 });
    if (index > 0) phaseEdges.push({ from: `p${index}`, to: phaseId });
  });

  return {
    steps,
    lanes,
    participants,
    handoffs: [],
    ...(phases.length
      ? {
          phases,
          phaseEdges,
          exits: [phases[phases.length - 1]!.id],
        }
      : {}),
  };
}

/** toolCallId → 从图或 run 反推的因果图（给 ConversationWorkflowDigests）。 */
export function buildWorkflowGraphByToolCallIdFromRuns(
  runs: readonly WorkflowRunState[] | undefined,
): ReadonlyMap<string, WorkflowCausalityGraphData> {
  const map = new Map<string, WorkflowCausalityGraphData>();
  for (const run of runs ?? []) {
    if (!run.toolCallId) continue;
    const graph = buildCausalityGraphFromWorkflowRun(run);
    if (graph && graph.steps.length > 0) map.set(run.toolCallId, graph);
  }
  return map;
}
