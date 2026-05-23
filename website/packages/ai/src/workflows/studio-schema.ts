import { z } from "zod";

export const workflowNodeTypeSchema = z.enum([
  "trigger",
  "llm",
  "condition",
  "tool",
  "template",
  "merge",
  "output",
]);

export type WorkflowNodeType = z.infer<typeof workflowNodeTypeSchema>;

export const workflowNodeSchema = z.object({
  id: z.string(),
  type: workflowNodeTypeSchema,
  label: z.string(),
  config: z.record(z.string(), z.unknown()).optional(),
  position: z.object({ x: z.number(), y: z.number() }),
});

export type WorkflowNode = z.infer<typeof workflowNodeSchema>;

export const workflowEdgeSchema = z.object({
  id: z.string(),
  source: z.string(),
  target: z.string(),
  sourceHandle: z.string().optional(),
  targetHandle: z.string().optional(),
  label: z.string().optional(),
});

export type WorkflowEdge = z.infer<typeof workflowEdgeSchema>;

export const workflowGraphSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  nodes: z.array(workflowNodeSchema),
  edges: z.array(workflowEdgeSchema),
});

export type WorkflowGraph = z.infer<typeof workflowGraphSchema>;

export const workflowStudioRunRequestSchema = z.object({
  graph: workflowGraphSchema,
  locale: z.enum(["zh", "en"]).default("zh"),
  prompt: z.string().trim().min(1).max(4000),
});

export type WorkflowStudioRunRequest = z.infer<typeof workflowStudioRunRequestSchema>;

export const nodeExecutionStatusSchema = z.enum([
  "queued",
  "running",
  "completed",
  "failed",
  "skipped",
]);

export type NodeExecutionStatus = z.infer<typeof nodeExecutionStatusSchema>;

export const nodeExecutionEventSchema = z.object({
  nodeId: z.string(),
  status: nodeExecutionStatusSchema,
  output: z.string().optional(),
  latencyMs: z.number().optional(),
  timestamp: z.string(),
});

export type NodeExecutionEvent = z.infer<typeof nodeExecutionEventSchema>;

// ---------------------------------------------------------------------------
// Variable resolver: {{nodeId.output}} syntax
// ---------------------------------------------------------------------------

export function resolveVariables(
  text: string,
  outputs: Map<string, string>,
): string {
  return text.replace(/\{\{([\w-]+)\.output\}\}/g, (match, nodeId: string) => {
    return outputs.get(nodeId) ?? match;
  });
}

// ---------------------------------------------------------------------------
// Node catalog
// ---------------------------------------------------------------------------

export interface WorkflowNodeCatalogItem {
  type: WorkflowNodeType;
  label: string;
  icon: string;
  description: string;
  accent: "primary" | "secondary" | "tertiary";
  defaultConfig?: Record<string, unknown>;
}

export function getNodeCatalog(locale: "zh" | "en"): WorkflowNodeCatalogItem[] {
  return [
    {
      type: "trigger",
      label: locale === "zh" ? "触发器" : "Trigger",
      icon: "bolt",
      description: locale === "zh" ? "工作流入口，接收用户输入" : "Workflow entry point",
      accent: "secondary",
    },
    {
      type: "llm",
      label: locale === "zh" ? "LLM 推理" : "LLM",
      icon: "psychology",
      description: locale === "zh" ? "调用大语言模型，支持自定义 Prompt" : "LLM inference with custom prompts",
      accent: "primary",
      defaultConfig: { model: "gpt-5", temperature: 0.72, systemPrompt: "", userPrompt: "" },
    },
    {
      type: "condition",
      label: locale === "zh" ? "条件判断" : "Condition",
      icon: "call_split",
      description: locale === "zh" ? "根据表达式分支执行（success / fail）" : "Branch by expression (success / fail)",
      accent: "tertiary",
      defaultConfig: { expression: "output.length > 100" },
    },
    {
      type: "tool",
      label: locale === "zh" ? "工具调用" : "Tool",
      icon: "extension",
      description: locale === "zh" ? "调用知识检索等工具" : "Call tools like knowledge search",
      accent: "primary",
      defaultConfig: { toolName: "searchKnowledge" },
    },
    {
      type: "template",
      label: locale === "zh" ? "文本模板" : "Template",
      icon: "template",
      description: locale === "zh" ? "用 {{nodeId.output}} 拼接文本" : "Interpolate text with {{nodeId.output}}",
      accent: "tertiary",
      defaultConfig: { template: "" },
    },
    {
      type: "merge",
      label: locale === "zh" ? "合并" : "Merge",
      icon: "merge",
      description: locale === "zh" ? "汇聚多个分支的输出" : "Merge outputs from multiple branches",
      accent: "secondary",
      defaultConfig: { strategy: "concat" },
    },
    {
      type: "output",
      label: locale === "zh" ? "输出" : "Output",
      icon: "output",
      description: locale === "zh" ? "工作流最终输出" : "Final workflow output",
      accent: "secondary",
    },
  ];
}

