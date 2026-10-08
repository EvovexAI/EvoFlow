import type { TimelineStation, WorkflowTimelineModel } from "./timeline-model.js";

/**
 * 流式草稿：模型还在写
 * 脚本、分析器还没跑，卡上就先把**阶段线**画出来——只有站与淡墨轨道段，没有药丸、没有弧、没有
 * 状态；子代理只计数（表头的 `N phases · M agents`），画面留给分析器。这是一个**正则级扫描器**，
 * 不是解析器——它只认 `phase("…")` 与 `agent("…")`，认错了也无妨：display 一到整个模型就被
 * 分析器的替换掉（不变式 10）。
 *
 * 同名的第二个 `phase("implement")` 是回到那一站（分析器会把它折成回边），不是新站——草稿
 * 只加不减，站数与分析器的一致，交接时不会有站消失。最后一个未闭合的 `phase("ver` 给最后一站
 * `typing`。
 */
export interface WorkflowDraftPhase {
  name: string;
  typing?: true;
}

export interface WorkflowDraft {
  phases: WorkflowDraftPhase[];
  /** 按出现顺序去重的子代理名（只计数，不画）。 */
  agents: string[];
}

const TOKEN = /\b(phase|agent)\(\s*(?:(["'`])([^"'`\n]*)(\2)?)?/gu;

export function scanWorkflowDraft(script: string): WorkflowDraft {
  const phases: WorkflowDraftPhase[] = [];
  const agents: string[] = [];
  for (const match of script.matchAll(TOKEN)) {
    const [, kind, quote, body, closing] = match;
    if (quote === undefined) continue;
    // 模板字面量里的插值只取头部：`研究员${i}` 记成「研究员」——名字的形状比空着强。
    const name = (body ?? "").split("${")[0]!.trim();
    const closed = closing !== undefined;
    if (kind === "phase") {
      // 已经在 typing 的站就是这个标记本身：流式下同一处会被扫到多次，定名而不是再开一站。
      const last = phases[phases.length - 1];
      if (last?.typing === true) {
        last.name = name;
        if (closed) delete last.typing;
        continue;
      }
      if (closed && phases.some((phase) => phase.name === name)) continue;
      phases.push({ name, ...(closed ? {} : { typing: true }) });
      continue;
    }
    if (!closed || name.length === 0) continue;
    if (!agents.includes(name)) agents.push(name);
  }
  return { agents, phases };
}

/** 草稿 → 时间线模型：只有站与淡墨轨道段，没有药丸、没有弧、没有状态。 */
export function draftTimeline(draft: WorkflowDraft): WorkflowTimelineModel {
  const stations: TimelineStation[] = draft.phases.map((phase, i) => ({
    id: `draft:${i}`,
    naming: { id: `draft:${i}`, name: phase.name },
    onLoop: false,
    pills: [],
    rounds: 0,
    status: undefined,
    track: 0,
    visited: false,
    ...(phase.typing === true ? { typing: true as const } : {}),
  }));
  return {
    arcs: [],
    bands: [],
    draft: { agents: draft.agents.length },
    live: false,
    rails: stations.slice(1).map((_, i) => ({ from: i, ink: "faint" as const, to: i + 1 })),
    runningIndex: undefined,
    stations,
  };
}
