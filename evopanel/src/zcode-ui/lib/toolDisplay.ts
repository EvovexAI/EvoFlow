import type { TaskChatToolCall as ChatToolCall } from "@/lib/taskChatMessageTypes.js";
import {
  getToolCallCodeContentPreview,
  getToolCallCodePreview,
  type CodeViewerSource,
  type ImageCodeViewerSource,
  type PatchCodeViewerSource,
  type TextCodeViewerSource,
} from "@/lib/codeViewer.js";
import { isAbsoluteFilePath, joinFilePath } from "@/lib/path.js";
import { getToolCallErrorText } from "@/lib/toolError.js";
import {
  isFileContentWriteToolCall,
  isFileDiffToolCall,
  resolveToolCallIdentity,
  type ToolCallIdentity,
} from "@/lib/toolIdentity.js";

export type ToolInlinePreview =
  | { type: "none" }
  | { type: "text"; source: TextCodeViewerSource }
  | { type: "patch"; source: PatchCodeViewerSource }
  | { type: "image"; source: ImageCodeViewerSource };

export interface ToolPlanResult {
  plan: string;
  planFilePath?: string;
}

export interface ToolDisplayModel {
  inlinePreview: ToolInlinePreview;
  planResult: ToolPlanResult | null;
  viewerSource: CodeViewerSource | null;
  viewerLabelId: "codeViewer.viewCode" | "codeViewer.viewDiff";
  showSummaryFileLink: boolean;
  showInput: boolean;
  showOutput: boolean;
  showKind: boolean;
}

interface ToolDisplayContext {
  toolCall: ChatToolCall;
  identity: ToolCallIdentity;
  preview: CodeViewerSource | null;
  contentPreview: TextCodeViewerSource | null;
  errorText?: string;
}