// ---------------------------------------------------------------------------
// Template registry
// ---------------------------------------------------------------------------

export interface WorkflowTemplate {
  id: string;
  name: string;
  description: string;
  icon: string;
  nodeCount: number;
  graph: WorkflowGraph;
}

export function getWorkflowTemplates(locale: "zh" | "en"): WorkflowTemplate[] {
  return [
    {
      id: "neural-summarizer",
      name: locale === "zh" ? "智能总结器" : "Neural Summarizer",
      description: locale === "zh"
        ? "检索知识库 → LLM 生成总结 → 质量检查 → 输出"
        : "Search knowledge → LLM summarize → Quality check → Output",
      icon: "📝",
      nodeCount: 5,
      graph: templateNeuralSummarizer(locale),
    },
    {
      id: "model-comparison",
      name: locale === "zh" ? "多模型对比" : "Model Comparison",
      description: locale === "zh"
        ? "同一 prompt 并行调用两个模型 → 合并 → 对比分析"
        : "Parallel two models → Merge → Compare analysis",
      icon: "⚖️",
      nodeCount: 6,
      graph: templateModelComparison(locale),
    },
    {
      id: "smart-qa",
      name: locale === "zh" ? "智能问答" : "Smart Q&A",
      description: locale === "zh"
        ? "检索知识 → 有结果走增强回答 / 无结果走直接回答 → 合并输出"
        : "Search → If results: augmented answer / else: direct answer → Merge",
      icon: "💬",
      nodeCount: 7,
      graph: templateSmartQA(locale),
    },
    {
      id: "content-rewriter",
      name: locale === "zh" ? "内容改写器" : "Content Rewriter",
      description: locale === "zh"
        ? "分析原文风格 → 生成改写指令 → LLM 改写 → 输出"
        : "Analyze style → Generate instructions → LLM rewrite → Output",
      icon: "✍️",
      nodeCount: 5,
      graph: templateContentRewriter(locale),
    },
    {
      id: "tech-proposal",
      name: locale === "zh" ? "技术方案生成" : "Tech Proposal",
      description: locale === "zh"
        ? "检索知识 → 需求分析 → 方案设计 → 完整性检查 → 输出"
        : "Search → Analyze requirements → Design proposal → Completeness check → Output",
      icon: "🏗️",
      nodeCount: 6,
      graph: templateTechProposal(locale),
    },
  ];
}

// ---------------------------------------------------------------------------
// Template graphs
// ---------------------------------------------------------------------------

