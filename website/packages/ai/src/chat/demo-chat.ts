import { z } from "zod";
import {
  aiArtifactSchema,
  buildChatArtifacts,
  type AiArtifact,
} from "../ai-ui/artifacts";
import { siteAgent } from "../agents/site-agent";
import { providers } from "../providers";

export const chatModelSchema = z.enum([
  "gpt-5",
  "gpt-5-mini",
  "claude-sonnet",
]);
export type ChatModelId = z.infer<typeof chatModelSchema>;

const textPartSchema = z.object({
  type: z.literal("text"),
  text: z.string().trim().min(1).max(8000),
});

const imagePartSchema = z.object({
  type: z.literal("image"),
  image: z.string().max(10_000_000),
});

const multiPartContentSchema = z.array(z.union([textPartSchema, imagePartSchema])).min(1).max(10);

export const chatMessageSchema = z.object({
  role: z.enum(["user", "assistant", "system"]),
  content: z.union([
    z.string().trim().min(1).max(8000),
    multiPartContentSchema,
  ]),
});

export const chatRequestSchema = z.object({
  locale: z.enum(["zh", "en"]).default("zh"),
  messages: z.array(chatMessageSchema).min(1).max(50),
  model: chatModelSchema.default("gpt-5"),
  surface: z.enum(["chat", "palette"]).default("chat"),
});

export type ChatRequest = z.infer<typeof chatRequestSchema>;

export const chatToolCallSchema = z.object({
  detail: z.string(),
  name: z.string(),
  status: z.enum(["completed", "pending"]),
});

export type ChatToolCall = z.infer<typeof chatToolCallSchema>;

export const chatSourceSchema = z.object({
  path: z.string(),
  title: z.string(),
});

export type ChatSource = z.infer<typeof chatSourceSchema>;

export const demoChatResponseSchema = z.object({
  agent: z.string(),
  answer: z.string(),
  artifacts: z.array(aiArtifactSchema),
  followUps: z.array(z.string()),
  mode: z.enum(["demo", "live"]),
  model: chatModelSchema,
  provider: z.string(),
  sources: z.array(chatSourceSchema),
  toolCalls: z.array(chatToolCallSchema),
});

export type DemoChatResponse = z.infer<typeof demoChatResponseSchema>;

const modelProviderMap: Record<ChatModelId, string> = {
  "gpt-5": providers.defaultChatModel,
  "gpt-5-mini": providers.defaultFastChatModel,
  "claude-sonnet": providers.defaultReasoningModel,
};

export const chatModelOptions: Array<{
  id: ChatModelId;
  label: string;
  provider: string;
}> = [
  { id: "gpt-5", label: "GPT-5.4", provider: modelProviderMap["gpt-5"] },
  {
    id: "gpt-5-mini",
    label: "GPT-5.4 mini",
    provider: modelProviderMap["gpt-5-mini"],
  },
  {
    id: "claude-sonnet",
    label: "Claude Sonnet",
    provider: modelProviderMap["claude-sonnet"],
  },
];

type TopicKey =
  | "projects"
  | "workflow"
  | "i18n"
  | "deploy"
  | "default";

interface CreateChatResponseOptions {
  agent: string;
  answer: string;
  artifacts?: AiArtifact[];
  followUps: string[];
  mode: "demo" | "live";
  model: ChatModelId;
  provider: string;
  sources: ChatSource[];
  toolCalls: ChatToolCall[];
}

export function createChatResponse(
  options: CreateChatResponseOptions,
): DemoChatResponse {
  return demoChatResponseSchema.parse({
    ...options,
    artifacts:
      options.artifacts ??
      buildChatArtifacts({
        model: options.model,
        sources: options.sources,
        toolCalls: options.toolCalls,
      }),
  });
}

export function generateDemoChatResponse(
  request: ChatRequest,
): DemoChatResponse {
  const rawContent =
    [...request.messages].reverse().find((message) => message.role === "user")
      ?.content ?? "";
  const latestUserMessage = typeof rawContent === "string"
    ? rawContent
    : rawContent.filter((p): p is { type: "text"; text: string } => p.type === "text").map((p) => p.text).join(" ");

  const topic = resolveTopic(latestUserMessage);
  const locale = request.locale;

  return createChatResponse({
    agent: siteAgent.name,
    answer: getAnswer(locale, topic),
    followUps: [...getFollowUps(locale, topic)],
    mode: "demo",
    model: request.model,
    provider: modelProviderMap[request.model],
    sources: getSources(locale, topic),
    toolCalls: getToolCalls(locale, topic),
  });
}

