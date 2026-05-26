import type { LocalizedValue } from "./locales";

export interface ResumePlanFlowStep {
  /** 流程阶段（简历展示用，非代码标识） */
  phase: string;
  title: string;
  detail: string;
}

export interface ResumePlanFlowPhase {
  label: string;
  kind: "plan" | "gate" | "exec";
}

export interface ResumePlanFlowDoc {
  title: string;
  /** 架构定位（一句话） */
  architecture: string;
  lead: string;
  legendPlanning: string;
  legendGate: string;
  legendExec: string;
  /** 状态机轨道（人话阶段名） */
  phases: ResumePlanFlowPhase[];
  steps: ResumePlanFlowStep[];
}

export const evoflowPlanFlowByLocale: LocalizedValue<ResumePlanFlowDoc> = {
  zh: {
    title: "Plan 模式 · 整体流程",
    architecture: "协作状态机 · 规划/执行能力隔离 · 人工授权闸口 · DAG 子任务编排",
    lead:
      "面向复杂任务的「先规划、再确认、后执行」：把聊天里的口头计划，升级为可审阅、可授权、可按依赖分解执行的方案，对标 Cursor Plan 类产品体验。",
    legendPlanning: "规划期（只读、无副作用）",
    legendGate: "人工确认闸口",
    legendExec: "执行期（改代码、跑命令）",
    phases: [
      { label: "规划摸底", kind: "plan" },
      { label: "方案就绪", kind: "plan" },
      { label: "待您确认", kind: "gate" },
      { label: "执行推进", kind: "exec" },
      { label: "验收收尾", kind: "exec" },
    ],
    steps: [
      {
        phase: "进入",
        title: "开启 Plan 协作",
        detail:
          "复杂任务进入专用协作通道，系统处于「规划态」，与日常闲聊或直接改文件区分开，避免边聊边误操作。",
      },
      {
        phase: "规划",
        title: "只读调研与需求对齐",
        detail:
          "此阶段以阅读、检索、分路调研和澄清为主，不落地改代码或执行命令；先把目标、约束与现状摸清。",
      },
      {
        phase: "定型",
        title: "结构化方案与子任务图",
        detail:
          "产出带目标、步骤与依赖关系的正式方案，并同步为可执行的子任务 DAG，而不是停留在聊天里的 Markdown 描述。",
      },
      {
        phase: "闸口",
        title: "人工确认后才开始执行",
        detail:
          "方案完整展示供审阅；只有用户明确授权后才进入执行——系统不允许模型自行「开始干活」。",
      },
      {
        phase: "执行",
        title: "编排推进与闭环验收",
        detail:
          "总控按依赖关系分波次推进并行/串行子任务，可委派多个子 Agent 并行执行；完成后验证、复盘；若调整方案则回到待确认。",
      },
    ],
  },
  en: {
    title: "Plan mode · end-to-end flow",
    architecture: "Collab state machine · planning/exec isolation · human authorize gate · DAG orchestration",
    lead:
      "Plan-then-confirm-then-execute for complex work: turn chat-level ideas into reviewable, authorizable, dependency-aware execution—similar to Cursor Plan.",
    legendPlanning: "Planning (read-only, no side effects)",
    legendGate: "Human approval gate",
    legendExec: "Execution (writes, commands)",
    phases: [
      { label: "Recon & align", kind: "plan" },
      { label: "Plan ready", kind: "plan" },
      { label: "Awaiting OK", kind: "gate" },
      { label: "Executing", kind: "exec" },
      { label: "Verify & close", kind: "exec" },
    ],
    steps: [
      {
        phase: "Start",
        title: "Enter Plan collaboration",
        detail:
          "Complex work enters a dedicated planning channel—separate from casual chat or immediate file edits to avoid accidental changes.",
      },
      {
        phase: "Plan",
        title: "Read-only recon & alignment",
        detail:
          "Focus on reading, search, parallel exploration, and clarifications—no code writes or shell runs until the plan is agreed.",
      },
      {
        phase: "Shape",
        title: "Structured plan & subtask graph",
        detail:
          "Produce a formal goal, steps, and dependencies, materialized as an executable DAG—not just markdown in the thread.",
      },
      {
        phase: "Gate",
        title: "Human OK before execution",
        detail:
          "The full plan is shown for review; execution starts only after explicit user authorization—the model cannot self-approve.",
      },
      {
        phase: "Run",
        title: "Orchestrate, merge, and verify",
        detail:
          "The runtime advances subtasks in dependency waves with parallel subagent delegation; then verify and close—or return to approval if the plan changes.",
      },
    ],
  },
};