function templateNeuralSummarizer(locale: "zh" | "en"): WorkflowGraph {
  return {
    id: "neural-summarizer",
    name: locale === "zh" ? "智能总结器" : "Neural Summarizer",
    description: locale === "zh"
      ? "检索知识库后由 LLM 生成结构化总结，经过质量检查后输出"
      : "Retrieve knowledge, LLM summarizes, quality check, then output",
    nodes: [
      { id: "trigger-1", type: "trigger", label: locale === "zh" ? "用户输入" : "User Input", position: { x: 80, y: 200 } },
      { id: "tool-1", type: "tool", label: locale === "zh" ? "知识检索" : "Knowledge Search", config: { toolName: "searchKnowledge" }, position: { x: 350, y: 200 } },
      { id: "llm-1", type: "llm", label: locale === "zh" ? "LLM 总结" : "LLM Summarize", config: { model: "gpt-5", temperature: 0.72, systemPrompt: "", userPrompt: "" }, position: { x: 620, y: 200 } },
      { id: "condition-1", type: "condition", label: locale === "zh" ? "质量检查" : "Quality Check", config: { expression: "output.length > 200" }, position: { x: 890, y: 200 } },
      { id: "output-1", type: "output", label: locale === "zh" ? "最终输出" : "Final Output", position: { x: 1160, y: 200 } },
    ],
    edges: [
      { id: "e1", source: "trigger-1", target: "tool-1" },
      { id: "e2", source: "tool-1", target: "llm-1" },
      { id: "e3", source: "llm-1", target: "condition-1" },
      { id: "e4", source: "condition-1", target: "output-1", sourceHandle: "success", label: locale === "zh" ? "通过" : "Pass" },
    ],
  };
}

function templateModelComparison(locale: "zh" | "en"): WorkflowGraph {
  return {
    id: "model-comparison",
    name: locale === "zh" ? "多模型对比" : "Model Comparison",
    description: locale === "zh"
      ? "同一 prompt 并行调用 GPT-5.4 和 GPT-5.4 Mini，合并后由第三个 LLM 做对比分析"
      : "Run GPT-5.4 and GPT-5.4 Mini in parallel, merge, then compare",
    nodes: [
      { id: "trigger-1", type: "trigger", label: locale === "zh" ? "用户输入" : "User Input", position: { x: 80, y: 240 } },
      { id: "llm-a", type: "llm", label: "GPT-5.4", config: { model: "gpt-5", temperature: 0.72, systemPrompt: "", userPrompt: "" }, position: { x: 380, y: 100 } },
      { id: "llm-b", type: "llm", label: "GPT-5.4 Mini", config: { model: "gpt-5-mini", temperature: 0.72, systemPrompt: "", userPrompt: "" }, position: { x: 380, y: 380 } },
      { id: "merge-1", type: "merge", label: locale === "zh" ? "合并结果" : "Merge Results", config: { strategy: "concat" }, position: { x: 680, y: 240 } },
      {
        id: "llm-compare", type: "llm",
        label: locale === "zh" ? "对比分析" : "Compare",
        config: {
          model: "gpt-5", temperature: 0.5,
          systemPrompt: locale === "zh"
            ? "你是模型输出对比分析师。对比两段 AI 生成的文本，分析各自的优缺点，给出推荐。"
            : "You are an AI output comparison analyst. Compare two AI-generated texts, analyze pros/cons, and recommend.",
          userPrompt: locale === "zh"
            ? "以下是两个模型的输出，请对比分析：\n\n{{merge-1.output}}"
            : "Compare the following two model outputs:\n\n{{merge-1.output}}",
        },
        position: { x: 960, y: 240 },
      },
      { id: "output-1", type: "output", label: locale === "zh" ? "最终输出" : "Final Output", position: { x: 1240, y: 240 } },
    ],
    edges: [
      { id: "e1", source: "trigger-1", target: "llm-a" },
      { id: "e2", source: "trigger-1", target: "llm-b" },
      { id: "e3", source: "llm-a", target: "merge-1" },
      { id: "e4", source: "llm-b", target: "merge-1" },
      { id: "e5", source: "merge-1", target: "llm-compare" },
      { id: "e6", source: "llm-compare", target: "output-1" },
    ],
  };
}