function resolveTopic(input: string): TopicKey {
  const normalized = input.toLowerCase();

  if (
    /项目|project|blog|github|作品|evoflow/.test(normalized)
  ) {
    return "projects";
  }

  if (
    /workflow|agent|智能体|工作流|rag|知识库|mcp/.test(normalized)
  ) {
    return "workflow";
  }

  if (
    /国际化|i18n|多语言|locale|字体|font|中文|英文/.test(normalized)
  ) {
    return "i18n";
  }

  if (
    /部署|deploy|ecs|nginx|pm2|worker/.test(normalized)
  ) {
    return "deploy";
  }

  return "default";
}

function getAnswer(locale: "zh" | "en", topic: TopicKey) {
  const answers = {
    zh: {
      projects:
        "核心项目是 EvoFlow 营销站与编排叙事：主站负责能力矩阵、典型场景与文档入口；发行版与 GitHub 仓库对外交付。当前已完成 monorepo 地基、首页工程化、中英文国际化与 Stitch 字体体系，下一步重点是 Command Palette、真实 `/ai/chat`，以及 Agent / Workflow / Knowledge 演示迁移。",
      workflow:
        "这套站点的 AI 分层是明确分开的：`AI SDK` 负责核心 chat / tool calling / streaming，`Mastra` 作为 workflow、memory、RAG 的增强层。前端会把交互拆成 chat page、command palette、artifacts 和 context panel，后端再逐步把工具调用与知识检索接进去，这样后续迭代不会把逻辑写死在单个组件里。",
      i18n:
        "国际化基线已经接好了。现在全站支持 `zh / en` 双语切换，locale 通过 cookie 持久化；文案组织放在 content 层，首页、全局 shell、AI / Admin layout 和 placeholder 页面都能切换。字体上使用了 Stitch 风格的 `Space Grotesk + Manrope + Inter`，并补了 `Noto Sans SC` 作为中文 fallback，保证中英文混排不会塌。",
      deploy:
        "部署目标仍然是 ECS 自托管：`web` 与 `worker` 两类进程由 PM2 管理，Nginx 负责反向代理和证书。之所以保留 `worker`，是为了把 GitHub sync、Blog sync、Coding DNA rebuild、weekly digest 这类后台任务从请求链路里拆出去，避免主站交互被拖慢。",
      default:
        "这套网站的目标是把工程能力、产品思考、设计审美和 AI 系统能力整合成可演示、可交付的 EvoFlow 叙事平台。你可以继续问我项目结构、技术栈、AI 设计、部署方案或下一步开发计划。",
    },
    en: {
      projects:
        "The core project is the EvoFlow marketing site and orchestration story: the main site covers capability matrices, scenarios, and docs; releases and GitHub are the delivery surfaces. The baseline includes the monorepo foundation, homepage engineering, bilingual support, and the Stitch-inspired font system. Next milestones: Command Palette, a real `/ai/chat`, and Agent / Workflow / Knowledge demos.",
      workflow:
        "The AI architecture is intentionally layered. `AI SDK` is the core for chat, tool calling, and streaming, while `Mastra` stays as the enhancement layer for workflows, memory, and RAG. On the frontend, interactions are split into the chat page, command palette, artifacts, and a context panel so future tool execution and knowledge retrieval can be wired in without hard-coding everything into one component.",
      i18n:
        "The i18n baseline is already in place. The site now supports `zh / en` switching with locale persistence through a cookie. Copy is organized in the content layer, and the homepage, global shell, AI / Admin layouts, and placeholder pages are all localized. Typography follows the Stitch direction with `Space Grotesk + Manrope + Inter`, plus `Noto Sans SC` as the Chinese fallback so mixed-language layouts still feel intentional.",
      deploy:
        "Deployment is still aimed at self-hosted ECS. `web` and `worker` run as separate PM2 processes, with Nginx handling the reverse proxy and SSL. Keeping the worker separate is important because GitHub sync, blog sync, Coding DNA rebuilds, and weekly digest generation should not slow down the interactive request path.",
      default:
        "The site presents EvoFlow as a living platform that combines engineering systems, product thinking, visual taste, and AI capabilities in one adaptive interface. You can ask about the architecture, tech stack, AI patterns, deployment model, or the next development milestone.",
    },
  } as const;

  return answers[locale][topic];
}

