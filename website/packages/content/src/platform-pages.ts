import { defaultLocale, type LocalizedValue, type SiteLocale } from "./locales";

type Accent = "primary" | "secondary" | "tertiary";

interface MetricItem {
  accent: Accent;
  label: string;
  value: string;
}

interface LinkCardItem {
  accent: Accent;
  cta: string;
  description: string;
  eyebrow: string;
  href: string;
  title: string;
}

interface TimelineItem {
  accent: Accent;
  date: string;
  description: string;
  title: string;
}

interface LogItem {
  accent: Accent;
  detail: string;
  status: string;
  title: string;
}

interface LabExperimentItem {
  accent: Accent;
  description: string;
  eyebrow: string;
  insights: string[];
  metrics: Array<{ label: string; value: string }>;
  slug: string;
  status: string;
  title: string;
  track: string;
}

interface PlatformPagesContent {
  admin: {
    cards: LinkCardItem[];
    metrics: MetricItem[];
    timeline: TimelineItem[];
  };
  adminEvolution: {
    controls: Array<{
      accent: Accent;
      description: string;
      label: string;
    }>;
    digest: {
      bullets: string[];
      title: string;
    };
    metrics: MetricItem[];
    timeline: TimelineItem[];
  };
  adminJobs: {
    logs: string[];
    recentRuns: Array<{
      accent: Accent;
      duration: string;
      name: string;
      status: string;
    }>;
    schedules: Array<{
      accent: Accent;
      cron: string;
      name: string;
      nextRun: string;
    }>;
  };
  adminObservability: {
    metrics: MetricItem[];
    sessions: Array<{
      accent: Accent;
      location: string;
      state: string;
      summary: string;
      title: string;
    }>;
    traces: LogItem[];
  };
  aiHub: {
    hero: {
      ctaLabel: string;
      description: string;
      inputLabel: string;
      promptExamples: string[];
      status: string;
      terminalLines: string[];
      title: string;
    };
    metrics: MetricItem[];
    modules: LinkCardItem[];
  };
  evolution: {
    hero: {
      description: string;
      eyebrow: string;
      title: string;
    };
    pillars: Array<{
      accent: Accent;
      description: string;
      eyebrow: string;
      title: string;
    }>;
    timeline: TimelineItem[];
  };
  lab: {
    experiments: LabExperimentItem[];
    hero: {
      description: string;
      eyebrow: string;
      title: string;
    };
  };
  mcp: {
    capabilities: Array<{
      accent: Accent;
      description: string;
      title: string;
    }>;
    logs: string[];
    recentCalls: Array<{
      accent: Accent;
      target: string;
      tool: string;
    }>;
    registry: MetricItem[];
    safeguards: Array<{
      accent: Accent;
      description: string;
      title: string;
    }>;
    hero: {
      description: string;
      eyebrow: string;
      status: string;
      title: string;
    };
  };
}