function templateSmartQA(locale: "zh" | "en"): WorkflowGraph {
  return {
    id: "smart-qa",
    name: locale === "zh" ? "智能问答" : "Smart Q&A",
    description: locale === "zh"
      ? "先检索知识库，有结果则走增强回答路径，无结果走直接回答路径"
      : "Search knowledge first; if results: augmented answer; else: direct answer",
    nodes: [
      { id: "trigger-1", type: "trigger", label: locale === "zh" ? "用户提问" : "User Question", position: { x: 80, y: 240 } },
      { id: "tool-1", type: "tool", label: locale === "zh" ? "知识检索" : "Knowledge Search", config: { toolName: "searchKnowledge" }, position: { x: 350, y: 240 } },
      { id: "condition-1", type: "condition", label: locale === "zh" ? "有结果?" : "Has Results?", config: { expression: "output.length > 50" }, position: { x: 620, y: 240 } },
      {
        id: "llm-aug", type: "llm",
        label: locale === "zh" ? "增强回答" : "Augmented Answer",
        config: {
          model: "gpt-5", temperature: 0.72, systemPrompt: "",
          userPrompt: locale === "zh"
            ? "基于以下知识片段回答用户问题：\n\n{{tool-1.output}}\n\n用户问题：{{trigger-1.output}}"
            : "Answer based on these knowledge snippets:\n\n{{tool-1.output}}\n\nQuestion: {{trigger-1.output}}",
        },
        position: { x: 920, y: 120 },
      },
      {
        id: "llm-direct", type: "llm",
        label: locale === "zh" ? "直接回答" : "Direct Answer",
        config: { model: "gpt-5", temperature: 0.72, systemPrompt: "", userPrompt: "" },
        position: { x: 920, y: 360 },
      },
      { id: "merge-1", type: "merge", label: locale === "zh" ? "合并" : "Merge", config: { strategy: "first" }, position: { x: 1200, y: 240 } },
      { id: "output-1", type: "output", label: locale === "zh" ? "最终输出" : "Final Output", position: { x: 1460, y: 240 } },
    ],
    edges: [
      { id: "e1", source: "trigger-1", target: "tool-1" },
      { id: "e2", source: "tool-1", target: "condition-1" },
      { id: "e3", source: "condition-1", target: "llm-aug", sourceHandle: "success", label: locale === "zh" ? "有结果" : "Has results" },
      { id: "e4", source: "condition-1", target: "llm-direct", sourceHandle: "fail", label: locale === "zh" ? "无结果" : "No results" },
      { id: "e5", source: "llm-aug", target: "merge-1" },
      { id: "e6", source: "llm-direct", target: "merge-1" },
      { id: "e7", source: "merge-1", target: "output-1" },
    ],
  };
}

function templateContentRewriter(locale: "zh" | "en"): WorkflowGraph {
  return {
    id: "content-rewriter",
    name: locale === "zh" ? "内容改写器" : "Content Rewriter",
    description: locale === "zh"
      ? "先分析原文风格，再生成改写指令，最后 LLM 执行改写"
      : "Analyze style, generate instructions, then LLM rewrites",
    nodes: [
      { id: "trigger-1", type: "trigger", label: locale === "zh" ? "原文输入" : "Original Text", position: { x: 80, y: 200 } },
      {
        id: "llm-analyze", type: "llm",
        label: locale === "zh" ? "风格分析" : "Style Analysis",
        config: {
          model: "gpt-5-mini", temperature: 0.3,
          systemPrompt: locale === "zh"
            ? "分析以下文本的写作风格、语气、结构，用 3 句话总结。"
            : "Analyze the writing style, tone, and structure of the text. Summarize in 3 sentences.",
          userPrompt: "",
        },
        position: { x: 370, y: 200 },
      },
      {
        id: "tpl-instruction", type: "template",
        label: locale === "zh" ? "改写指令" : "Rewrite Instructions",
        config: {
          template: locale === "zh"
            ? "原文风格分析：{{llm-analyze.output}}\n\n请将以下内容改写为更专业、更有深度的版本，保持核心信息不变：\n\n{{trigger-1.output}}"
            : "Style analysis: {{llm-analyze.output}}\n\nRewrite the following in a more professional, insightful tone while preserving core information:\n\n{{trigger-1.output}}",
        },
        position: { x: 660, y: 200 },
      },
      {
        id: "llm-rewrite", type: "llm",
        label: locale === "zh" ? "执行改写" : "Rewrite",
        config: {
          model: "gpt-5", temperature: 0.7, systemPrompt: "",
          userPrompt: "{{tpl-instruction.output}}",
        },
        position: { x: 950, y: 200 },
      },
      { id: "output-1", type: "output", label: locale === "zh" ? "改写结果" : "Rewritten Output", position: { x: 1240, y: 200 } },
    ],
    edges: [
      { id: "e1", source: "trigger-1", target: "llm-analyze" },
      { id: "e2", source: "llm-analyze", target: "tpl-instruction" },
      { id: "e3", source: "tpl-instruction", target: "llm-rewrite" },
      { id: "e4", source: "llm-rewrite", target: "output-1" },
    ],
  };
}