function getToolCalls(locale: "zh" | "en", topic: TopicKey): ChatToolCall[] {
  const shared = [
    {
      name: "searchKnowledge",
      status: "completed" as const,
      detail:
        locale === "zh"
          ? "检索站点知识与设计方案上下文"
          : "Searched design and project context",
    },
    {
      name: "getDevelopmentMemory",
      status: "completed" as const,
      detail:
        locale === "zh"
          ? "读取最近开发进度与关键决策"
          : "Loaded recent progress and key decisions",
    },
  ];

  const topicSpecific: Record<TopicKey, ChatToolCall[]> = {
    projects: [
      {
        name: "getProjects",
        status: "completed",
        detail:
          locale === "zh"
            ? "整理当前项目与外部入口"
            : "Collected current projects and external entry points",
      },
    ],
    workflow: [
      {
        name: "inspectAiRuntime",
        status: "completed",
        detail:
          locale === "zh"
            ? "检查 AI SDK / Mastra 分层"
            : "Inspected AI SDK / Mastra layering",
      },
    ],
    i18n: [
      {
        name: "readLocalizedCopy",
        status: "completed",
        detail:
          locale === "zh"
            ? "检查中英文文案与字体 token"
            : "Checked bilingual copy and typography tokens",
      },
    ],
    deploy: [
      {
        name: "inspectDeploymentPlan",
        status: "completed",
        detail:
          locale === "zh"
            ? "读取 ECS / PM2 / Nginx 方案"
            : "Read ECS / PM2 / Nginx deployment plan",
      },
    ],
    default: [
      {
        name: "summarizePlatformState",
        status: "completed",
        detail:
          locale === "zh"
            ? "整理当前站点完成度与下一步"
            : "Summarized current platform state and next steps",
      },
    ],
  };

  return [...shared, ...topicSpecific[topic]];
}

function getSources(locale: "zh" | "en", topic: TopicKey): ChatSource[] {
  const shared: ChatSource[] = [
    {
      path: "DESIGN.md",
      title: locale === "zh" ? "总体技术设计" : "Technical design",
    },
    {
      path: "MEMORY.md",
      title: locale === "zh" ? "开发记忆与阶段进度" : "Development memory",
    },
  ];

  const topicSpecific: Record<TopicKey, ChatSource[]> = {
    projects: [
      {
        path: "packages/content/src/home.ts",
        title: locale === "zh" ? "首页内容配置" : "Homepage content",
      },
      {
        path: "packages/content/src/site-copy.ts",
        title: locale === "zh" ? "全局文案配置" : "Global copy",
      },
    ],
    workflow: [
      {
        path: "packages/ai/src/agents/agent.ts",
        title: locale === "zh" ? "Agent 定义" : "Agent definition",
      },
      {
        path: "packages/ai/src/providers/index.ts",
        title: locale === "zh" ? "模型 provider 配置" : "Provider configuration",
      },
    ],
    i18n: [
      {
        path: "apps/web/src/app/layout.tsx",
        title: locale === "zh" ? "字体与 locale 入口" : "Fonts and locale entry",
      },
      {
        path: "apps/web/src/app/globals.css",
        title: locale === "zh" ? "字体 tokens 与全局样式" : "Font tokens and globals",
      },
    ],
    deploy: [
      {
        path: "ecosystem.config.cjs",
        title: locale === "zh" ? "PM2 进程配置" : "PM2 process config",
      },
      {
        path: ".env.production.example",
        title: locale === "zh" ? "生产环境模板" : "Production env template",
      },
    ],
    default: [
      {
        path: "apps/web/src/components/home/homepage.tsx",
        title: locale === "zh" ? "首页交互实现" : "Homepage implementation",
      },
    ],
  };

  return [...shared, ...topicSpecific[topic]];
}

function getFollowUps(locale: "zh" | "en", topic: TopicKey) {
  const followUps = {
    zh: {
      projects: [
        "下一步最值得做的功能是什么？",
        "文档和 GitHub 发行版怎么配合主站叙事？",
      ],
      workflow: [
        "AI SDK 和 Mastra 分工具体怎么落？",
        "后面怎么把工具调用可视化？",
      ],
      i18n: [
        "后面怎么做真正的路由级国际化？",
        "亮色模式也要保持中英文排版一致怎么处理？",
      ],
      deploy: [
        "本地和 ECS 环境变量要怎么拆？",
        "worker 任务后面怎么调度？",
      ],
      default: [
        "接下来优先做什么？",
        "现在这个项目的技术栈是什么？",
      ],
    },
    en: {
      projects: [
        "What is the next highest-value feature to build?",
        "How do docs and GitHub releases align with the marketing site?",
      ],
      workflow: [
        "How should AI SDK and Mastra responsibilities split in practice?",
        "How will tool execution become visible in the UI?",
      ],
      i18n: [
        "How should route-level i18n evolve from here?",
        "How do we keep mixed-language typography consistent in light mode too?",
      ],
      deploy: [
        "How should local and ECS environments be separated?",
        "How will worker jobs be scheduled later?",
      ],
      default: [
        "What should we build next?",
        "What is the current tech stack of this project?",
      ],
    },
  } as const;

  return followUps[locale][topic];
}