interface ToolDisplayStrategy {
  matches(context: ToolDisplayContext): boolean;
  build(context: ToolDisplayContext): Partial<ToolDisplayModel>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractToolPlanResultFromValue(
  value: unknown,
  workspacePath: string,
): ToolPlanResult | null {
  if (!isRecord(value)) {
    return null;
  }

  const rawPlan = value["plan"];
  if (typeof rawPlan !== "string" || rawPlan.trim().length === 0) {
    return null;
  }

  const rawPlanFilePath = value["planFilePath"];
  const planFilePath =
    typeof rawPlanFilePath === "string" && rawPlanFilePath.trim().length > 0
      ? isAbsoluteFilePath(rawPlanFilePath)
        ? rawPlanFilePath
        : joinFilePath(workspacePath, rawPlanFilePath)
      : undefined;

  return {
    plan: rawPlan.trim(),
    planFilePath,
  };
}

function toInlinePreview(context: ToolDisplayContext, preferPatch: boolean): ToolInlinePreview {
  if (preferPatch && context.preview?.type === "patch") {
    return {
      type: "patch",
      source: context.preview,
    };
  }

  if (context.preview?.type === "image") {
    return {
      type: "image",
      source: context.preview,
    };
  }

  if (context.preview?.type === "text") {
    return {
      type: "text",
      source: context.preview,
    };
  }

  if (context.contentPreview) {
    return {
      type: "text",
      source: context.contentPreview,
    };
  }

  return { type: "none" };
}

const diffToolStrategy: ToolDisplayStrategy = {
  matches(context) {
    return isFileDiffToolCall(context.toolCall, context.identity);
  },
  build(context) {
    const inlinePreview = toInlinePreview(context, true);
    const hasInlinePreview = inlinePreview.type !== "none";

    return {
      inlinePreview,
      showInput: !hasInlinePreview,
      showOutput: Boolean(context.errorText),
      showKind: !hasInlinePreview,
    };
  },
};

const readToolStrategy: ToolDisplayStrategy = {
  matches(context) {
    return context.identity.family === "file-read";
  },
  build(context) {
    const inlinePreview = toInlinePreview(context, false);
    const hasInlinePreview = inlinePreview.type !== "none";

    return {
      inlinePreview,
      // 读类工具的标题里通常已经包含目标文件，摘要行再额外补一个匹配出的文件名，
      // 会把同一文件重复显示两次。这里只保留标题和正文预览，避免只读操作显得像“又点开了一个文件”。
      showSummaryFileLink: false,
      showInput: !hasInlinePreview,
      showOutput: Boolean(context.errorText),
      showKind: !hasInlinePreview,
    };
  },
};

const writeToolStrategy: ToolDisplayStrategy = {
  matches(context) {
    return isFileContentWriteToolCall(context.toolCall, context.identity);
  },
  build(context) {
    const inlinePreview = toInlinePreview(context, false);
    const hasInlinePreview = inlinePreview.type !== "none";

    return {
      inlinePreview,
      showInput: !hasInlinePreview,
      // Write 工具的成功 output 常只是结构化确认结果，继续渲染会多出一块无意义的 Result。
      // 写入内容已经由 inlinePreview / 文件摘要承载；这里只在失败时保留错误，避免重复展示 result。
      showOutput: Boolean(context.errorText),
      showKind: !hasInlinePreview,
    };
  },
};

const genericImageStrategy: ToolDisplayStrategy = {
  matches(context) {
    return context.preview?.type === "image";
  },
  build(context) {
    const inlinePreview = toInlinePreview(context, false);
    const hasInlinePreview = inlinePreview.type !== "none";

    return {
      inlinePreview,
      showInput: !hasInlinePreview,
      showOutput: Boolean(context.errorText),
      showKind: !hasInlinePreview,
    };
  },
};

const executeToolStrategy: ToolDisplayStrategy = {
  matches(context) {
    return context.identity.family === "shell";
  },
  build(context) {
    return {
      inlinePreview: { type: "none" },
      showInput: false,
      showOutput: context.toolCall.output !== undefined || Boolean(context.errorText),
      showKind: false,
    };
  },
};

const searchToolStrategy: ToolDisplayStrategy = {
  matches(context) {
    return context.identity.family === "search";
  },
  build(context) {
    // search/fetch 类工具的输入通常只是 query、路径或过滤条件，
    // 用户真正关心的是命中的结果。之前走通用展示会把 Parameters 和 Result 一起展开，
    // 搜索结果被挤到下面很难扫读；这里统一只保留 result/error，避免无效输入信息抢主视觉。
    // 同时搜索范围本身已经体现在标题或结果里，摘要行再额外补一个匹配出的目录/文件名会重复噪音。
    return {
      inlinePreview: { type: "none" },
      showSummaryFileLink: false,
      showInput: false,
      showOutput: context.toolCall.output !== undefined || Boolean(context.errorText),
      showKind: false,
    };
  },
};

const goalToolStrategy: ToolDisplayStrategy = {
  matches(context) {
    return context.identity.family === "goal";
  },
  build(context) {
    // Goal 工具的 input 是模型给 runtime 的状态变更参数，不是用户要读的结果。
    // 之前走通用 fallback 会同时摊开 Parameters、Result 和整包 raw，goal 状态反而被噪音淹没。
    return {
      inlinePreview: { type: "none" },
      showSummaryFileLink: false,
      showInput: false,
      showOutput: context.toolCall.output !== undefined || Boolean(context.errorText),
      showKind: false,
    };
  },
};

const nodeReplToolStrategy: ToolDisplayStrategy = {
  matches(context) {
    return context.identity.family === "node-repl";
  },
  build() {
    // 展示语义由专用 renderer 从 title/result/error 中归一化；通用 Parameters、Result
    // 和 kind 会暴露工具实现细节，并与专用结果区重复，因此这里全部关闭。
    return {
      inlinePreview: { type: "none" },
      showSummaryFileLink: false,
      showInput: false,
      showOutput: false,
      showKind: false,
    };
  },
};

const TOOL_DISPLAY_STRATEGIES: ToolDisplayStrategy[] = [
  diffToolStrategy,
  readToolStrategy,
  writeToolStrategy,
  executeToolStrategy,
  searchToolStrategy,
  goalToolStrategy,
  nodeReplToolStrategy,
  genericImageStrategy,
];

export function buildToolDisplayModel(
  toolCall: ChatToolCall,
  workspacePath: string,
): ToolDisplayModel {
  const preview = getToolCallCodePreview(toolCall, workspacePath);
  const contentPreview = getToolCallCodeContentPreview(toolCall, workspacePath);
  const errorText = getToolCallErrorText(toolCall);
  const identity = resolveToolCallIdentity(toolCall);
  // 用户要看的 plan 来自 tool result，不是 tool input。
  // EnterPlanMode 一类输入里也可能带 plan/todo 结构；如果这里兜底读 input，
  // 同一份计划会被误当成结果渲染，和顶部真实 plan 事件的职责再次混在一起。
  const planResult = extractToolPlanResultFromValue(toolCall.output, workspacePath);
  const context: ToolDisplayContext = {
    toolCall,
    identity,
    preview,
    contentPreview,
    errorText,
  };

  const defaultModel: ToolDisplayModel = {
    inlinePreview: { type: "none" },
    planResult,
    viewerSource: preview,
    viewerLabelId: preview?.type === "patch" ? "codeViewer.viewDiff" : "codeViewer.viewCode",
    showSummaryFileLink: Boolean(preview?.path),
    showInput: planResult ? false : toolCall.input !== undefined,
    showOutput: toolCall.output !== undefined || Boolean(errorText),
    showKind: true,
  };

  const matchedStrategy = TOOL_DISPLAY_STRATEGIES.find((strategy) => strategy.matches(context));

  // tool 展示之前靠 `kind === "edit"` 直接分叉，预览提取层已经能识别 read/replace/image，
  // 但渲染层完全吃不到，最后只剩一堆零散特判。这里收敛成“通用模型 + kind 策略增强”，
  // 后续新增 execute/search/fetch 的专用展示时，只需要追加策略，不再重写主渲染骨架。
  const model = matchedStrategy
    ? {
        ...defaultModel,
        ...matchedStrategy.build(context),
      }
    : defaultModel;

  // 退出计划模式的 result 会同时带 markdown plan 和 allowedPrompts 等结构化字段。
  // 之前这里直接走通用 JSON Result，聊天区很难读，而且同一份 plan 还会在别处重复渲染。
  // 现在优先把 `plan` 当成当前 tool 的专用结果块展示，只在出错时再回退到通用输出区。
  if (planResult) {
    return {
      ...model,
      showInput: false,
      showOutput: Boolean(errorText),
    };
  }

  if (errorText) {
    return {
      ...model,
      // edit/write 失败时继续展示 Parameters，会把 oldString/newString 整坨 JSON 顶上来，
      // 真正的报错反而被挤到下面甚至完全看不到。失败态优先收敛成错误信息视图，避免用户继续读无效参数。
      inlinePreview: { type: "none" },
      showInput: false,
      showOutput: true,
      showKind: false,
    };
  }

  return model;
}