function templateTechProposal(locale: "zh" | "en"): WorkflowGraph {
  return {
    id: "tech-proposal",
    name: locale === "zh" ? "技术方案生成" : "Tech Proposal",
    description: locale === "zh"
      ? "检索知识 → 需求分析 → 方案设计 → 完整性检查 → 输出"
      : "Search knowledge → Analyze needs → Design proposal → Completeness check → Output",
    nodes: [
      { id: "trigger-1", type: "trigger", label: locale === "zh" ? "需求描述" : "Requirements", position: { x: 80, y: 200 } },
      { id: "tool-1", type: "tool", label: locale === "zh" ? "知识检索" : "Knowledge Search", config: { toolName: "searchKnowledge" }, position: { x: 350, y: 200 } },
      {
        id: "llm-analyze", type: "llm",
        label: locale === "zh" ? "需求分析" : "Analyze Needs",
        config: {
          model: "gpt-5-mini", temperature: 0.5,
          systemPrompt: locale === "zh"
            ? "你是需求分析师。将用户的需求拆解为具体的功能点、技术约束和优先级。"
            : "You are a requirements analyst. Break down needs into features, constraints, and priorities.",
          userPrompt: locale === "zh"
            ? "用户需求：{{trigger-1.output}}\n\n参考资料：{{tool-1.output}}"
            : "Requirements: {{trigger-1.output}}\n\nReference: {{tool-1.output}}",
        },
        position: { x: 620, y: 200 },
      },
      {
        id: "llm-design", type: "llm",
        label: locale === "zh" ? "方案设计" : "Design Proposal",
        config: {
          model: "gpt-5", temperature: 0.72,
          systemPrompt: locale === "zh"
            ? "你是技术架构师。基于需求分析，输出完整的技术方案，包括架构设计、技术选型、实现步骤、风险评估。"
            : "You are a tech architect. Based on the analysis, output a complete technical proposal with architecture, tech choices, implementation steps, and risks.",
          userPrompt: "{{llm-analyze.output}}",
        },
        position: { x: 890, y: 200 },
      },
      { id: "condition-1", type: "condition", label: locale === "zh" ? "完整性检查" : "Completeness Check", config: { expression: "output.length > 500" }, position: { x: 1160, y: 200 } },
      { id: "output-1", type: "output", label: locale === "zh" ? "技术方案" : "Proposal Output", position: { x: 1430, y: 200 } },
    ],
    edges: [
      { id: "e1", source: "trigger-1", target: "tool-1" },
      { id: "e2", source: "tool-1", target: "llm-analyze" },
      { id: "e3", source: "llm-analyze", target: "llm-design" },
      { id: "e4", source: "llm-design", target: "condition-1" },
      { id: "e5", source: "condition-1", target: "output-1", sourceHandle: "success", label: locale === "zh" ? "通过" : "Pass" },
    ],
  };
}

// Keep backward compat
export function getDefaultGraph(locale: "zh" | "en"): WorkflowGraph {
  return templateNeuralSummarizer(locale);
}
