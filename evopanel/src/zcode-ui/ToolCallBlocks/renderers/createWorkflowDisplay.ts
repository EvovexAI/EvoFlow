import {
  toolCallCreateWorkflowDisplaySchema,
  type ToolCallCreateWorkflowDisplay,
} from "@zcode/shared/zcode-protocol-v4";
import { isPlainRecord } from "@/ToolCallBlocks/renderers/createWorkflowInput.js";

/**
 * CreateWorkflow 工具输出侧的读取规则（display 载荷与纯文本兜底）。从 `create-workflow.tsx`
 * 拆出（oxlint max-lines 400 门，与 `createWorkflowInput.ts` 同一先例）：纯函数、无 JSX。
 */
// 结构化诊断只走 display 通道；用 packages/shared 的 schema 安全解析 raw.display，
// 缺失或形态不符时退回纯文本兜底，绝不 JSON dump，绝不崩溃。
export function readWorkflowDisplay(raw: unknown): ToolCallCreateWorkflowDisplay | null {
  if (!isPlainRecord(raw)) {
    return null;
  }

  const parsed = toolCallCreateWorkflowDisplaySchema.safeParse(raw.display);
  return parsed.success ? parsed.data : null;
}

export function readFallbackOutputText(output: unknown): string | null {
  if (typeof output === "string") {
    const trimmed = output.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  if (isPlainRecord(output)) {
    for (const key of ["response", "output", "text", "content"] as const) {
      const candidate = output[key];
      if (typeof candidate === "string") {
        const trimmed = candidate.trim();
        if (trimmed.length > 0) {
          return trimmed;
        }
      }
    }
  }

  return null;
}

interface WorkflowDiagnosticPosition {
  line: number;
  column: number;
  message: string;
}

/**
 * 编译反馈行的悬停提示：先是那一句话
 * （什么没发生、谁接着动），再逐条 `L{line}:C{col} message`——与模型收到的行同形，复制出来可以直接对照。
 */
export function formatWorkflowFeedbackTooltip(
  lede: string,
  diagnostics: readonly WorkflowDiagnosticPosition[],
): string {
  return [
    lede,
    ...diagnostics.map(
      (diagnostic) => `L${diagnostic.line}:C${diagnostic.column} ${diagnostic.message}`,
    ),
  ].join("\n");
}

/** 被诊断点名的脚本行（首次出现序、去重、只要正行号）：展开后的脚本把这些行号染成警示色。 */
export function workflowDiagnosticLines(
  diagnostics: readonly WorkflowDiagnosticPosition[],
): number[] {
  const lines = diagnostics.map((diagnostic) => diagnostic.line).filter((line) => line > 0);
  return [...new Set(lines)];
}
