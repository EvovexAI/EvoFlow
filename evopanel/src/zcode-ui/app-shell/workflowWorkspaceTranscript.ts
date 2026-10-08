// ============================================================
// 脚本 transcript 的纯模型
// ============================================================
// 一行 journal 节点 → 一张工具卡的素材：种类（Read / Search / Git / Terminal）、主文本、命令行、
// 所属阶段与轮次、状态词、页脚数字。无 React、无 DOM、无取数。
//
// 种类按 **op** 分派，不按 kind：`kind` 只分 world-read / world-run，而卡片要的是「读文件」
// 「找东西」「git」「跑命令」四个动词——它们正是 files / git / world 三个 facade 容器的分法。
// 升级前的历史行没有 op（`input_json` 为 NULL），退回静态图上的步标签，种类是通用的「步骤」。

import type { WorkflowRunState, WorkflowRunWorkspaceNode } from "@zcode/shared/zcode-protocol-v4";
import type { WorkflowCausalityGraphData } from "@/components/workflow-graph/types.js";
import type { PhaseNaming } from "@/components/workflow-graph/phase-name.js";

export type WorkspaceCardKind = "read" | "search" | "git" | "terminal" | "step";

/** 一张卡的静态素材（不含状态——状态在 `workspaceCardStatus`，因为它还要叠活投影）。 */
export interface WorkspaceCardModel {
  /** React key 与 ToolLayout 的 toolId / 展开态记忆键。 */
  key: string;
  node: WorkflowRunWorkspaceNode;
  kind: WorkspaceCardKind;
  op: string | undefined;
  /** Read：路径；Search：pattern（glob / grep）；Git：子命令 + 实参；Terminal：命令行；Step：步标签。 */
  primary: string;
  /** Search 的第二个实参（grep 的 glob 范围）；Git diff 的路径。 */
  secondary?: string;
  /** Terminal：`cmd arg…`（展开面板里 `$` 后面那一行）。 */
  command?: string;
  /** 所属阶段（静态图按站点查）；图不可得或站点不在图上时缺席。 */
  phase?: PhaseNaming;
  /** 该站点的第几次调用（journal 序号）；> 1 时源芯片带 ⟳n。 */
  round: number;
}

interface WorkspaceCardStatus {
  status: WorkflowRunWorkspaceNode["status"];
  /** 活投影说这一步是 resume 的缓存命中（`replayed` 芯片）。 */
  replayed: boolean;
}

