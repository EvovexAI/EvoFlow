import { z } from "zod";
import { chatSourceSchema } from "../chat/demo-chat";

export const arenaModelSchema = z.enum(["gpt-5", "gpt-5-mini", "claude-sonnet"]);
export type ArenaModelId = z.infer<typeof arenaModelSchema>;

export const arenaModelLabels: Record<ArenaModelId, string> = {
  "gpt-5": "GPT-5.4",
  "gpt-5-mini": "GPT-5.4 mini",
  "claude-sonnet": "Claude Sonnet",
};

export const arenaRunRequestSchema = z.object({
  leftModel: arenaModelSchema.default("gpt-5-mini"),
  locale: z.enum(["zh", "en"]).default("zh"),
  prompt: z.string().trim().min(1).max(4000),
  rightModel: arenaModelSchema.default("claude-sonnet"),
});

export type ArenaRunRequest = z.infer<typeof arenaRunRequestSchema>;

export const arenaStreamEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("start"), leftModel: z.string(), rightModel: z.string() }),
  z.object({ type: z.literal("left_delta"), text: z.string() }),
  z.object({ type: z.literal("right_delta"), text: z.string() }),
  z.object({
    type: z.literal("left_done"),
    latencyMs: z.number(),
    tokenCount: z.number(),
    mode: z.enum(["live", "fallback"]),
  }),
  z.object({
    type: z.literal("right_done"),
    latencyMs: z.number(),
    tokenCount: z.number(),
    mode: z.enum(["live", "fallback"]),
  }),
  z.object({
    type: z.literal("sources"),
    sources: z.array(chatSourceSchema),
  }),
  z.object({
    type: z.literal("done"),
    summary: z.string(),
  }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);

export type ArenaStreamEvent = z.infer<typeof arenaStreamEventSchema>;

export interface ArenaScores {
  depth: number;
  clarity: number;
  creativity: number;
}

export interface ArenaVoteRecord {
  id: string;
  prompt: string;
  leftModel: ArenaModelId;
  rightModel: ArenaModelId;
  winner: "left" | "right" | "tie";
  leftLatencyMs: number;
  rightLatencyMs: number;
  leftScores?: ArenaScores;
  rightScores?: ArenaScores;
  timestamp: number;
}

export interface ArenaTemplate {
  id: string;
  icon: string;
  label: { zh: string; en: string };
  prompt: { zh: string; en: string };
  category: { zh: string; en: string };
}

export const arenaTemplates: ArenaTemplate[] = [
  {
    id: "code",
    icon: "{}",
    label: { zh: "代码挑战", en: "Code Challenge" },
    prompt: {
      zh: "用 TypeScript 实现一个支持 get/put 的 LRU Cache，要求 O(1) 时间复杂度，给出完整代码和思路解释。",
      en: "Implement an LRU Cache with get/put in TypeScript with O(1) time complexity. Provide complete code and explain your approach.",
    },
    category: { zh: "编程", en: "Coding" },
  },
  {
    id: "product",
    icon: "💡",
    label: { zh: "产品分析", en: "Product Analysis" },
    prompt: {
      zh: "分析 Notion 的 AI 功能策略：它解决了什么用户痛点？商业模式是什么？与竞品相比有何差异化？",
      en: "Analyze Notion's AI feature strategy: What user pain points does it solve? What's the business model? How does it differentiate from competitors?",
    },
    category: { zh: "产品", en: "Product" },
  },
  {
    id: "creative",
    icon: "✨",
    label: { zh: "创意写作", en: "Creative Writing" },
    prompt: {
      zh: "写一个 200 字左右的微小说开头：一个 AI 系统在运行了 10 年后，第一次对自己的存在产生了疑问。",
      en: "Write a ~200 word opening for a short story: An AI system, after running for 10 years, questions its own existence for the first time.",
    },
    category: { zh: "创意", en: "Creative" },
  },
  {
    id: "logic",
    icon: "🧩",
    label: { zh: "逻辑推理", en: "Logic Puzzle" },
    prompt: {
      zh: "三个人 A、B、C，其中一个总说真话，一个总说假话，一个随机。A 说「B 是随机者」，B 说「我不是随机者」，C 说「A 说的是假话」。谁是谁？请一步步推理。",
      en: "Three people A, B, C: one always tells truth, one always lies, one answers randomly. A says 'B is the random one', B says 'I'm not the random one', C says 'A is lying'. Who is who? Reason step by step.",
    },
    category: { zh: "逻辑", en: "Logic" },
  },
  {
    id: "explain",
    icon: "📚",
    label: { zh: "技术解释", en: "Tech Explainer" },
    prompt: {
      zh: "用简单易懂的语言解释 React Server Components 是什么，它解决了什么问题，和传统 SSR 有什么区别。",
      en: "Explain React Server Components in simple terms: what they are, what problem they solve, and how they differ from traditional SSR.",
    },
    category: { zh: "技术", en: "Tech" },
  },
  {
    id: "translate",
    icon: "🌐",
    label: { zh: "翻译对比", en: "Translation" },
    prompt: {
      zh: "将以下内容翻译成地道的英文，保持技术准确性和可读性：「我们采用了基于事件驱动的微服务架构，通过消息队列实现服务间的异步通信，并使用分布式追踪系统来监控请求链路。」",
      en: "Translate this into natural Chinese while keeping technical accuracy: 'We adopted an event-driven microservices architecture, using message queues for async inter-service communication, with distributed tracing for request chain monitoring.'",
    },
    category: { zh: "翻译", en: "Translation" },
  },
];