export const platformPagesByLocale: LocalizedValue<PlatformPagesContent> = {
  zh: {
    admin: {
      cards: [
        {
          accent: "primary",
          cta: "查看 Traces",
          description: "LLM runs、tool calls、session 轨迹与关键事件流的统一入口。",
          eyebrow: "Observability",
          href: "/admin/observability",
          title: "Live Signal Deck",
        },
        {
          accent: "secondary",
          cta: "进入 Jobs",
          description: "Worker 调度、同步任务、失败重试与 cron 视图。",
          eyebrow: "Jobs",
          href: "/admin/jobs",
          title: "Job Orchestrator",
        },
        {
          accent: "tertiary",
          cta: "进入 Evolution",
          description: "知识同步、digest 预览、成长事件与内容摄入控制。",
          eyebrow: "Evolution",
          href: "/admin/evolution",
          title: "Growth Controls",
        },
      ],
      metrics: [
        { accent: "primary", label: "Live Sessions", value: "128" },
        { accent: "secondary", label: "Worker Health", value: "97%" },
        { accent: "tertiary", label: "Weekly Digest", value: "Ready" },
      ],
      timeline: [
        {
          accent: "primary",
          date: "10 min ago",
          description: "新增 Agent / Arena / Workflow / Knowledge 实页骨架并完成生产构建验证。",
          title: "Phase 1 page shells synced",
        },
        {
          accent: "secondary",
          date: "34 min ago",
          description: "重新构建 knowledge context，确保 chat 引用与新页面文案一致。",
          title: "Context pipeline refreshed",
        },
        {
          accent: "tertiary",
          date: "Today",
          description: "预留 Evolution controls，用于未来 Resume / Blog ingestion 接入。",
          title: "Growth controls reserved",
        },
      ],
    },
    adminEvolution: {
      controls: [
        {
          accent: "primary",
          description: "重新计算内容 embedding、更新时间戳和 sources 排名。",
          label: "Rebuild Knowledge Index",
        },
        {
          accent: "secondary",
          description: "执行 GitHub / Blog 同步并刷新 Evolution timeline。",
          label: "Run Sync Pipeline",
        },
        {
          accent: "tertiary",
          description: "生成本周成长摘要，后续将投递到首页与管理台。",
          label: "Generate Weekly Digest",
        },
      ],
      digest: {
        bullets: [
          "本周重点：Stitch design system 已扩到 4 张真实 AI 页面。",
          "核心变化：`/ai/chat`、`/ai` hub、`/ai/mcp`、`/admin` 页面仍在继续对齐参考母版。",
          "下一步：完成剩余 placeholder 页面壳层后，再考虑 Phase 2 的 Resume AI demo 迁移。",
        ],
        title: "Digest Preview",
      },
      metrics: [
        { accent: "primary", label: "Index Version", value: "v1.4" },
        { accent: "secondary", label: "Last Sync", value: "6 min" },
        { accent: "tertiary", label: "Digest Status", value: "Draft" },
      ],
      timeline: [
        {
          accent: "primary",
          date: "2026-04-10",
          description: "AI 页面骨架首次从 placeholder 升级为真实 Stitch 风格页面。",
          title: "AI page reality pass",
        },
        {
          accent: "secondary",
          date: "2026-04-10",
          description: "知识检索接入 `DESIGN.md`、`MEMORY.md` 与 typed content。",
          title: "Retrieval context expanded",
        },
        {
          accent: "tertiary",
          date: "Upcoming",
          description: "准备纳入 GitHub sync、weekly digest 与 Coding DNA 重建流程。",
          title: "Autonomous evolution queue",
        },
      ],
    },
    adminJobs: {
      logs: [
        "worker:init -> schedule registry loaded",
        "[09:00] weeklyDigest queued",
        "[09:01] githubSync completed in 1.8s",
        "[09:04] codingDnaRebuild refreshed homepage fingerprint",
        "[09:07] metricsAggregate published admin snapshot",
        "_",
      ],
      recentRuns: [
        {
          accent: "secondary",
          duration: "1.8s",
          name: "githubSync",
          status: "completed",
        },
        {
          accent: "primary",
          duration: "1.0s",
          name: "codingDnaRebuild",
          status: "completed",
        },
        {
          accent: "tertiary",
          duration: "0.7s",
          name: "metricsAggregate",
          status: "completed",
        },
      ],
      schedules: [
        {
          accent: "secondary",
          cron: "*/30 * * * *",
          name: "GitHub Sync",
          nextRun: "12 min later",
        },
        {
          accent: "primary",
          cron: "0 */6 * * *",
          name: "Blog Sync",
          nextRun: "3h 12m",
        },
        {
          accent: "tertiary",
          cron: "15 */4 * * *",
          name: "Coding DNA Rebuild",
          nextRun: "48 min later",
        },
        {
          accent: "primary",
          cron: "*/20 * * * *",
          name: "Metrics Aggregate",
          nextRun: "19 min later",
        },
        {
          accent: "tertiary",
          cron: "0 9 * * 1",
          name: "Weekly Digest",
          nextRun: "Mon 09:00",
        },
        {
          accent: "secondary",
          cron: "0 2 * * *",
          name: "Knowledge Ingest",
          nextRun: "02:00 tomorrow",
        },
      ],
    },
    adminObservability: {
      metrics: [
        { accent: "primary", label: "LLM Runs", value: "248" },
        { accent: "secondary", label: "Tool Calls", value: "91" },
        { accent: "tertiary", label: "UI Actions", value: "34" },
      ],
      sessions: [
        {
          accent: "primary",
          location: "Shanghai",
          state: "exploring /ai/chat",
          summary: "查看 sources 与 follow-ups，对站点架构发起多轮追问。",
          title: "Visitor Session 14AF",
        },
        {
          accent: "secondary",
          location: "Singapore",
          state: "navigating /ai/arena",
          summary: "对比模型页面停留较久，点击了 Hall of Fame 与 Cast your verdict。",
          title: "Visitor Session 90KQ",
        },
      ],
      traces: [
        {
          accent: "primary",
          detail: "Loaded `DESIGN.md`, `MEMORY.md`, and typed content before GPT response generation.",
          status: "completed",
          title: "retrieveKnowledge",
        },
        {
          accent: "secondary",
          detail: "Palette routed a natural language query into `/ai/chat?prompt=...`.",
          status: "completed",
          title: "commandPalette",
        },
        {
          accent: "tertiary",
          detail: "Tour overlay persisted `lastStepId` and resumed from prior session state.",
          status: "completed",
          title: "homeTourMemory",
        },
      ],
    },
    aiHub: {
      hero: {
        ctaLabel: "OPEN SURFACE",
        description:
          "把 Chat、Agent、Workflow、Knowledge、MCP 与 Arena 组织成同一个可导航的智能入口，而不是割裂的 demo 列表。",
        inputLabel: "Search, navigate, or ask AI...",
        promptExamples: [
          "帮我理解这套网站的 AI 架构",
          "打开 Agent Mission Control",
          "比较 GPT-5 与 Claude 在这个站点里的定位",
        ],
        status: "Living interface online",
        terminalLines: [
          "$ route --surface ai-site",
          "[ok] agent mission control",
          "[ok] workflow editor",
          "[ok] knowledge archive",
          "[ok] protocol bridge",
        ],
        title: "AI 平台是这个站点的神经入口",
      },
      metrics: [
        { accent: "primary", label: "Surfaces", value: "7 live" },
        { accent: "secondary", label: "Runtime", value: "GPT-first" },
        { accent: "tertiary", label: "Context", value: "RAG warm" },
      ],
      modules: [
        {
          accent: "primary",
          cta: "进入对话",
          description: "流式回复、sources、tool calls 与后续 artifacts 的真实对话层。",
          eyebrow: "Chat",
          href: "/about",
          title: "Neural Chat",
        },
        {
          accent: "secondary",
          cta: "看它执行",
          description: "把 planning、tool call、observe、respond 的全过程可视化。",
          eyebrow: "Agent",
          href: "/evolution",
          title: "Mission Control",
        },
        {
          accent: "primary",
          cta: "进入画布",
          description: "Figma 风格的 workflow 节点编排与执行日志预览。",
          eyebrow: "Workflow",
          href: "/lab",
          title: "Sentient Flow",
        },
        {
          accent: "secondary",
          cta: "搜索记忆",
          description: "基于 typed content 与 markdown 文档的本地知识检索层。",
          eyebrow: "Knowledge",
          href: "/about",
          title: "Knowledge Archive",
        },
        {
          accent: "tertiary",
          cta: "查看桥接层",
          description: "展示协议驱动的工具发现、能力目录与安全边界。",
          eyebrow: "MCP",
          href: "/lab",
          title: "Protocol Bridge",
        },
        {
          accent: "secondary",
          cta: "发起对决",
          description: "把 GPT 与 Claude 放进统一竞技场进行实时比较。",
          eyebrow: "Arena",
          href: "/lab",
          title: "Model Arena",
        },
        {
          accent: "tertiary",
          cta: "进入控制台",
          description: "实时监控全部 AI 接入面——会话追踪、工具链路、知识索引与策略执行。",
          eyebrow: "Agent OS",
          href: "/admin",
          title: "Agent OS Console",
        },
      ],
    },
    evolution: {
      hero: {
        description:
          "从「用户一句话」到「可监督的长任务」：由超级总控智能体（Supervisor）把规划、子任务拆分、上下游依赖、异步并行与同步汇合、全程监控和人工纠错串成闭环；支持持续运行与定时巡检，结果可汇总到飞书等工作协同渠道。本页记录产品在长任务编排与协同交付上的演进节奏（非编程语言或框架清单）。",
        eyebrow: "产品演进",
        title: "长任务编排与协同交付 · 里程碑",
      },
      pillars: [
        {
          accent: "primary",
          description:
            "超级总控智能体（Supervisor）持有全局意图：先澄清目标与约束（多轮询问），再产出可执行计划；子任务之间声明上下游依赖，前置完成后自动解锁下游；步骤之间传递上下文与工件，支持异步并行与在汇合点同步对齐。",
          eyebrow: "长任务编排",
          title: "超级总控智能体（Supervisor）· 规划 · 依赖与传递",
        },
        {
          accent: "secondary",
          description:
            "运行时可查看整体与各子任务进度；支持并发执行与队列化调度；失败时可按策略重试，或由超级总控智能体（Supervisor）纠错、改派甚至重新编排依赖网络；可与 Claude Code 等研发工具链组合完成编码类长流程。",
          eyebrow: "可见可控",
          title: "监控 · 并发 · 纠错与重编排",
        },
        {
          accent: "tertiary",
          description:
            "持续类与定时类任务可由智能体托管：按 Cron 触发巡检、报表或同步作业，运行结果与摘要推送到飞书（Lark）群或机器人，便于值班与业务方第一时间获知。",
          eyebrow: "自动化协同",
          title: "持续运行 · 定时任务 · 飞书汇报",
        },
      ],
      timeline: [
        {
          accent: "primary",
          date: "阶段一",
          description:
            "确立超级总控智能体（Supervisor）长任务心智：规划—询问对齐—子任务委派—单主线上的进度与轨迹可查，支撑跨多步的业务流程而非单轮问答。",
          title: "长任务主线与监督视角",
        },
        {
          accent: "secondary",
          date: "阶段二",
          description:
            "上线上下游依赖与汇合节点；异步子任务与同步闸口并存；超级总控智能体（Supervisor）可介入纠错、重试与局部重编排，降低「一次失败全盘重来」的成本。",
          title: "依赖网络与人机协同",
        },
        {
          accent: "tertiary",
          date: "阶段三 · 推进中",
          description:
            "强化任务监控大盘与并发策略；扩展定时与持续运行场景；对接飞书等渠道做定时结果播报；并与 Claude Code 等工具链在长研发任务上深度协同。",
          title: "并发治理 · 定时飞书 · 工具链协同",
        },
      ],
    },
    lab: {
      experiments: [
        {
          accent: "primary",
          description:
            "验证「编排事件 → Skills/MCP 调用 → 沙箱执行 → 轨迹卡片」的串联叙事，用于售前演示与交互稿，而非生产对话产品。",
          eyebrow: "观测卡片",
          insights: [
            "结构化展示工具入参与出参摘要",
            "与首页典型场景文案共用术语",
            "为审计导出预留字段占位",
          ],
          metrics: [
            { label: "Track", value: "Observability UI" },
            { label: "State", value: "Scaffolded" },
            { label: "Priority", value: "P1" },
          ],
          slug: "artifact-radar",
          status: "实验中",
          title: "轨迹与工件卡片原型",
          track: "Orchestration UX",
        },
        {
          accent: "secondary",
          description:
            "探索 EvoPanel 与网关/任务 API 的本地联调故事：技能热重载、护栏开关、模拟 MCP 延迟等桌面侧体验。",
          eyebrow: "EvoPanel",
          insights: [
            "桌面与线上共享同一技能清单",
            "离线 mock MCP Server",
            "排障路径与首页能力矩阵对齐",
          ],
          metrics: [
            { label: "Track", value: "EvoPanel" },
            { label: "State", value: "规划中" },
            { label: "Priority", value: "P2" },
          ],
          slug: "voice-agent-field-notes",
          status: "规划中",
          title: "桌面联调与网关模拟",
          track: "Developer experience",
        },
        {
          accent: "tertiary",
          description:
            "用可视化时间线展示多子 Agent 并行取证、汇合校验与人工接管点，对应工单/运维类 DAG 场景。",
          eyebrow: "多智能体",
          insights: [
            "Planner / Worker / Critic 泳道",
            "共享任务记忆与冲突提示",
            "与演进日志里程碑交叉引用",
          ],
          metrics: [
            { label: "Track", value: "DAG scenarios" },
            { label: "State", value: "Research" },
            { label: "Priority", value: "P2" },
          ],
          slug: "multi-agent-orchestra",
          status: "Research",
          title: "DAG 场景编排沙盘",
          track: "Orchestration",
        },
      ],
      hero: {
        description:
          "实验页用于验证编排、MCP、EvoPanel 与观测相关交互稿，与首页「典型场景」互为补充；不承诺已上线的托管对话或模型竞技场能力。",
        eyebrow: "Lab",
        title: "面向集成与编排的高方差试验场",
      },
    },
    mcp: {
      capabilities: [
        {
          accent: "primary",
          description: "把协议接口与 UI action、tool registry 对齐，避免 agent 直接越权访问。",
          title: "Protocol-first routing",
        },
        {
          accent: "secondary",
          description: "保留工具发现与执行日志，让能力接入链路具备可观察性。",
          title: "Inspectable execution",
        },
        {
          accent: "tertiary",
          description: "为未来接入外部系统、仓库与服务保留统一的安全边界。",
          title: "Controlled surface area",
        },
      ],
      logs: [
        "$ mcp:list --surface ai-site",
        "[ok] filesystem.readonly",
        "[ok] github.issue_search",
        "[ok] browser.fetch",
        "[pending] deploy.ecs",
        "_",
      ],
      recentCalls: [
        { accent: "primary", target: "DESIGN.md", tool: "filesystem.read" },
        { accent: "secondary", target: "GitHub Issues", tool: "github.search" },
        { accent: "tertiary", target: "Deploy Queue", tool: "deploy.prepare" },
      ],
      registry: [
        { accent: "primary", label: "Adapters", value: "08" },
        { accent: "secondary", label: "Policies", value: "14" },
        { accent: "tertiary", label: "Pending Auth", value: "01" },
      ],
      safeguards: [
        {
          accent: "primary",
          description: "把不同工具按 server、权限和调用风险拆成明确层级。",
          title: "Capability zoning",
        },
        {
          accent: "secondary",
          description: "强制 schema-first 调用，先读 descriptor 再执行工具。",
          title: "Schema gate",
        },
        {
          accent: "tertiary",
          description: "把长时任务与高风险操作留给独立 worker 或人工确认。",
          title: "Human fallback",
        },
      ],
      hero: {
        description: "MCP 页面不是功能清单，而是展示 agent 如何安全地发现、理解并连接到真实工具能力。",
        eyebrow: "MCP Interface",
        status: "Protocol bridge online",
        title: "把工具协议变成可控、可解释、可扩展的能力桥梁",
      },
    },
  },
  en: {
    admin: {
      cards: [
        {
          accent: "primary",
          cta: "Open traces",
          description:
            "A unified surface for LLM runs, tool calls, session trails, and key event streams.",
          eyebrow: "Observability",
          href: "/admin/observability",
          title: "Live Signal Deck",
        },
        {
          accent: "secondary",
          cta: "Open jobs",
          description:
            "Worker scheduling, sync tasks, failure recovery, and cron visibility.",
          eyebrow: "Jobs",
          href: "/admin/jobs",
          title: "Job Orchestrator",
        },
        {
          accent: "tertiary",
          cta: "Open evolution",
          description:
            "Knowledge sync, digest preview, growth events, and ingestion controls.",
          eyebrow: "Evolution",
          href: "/admin/evolution",
          title: "Growth Controls",
        },
      ],
      metrics: [
        { accent: "primary", label: "Live Sessions", value: "128" },
        { accent: "secondary", label: "Worker Health", value: "97%" },
        { accent: "tertiary", label: "Weekly Digest", value: "Ready" },
      ],
      timeline: [
        {
          accent: "primary",
          date: "10 min ago",
          description:
            "The first real Agent / Arena / Workflow / Knowledge pages landed and passed production builds.",
          title: "Phase 1 page shells synced",
        },
        {
          accent: "secondary",
          date: "34 min ago",
          description:
            "The knowledge context pipeline was rebuilt so chat citations stay aligned with the new page copy.",
          title: "Context pipeline refreshed",
        },
        {
          accent: "tertiary",
          date: "Today",
          description:
            "Evolution controls were reserved for future Resume and Blog ingestion.",
          title: "Growth controls reserved",
        },
      ],
    },
    adminEvolution: {
      controls: [
        {
          accent: "primary",
          description:
            "Recompute content embeddings, refresh timestamps, and rerank cited sources.",
          label: "Rebuild Knowledge Index",
        },
        {
          accent: "secondary",
          description:
            "Run GitHub and Blog sync, then refresh the evolution timeline.",
          label: "Run Sync Pipeline",
        },
        {
          accent: "tertiary",
          description:
            "Generate the weekly growth summary that later surfaces on the homepage and admin.",
          label: "Generate Weekly Digest",
        },
      ],
      digest: {
        bullets: [
          "Primary theme: the Stitch design system now powers four real AI pages.",
          "Core change: `/ai/chat`, `/ai` hub, `/ai/mcp`, and `/admin` surfaces are next in line for full reference alignment.",
          "Next step: finish the remaining placeholder shells before Phase 2 Resume demo migration begins.",
        ],
        title: "Digest Preview",
      },
      metrics: [
        { accent: "primary", label: "Index Version", value: "v1.4" },
        { accent: "secondary", label: "Last Sync", value: "6 min" },
        { accent: "tertiary", label: "Digest Status", value: "Draft" },
      ],
      timeline: [
        {
          accent: "primary",
          date: "2026-04-10",
          description:
            "AI pages were upgraded from placeholders into real Stitch-style surfaces.",
          title: "AI page reality pass",
        },
        {
          accent: "secondary",
          date: "2026-04-10",
          description:
            "Knowledge retrieval expanded to `DESIGN.md`, `MEMORY.md`, and typed content.",
          title: "Retrieval context expanded",
        },
        {
          accent: "tertiary",
          date: "Upcoming",
          description:
            "GitHub sync, weekly digest, and Coding DNA rebuild are queued as the next evolution loops.",
          title: "Autonomous evolution queue",
        },
      ],
    },
    adminJobs: {
      logs: [
        "worker:init -> schedule registry loaded",
        "[09:00] weeklyDigest queued",
        "[09:01] githubSync completed in 1.8s",
        "[09:04] codingDnaRebuild refreshed homepage fingerprint",
        "[09:07] metricsAggregate published admin snapshot",
        "_",
      ],
      recentRuns: [
        {
          accent: "secondary",
          duration: "1.8s",
          name: "githubSync",
          status: "completed",
        },
        {
          accent: "primary",
          duration: "1.0s",
          name: "codingDnaRebuild",
          status: "completed",
        },
        {
          accent: "tertiary",
          duration: "0.7s",
          name: "metricsAggregate",
          status: "completed",
        },
      ],
      schedules: [
        {
          accent: "secondary",
          cron: "*/30 * * * *",
          name: "GitHub Sync",
          nextRun: "12 min later",
        },
        {
          accent: "primary",
          cron: "0 */6 * * *",
          name: "Blog Sync",
          nextRun: "3h 12m",
        },
        {
          accent: "tertiary",
          cron: "15 */4 * * *",
          name: "Coding DNA Rebuild",
          nextRun: "48 min later",
        },
        {
          accent: "primary",
          cron: "*/20 * * * *",
          name: "Metrics Aggregate",
          nextRun: "19 min later",
        },
        {
          accent: "tertiary",
          cron: "0 9 * * 1",
          name: "Weekly Digest",
          nextRun: "Mon 09:00",
        },
        {
          accent: "secondary",
          cron: "0 2 * * *",
          name: "Knowledge Ingest",
          nextRun: "02:00 tomorrow",
        },
      ],
    },
    adminObservability: {
      metrics: [
        { accent: "primary", label: "LLM Runs", value: "248" },
        { accent: "secondary", label: "Tool Calls", value: "91" },
        { accent: "tertiary", label: "UI Actions", value: "34" },
      ],
      sessions: [
        {
          accent: "primary",
          location: "Shanghai",
          state: "exploring /ai/chat",
          summary:
            "The visitor inspected sources and follow-ups, then asked multiple architecture questions.",
          title: "Visitor Session 14AF",
        },
        {
          accent: "secondary",
          location: "Singapore",
          state: "navigating /ai/arena",
          summary:
            "The arena view held attention longer, with clicks on Hall of Fame and Cast your verdict.",
          title: "Visitor Session 90KQ",
        },
      ],
      traces: [
        {
          accent: "primary",
          detail:
            "Loaded `DESIGN.md`, `MEMORY.md`, and typed content before GPT response generation.",
          status: "completed",
          title: "retrieveKnowledge",
        },
        {
          accent: "secondary",
          detail:
            "The command palette routed a natural language query into `/ai/chat?prompt=...`.",
          status: "completed",
          title: "commandPalette",
        },
        {
          accent: "tertiary",
          detail:
            "The tour overlay persisted `lastStepId` and resumed from prior session state.",
          status: "completed",
          title: "homeTourMemory",
        },
      ],
    },
    aiHub: {
      hero: {
        ctaLabel: "OPEN SURFACE",
        description:
          "Organize Chat, Agent, Workflow, Knowledge, MCP, and Arena into one navigable intelligence layer instead of a disconnected demo list.",
        inputLabel: "Search, navigate, or ask AI...",
        promptExamples: [
          "Help me understand the AI architecture of this site",
          "Open Agent Mission Control",
          "Compare the roles of GPT-5 and Claude in this platform",
        ],
        status: "Living interface online",
        terminalLines: [
          "$ route --surface ai-site",
          "[ok] agent mission control",
          "[ok] workflow editor",
          "[ok] knowledge archive",
          "[ok] protocol bridge",
        ],
        title: "The AI platform is the neural gateway into this site",
      },
      metrics: [
        { accent: "primary", label: "Surfaces", value: "7 live" },
        { accent: "secondary", label: "Runtime", value: "GPT-first" },
        { accent: "tertiary", label: "Context", value: "RAG warm" },
      ],
      modules: [
        {
          accent: "primary",
          cta: "Enter chat",
          description:
            "The real conversation layer for streaming replies, cited sources, tool calls, and future artifacts.",
          eyebrow: "Chat",
          href: "/about",
          title: "Neural Chat",
        },
        {
          accent: "secondary",
          cta: "Watch it execute",
          description:
            "Visualize the full chain of planning, tool calling, observation, and response.",
          eyebrow: "Agent",
          href: "/evolution",
          title: "Mission Control",
        },
        {
          accent: "primary",
          cta: "Open canvas",
          description:
            "A Figma-like workflow canvas with nodes, execution logs, and orchestration structure.",
          eyebrow: "Workflow",
          href: "/lab",
          title: "Sentient Flow",
        },
        {
          accent: "secondary",
          cta: "Search memory",
          description:
            "The local retrieval layer powered by typed content and markdown design memory.",
          eyebrow: "Knowledge",
          href: "/about",
          title: "Knowledge Archive",
        },
        {
          accent: "tertiary",
          cta: "Inspect bridge",
          description:
            "Show protocol-driven tool discovery, capability registries, and security boundaries.",
          eyebrow: "MCP",
          href: "/lab",
          title: "Protocol Bridge",
        },
        {
          accent: "secondary",
          cta: "Start showdown",
          description:
            "Put GPT and Claude into a shared arena for side-by-side comparison.",
          eyebrow: "Arena",
          href: "/lab",
          title: "Model Arena",
        },
        {
          accent: "tertiary",
          cta: "Open console",
          description:
            "Real-time monitoring across all AI surfaces — session tracing, tool call chains, knowledge index, and policy enforcement.",
          eyebrow: "Agent OS",
          href: "/admin",
          title: "Agent OS Console",
        },
      ],
    },
    evolution: {
      hero: {
        description:
          "From a single user intent to supervised long-running work: a lead Supervisor aligns goals through clarification, expands plans into dependent steps, mixes async parallelism with synchronous joins, and keeps humans in the loop for corrections, retries, and re-orchestration—including scheduled runs with summaries pushed to Feishu (Lark). This page tracks product milestones for long-task orchestration—not programming-language trivia.",
        eyebrow: "Product evolution",
        title: "Long-running orchestration & collaboration milestones",
      },
      pillars: [
        {
          accent: "primary",
          description:
            "The lead Supervisor owns intent: multi-turn clarification, executable plans, explicit upstream/downstream dependencies, structured handoffs between steps, and DAG gates where parallel branches merge.",
          eyebrow: "Long-running core",
          title: "Supervisor · plan · dependencies & handoffs",
        },
        {
          accent: "secondary",
          description:
            "Live visibility into overall and per-subtask progress; concurrency with queue-friendly scheduling; retries plus supervisor-led fixes, reprioritization, and DAG reshaping—paired with Claude Code–style flows for engineering workloads.",
          eyebrow: "Observable control",
          title: "Monitoring · concurrency · retry & re-orchestration",
        },
        {
          accent: "tertiary",
          description:
            "Durable and cron-like jobs orchestrated by agents: periodic checks, reports, or sync jobs whose outcomes roll into Feishu / Lark channels for operators and stakeholders.",
          eyebrow: "Ops automation",
          title: "Continuous runs · schedules · Feishu reporting",
        },
      ],
      timeline: [
        {
          accent: "primary",
          date: "Phase 1",
          description:
            "Established the supervised long-task mindset—planning, intent alignment, delegated steps, and end-to-end traceability for multi-step business flows.",
          title: "Supervised long-task backbone",
        },
        {
          accent: "secondary",
          date: "Phase 2",
          description:
            "Shipped dependency graphs with merge points, async branches with sync joins, and human-in-the-loop correction, retry, and partial re-orchestration instead of full restarts.",
          title: "Dependency nets & human steering",
        },
        {
          accent: "tertiary",
          date: "Phase 3 · in progress",
          description:
            "Deepening monitoring dashboards and concurrency policies; expanding scheduled and continuous workloads; Feishu reporting hooks; tighter Claude Code–class tooling for long coding missions.",
          title: "Concurrency ops · schedules · Feishu · toolchains",
        },
      ],
    },
    lab: {
      experiments: [
        {
          accent: "primary",
          description:
            "Prototype the narrative chain orchestration events → Skills/MCP calls → sandboxed execution → trace cards for sales demos and UX reviews—not a hosted chat product.",
          eyebrow: "Telemetry cards",
          insights: [
            "Structured summaries of tool inputs and outputs",
            "Shared vocabulary with homepage scenarios",
            "Placeholder fields for audit exports",
          ],
          metrics: [
            { label: "Track", value: "Observability UI" },
            { label: "State", value: "Scaffolded" },
            { label: "Priority", value: "P1" },
          ],
          slug: "artifact-radar",
          status: "Experimental",
          title: "Trace and artifact card prototype",
          track: "Orchestration UX",
        },
        {
          accent: "secondary",
          description:
            "Explore EvoPanel stories against gateway and job APIs: skill hot reload, guardrail toggles, simulated MCP latency for desktop-first debugging.",
          eyebrow: "EvoPanel",
          insights: [
            "Desktop shares the same skill manifest as online",
            "Offline mock MCP servers",
            "Triage paths aligned with homepage architecture slices",
          ],
          metrics: [
            { label: "Track", value: "EvoPanel" },
            { label: "State", value: "Planned" },
            { label: "Priority", value: "P2" },
          ],
          slug: "voice-agent-field-notes",
          status: "Planned",
          title: "Desktop co-debug and gateway mocks",
          track: "Developer experience",
        },
        {
          accent: "tertiary",
          description:
            "Visual timeline for parallel sub-agents, merge checks, and human takeover—mirroring ticket and ops DAG scenarios.",
          eyebrow: "Multi-agent",
          insights: [
            "Planner / worker / critic swimlanes",
            "Shared task memory with conflict hints",
            "Cross-links to evolution milestones",
          ],
          metrics: [
            { label: "Track", value: "DAG scenarios" },
            { label: "State", value: "Research" },
            { label: "Priority", value: "P2" },
          ],
          slug: "multi-agent-orchestra",
          status: "Research",
          title: "DAG scenario sandbox",
          track: "Orchestration",
        },
      ],
      hero: {
        description:
          "Lab pages validate UX for orchestration, MCP, EvoPanel, and telemetry—complementing homepage scenarios without promising hosted chat or model arenas.",
        eyebrow: "Lab",
        title: "High-variance experiments for integration stories",
      },
    },
    mcp: {
      capabilities: [
        {
          accent: "primary",
          description:
            "Align protocol surfaces with UI actions and tool registries so agents never bypass the intended boundary.",
          title: "Protocol-first routing",
        },
        {
          accent: "secondary",
          description:
            "Keep tool discovery and execution logs inspectable so capability integration remains observable.",
          title: "Inspectable execution",
        },
        {
          accent: "tertiary",
          description:
            "Reserve one security boundary for future connections to external systems, repos, and services.",
          title: "Controlled surface area",
        },
      ],
      logs: [
        "$ mcp:list --surface ai-site",
        "[ok] filesystem.readonly",
        "[ok] github.issue_search",
        "[ok] browser.fetch",
        "[pending] deploy.ecs",
        "_",
      ],
      recentCalls: [
        { accent: "primary", target: "DESIGN.md", tool: "filesystem.read" },
        { accent: "secondary", target: "GitHub Issues", tool: "github.search" },
        { accent: "tertiary", target: "Deploy Queue", tool: "deploy.prepare" },
      ],
      registry: [
        { accent: "primary", label: "Adapters", value: "08" },
        { accent: "secondary", label: "Policies", value: "14" },
        { accent: "tertiary", label: "Pending Auth", value: "01" },
      ],
      safeguards: [
        {
          accent: "primary",
          description:
            "Separate tools into explicit layers by server, permission, and execution risk.",
          title: "Capability zoning",
        },
        {
          accent: "secondary",
          description:
            "Enforce schema-first invocation so every tool call reads its descriptor before execution.",
          title: "Schema gate",
        },
        {
          accent: "tertiary",
          description:
            "Push long-running or high-risk operations into workers or human approval flows.",
          title: "Human fallback",
        },
      ],
      hero: {
        description:
          "The MCP page is not a feature checklist. It demonstrates how agents safely discover, understand, and connect to real capabilities.",
        eyebrow: "MCP Interface",
        status: "Protocol bridge online",
        title: "Turn tool protocol into a controllable, explainable, extensible capability bridge",
      },
    },
  },
};

export const platformPages = platformPagesByLocale[defaultLocale];

export function getPlatformPages(locale: SiteLocale) {
  return platformPagesByLocale[locale];
}