function argString(args: readonly unknown[] | undefined, index: number): string | undefined {
  const value = args?.[index];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function argList(args: readonly unknown[] | undefined, index: number): string[] {
  const value = args?.[index];
  if (Array.isArray(value)) return value.map((item) => String(item));
  // 截断模式下数组实参已经是 JSON 预览文本。
  if (typeof value === "string" && value.startsWith("[")) return [value];
  return [];
}

/** 一条 argv 的展示：带空格的实参加引号，与终端里敲的样子一致。 */
function formatCommandLine(cmd: string, args: readonly string[]): string {
  const quote = (part: string) => (/[\s"']/.test(part) ? JSON.stringify(part) : part);
  return [cmd, ...args].map(quote).join(" ");
}

function workspaceCardKindOf(op: string | undefined): WorkspaceCardKind {
  if (op === undefined) return "step";
  if (op === "read") return "read";
  if (op === "glob" || op === "grep") return "search";
  if (op.startsWith("git-")) return "git";
  if (op === "run") return "terminal";
  return "step";
}

/** `git-changed-files` → `changed-files`；源芯片与主文本都用它。 */
function gitSubcommand(op: string): string {
  return op.slice("git-".length);
}

/**
 * 站点 → 阶段的查找表。静态图的 step 带 `phase`；`source ?? id` 是站点 id（may-set 展开的
 * 拷贝带 `source`）。无 `phase()` 标记的脚本没有 phases，表为空，所有卡都不带源芯片。
 */
function phaseBySiteId(graph: WorkflowCausalityGraphData | undefined): Map<string, PhaseNaming> {
  const table = new Map<string, PhaseNaming>();
  if (graph === undefined) return table;
  const phases = new Map((graph.phases ?? []).map((phase) => [phase.id, phase] as const));
  for (const step of graph.steps) {
    if (step.phase === undefined) continue;
    const phase = phases.get(step.phase);
    if (phase === undefined) continue;
    table.set(step.source ?? step.id, { id: phase.id, name: phase.name });
  }
  return table;
}

/** 站点 → 静态步标签（历史行的兜底主文本）。 */
function stepLabelBySiteId(graph: WorkflowCausalityGraphData | undefined): Map<string, string> {
  const table = new Map<string, string>();
  for (const step of graph?.steps ?? []) table.set(step.source ?? step.id, step.label);
  return table;
}

export function buildWorkspaceCards(
  nodes: readonly WorkflowRunWorkspaceNode[],
  graph: WorkflowCausalityGraphData | undefined,
): WorkspaceCardModel[] {
  const phases = phaseBySiteId(graph);
  const labels = stepLabelBySiteId(graph);
  return nodes.map((node) => {
    const op = node.op;
    const kind = workspaceCardKindOf(op);
    const phase = phases.get(node.siteId);
    const base = {
      key: `${node.siteId}@${node.ordinal}`,
      node,
      kind,
      op,
      round: node.ordinal,
      ...(phase === undefined ? {} : { phase }),
    };
    const fallback = labels.get(node.siteId) ?? node.siteId;
    switch (kind) {
      case "read":
        return { ...base, primary: argString(node.args, 0) ?? fallback };
      case "search": {
        const scope = argString(node.args, 1);
        return {
          ...base,
          primary: argString(node.args, 0) ?? fallback,
          ...(scope === undefined ? {} : { secondary: scope }),
        };
      }
      case "git": {
        const sub = gitSubcommand(op!);
        const target = argString(node.args, 0);
        const shown = node.args?.map((arg) =>
          typeof arg === "string" ? arg : JSON.stringify(arg),
        );
        return {
          ...base,
          primary: `git ${formatCommandLine(sub, shown ?? [])}`,
          ...(target === undefined ? {} : { secondary: target }),
        };
      }
      case "terminal": {
        const cmd = argString(node.args, 0) ?? fallback;
        const command = formatCommandLine(cmd, argList(node.args, 1));
        return { ...base, primary: command, command };
      }
      default:
        return { ...base, primary: fallback };
    }
  });
}

/**
 * 活投影的叠加：只补 `cached`（replayed 芯片）。状态以 journal 行为准——投影里 settled 而
 * journal 还是 running 的那一拍是查询滞后，下一次 `lastEventSequence` 抬升就会追上；反过来
 * journal 领先于投影（admission 先落库再发事件）时投影里干脆没有这个节点。
 */
export function workspaceCardStatus(
  node: WorkflowRunWorkspaceNode,
  run: WorkflowRunState | undefined,
): WorkspaceCardStatus {
  const live = run?.nodes.find(
    (candidate) => candidate.siteId === node.siteId && candidate.ordinal === node.ordinal,
  );
  return { status: node.status, replayed: live?.cached === true };
}

/** 落点：该阶段的第一张卡的下标；阶段还没到（没有卡）→ -1（面板滚到末尾）。 */
export function firstCardIndexOfPhase(
  cards: readonly WorkspaceCardModel[],
  phaseId: string,
): number {
  return cards.findIndex((card) => card.phase?.id === phaseId);
}

/** `1.3s` / `840ms` / `2m 05s`：一步的耗时。 */
export function formatWorkspaceDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

/** `4.1 KB` / `312 B` / `1.2 MB`：正文的大小。 */
export function formatWorkspaceBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** 失败行的状态词判据：driver 的超时 code 说「timed out」，其余说 code 本身。 */
export function isTimeoutError(error: { code: string; message: string } | undefined): boolean {
  if (error === undefined) return false;
  return /timeout|timed ?out/i.test(error.code) || /timed out|timeout/i.test(error.message);
}
