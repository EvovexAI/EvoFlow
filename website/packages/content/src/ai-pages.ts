import { defaultLocale, type LocalizedValue, type SiteLocale } from "./locales";

type Accent = "primary" | "secondary" | "tertiary";

interface AgentStep {
  accent: Accent;
  body: string;
  code?: string;
  eyebrow: string;
  time: string;
  title: string;
}

interface AgentTemplate {
  accent: Accent;
  description: string;
  title: string;
}

interface ArenaAnswer {
  accent: Accent;
  bullets?: string[];
  eyebrow: string;
  latency: string;
  name: string;
  paragraphs: string[];
  status: string;
  tagline: string;
}

interface ArenaRecord {
  category: string;
  challenge: string;
  timestamp: string;
  voteSplit: string;
  winner: string;
  winnerAccent: Accent;
}

interface WorkflowDockItem {
  accent: Accent;
  active?: boolean;
  label: string;
  shortLabel: string;
}

interface WorkflowNode {
  accent: Accent;
  badge?: string;
  eyebrow: string;
  note: string;
  positionClass: string;
  title: string;
}

interface WorkflowPath {
  accent: Accent;
  d: string;
  glowDotClassName?: string;
}

interface KnowledgeBadge {
  accent: Accent;
  label: string;
}

interface KnowledgeResult {
  accent: Accent;
  score: string;
  snippet: string;
  source: string;
  tags: string[];
  title: string;
}

interface KnowledgeEvent {
  accent: Accent;
  date: string;
  description: string;
  title: string;
}

interface AiPageExperiences {
  agent: {
    hero: {
      ctaLabel: string;
      helperText: string;
      inputPlaceholder: string;
      outlineWord: string;
      subtitle: string;
    };
    state: {
      capabilities: Array<{
        accent: Accent;
        label: string;
      }>;
      capabilitiesLabel: string;
      metrics: Array<{
        accent: Accent;
        label: string;
        progress: number;
        valueLabel: string;
      }>;
      phases: Array<{
        accent: Accent;
        label: string;
        progress: number;
        stateLabel: string;
      }>;
      statusLabel: string;
      statusValue: string;
      title: string;
    };
    steps: AgentStep[];
    templates: {
      eyebrow: string;
      items: AgentTemplate[];
      title: string;
    };
  };
  arena: {
    battle: {
      left: ArenaAnswer;
      promptLabel: string;
      question: string;
      right: ArenaAnswer;
    };
    hallOfFame: {
      ctaLabel: string;
      description: string;
      records: ArenaRecord[];
      title: string;
    };
    hero: {
      ctaLabel: string;
      eyebrow: string;
      inputPlaceholder: string;
      leftModelLabel: string;
      readinessLabel: string;
      rightModelLabel: string;
    };
    metrics: {
      contextLabel: string;
      leftContext: string;
      leftSpeed: string;
      rightContext: string;
      rightSpeed: string;
      speedLabel: string;
      voteOptions: Array<{
        accent: Accent;
        label: string;
      }>;
      voteTitle: string;
    };
  };
  knowledge: {
    events: {
      items: KnowledgeEvent[];
      title: string;
    };
    hero: {
      badges: KnowledgeBadge[];
      ctaLabel: string;
      inputPlaceholder: string;
      outlineWord: string;
      subtitle: string;
    };
    indexPanel: {
      collections: string[];
      collectionsLabel: string;
      metrics: Array<{
        accent: Accent;
        label: string;
        value: string;
      }>;
      signals: Array<{
        accent: Accent;
        label: string;
        progress: number;
        valueLabel: string;
      }>;
      statusLabel: string;
      statusValue: string;
      title: string;
    };
    memoryAtlas: {
      description: string;
      title: string;
    };
    results: {
      description: string;
      items: KnowledgeResult[];
      title: string;
    };
  };
  workflow: {
    canvas: {
      paths: WorkflowPath[];
      title: string;
    };
    config: {
      actions: {
        primary: string;
        secondary: string;
      };
      modelLabel: string;
      modelValue: string;
      note: string;
      promptLabel: string;
      promptValue: string;
      temperatureLabel: string;
      temperatureValue: string;
      title: string;
    };
    dock: {
      items: WorkflowDockItem[];
    };
    log: {
      latency: string;
      lines: string[];
      status: string;
      title: string;
    };
    nodes: WorkflowNode[];
    shell: {
      runLabel: string;
      workflowName: string;
      zoomLabel: string;
      zoomValue: string;
    };
  };
}

export const aiPageExperiencesByLocale: LocalizedValue<AiPageExperiences> = {
  zh: {
    agent: {
      hero: {
        ctaLabel: "EXECUTE",
        helperText: "输入一个任务，观察 Agent 如何拆解、调用工具并完成响应。",
        inputPlaceholder:
          "给 Agent 一个任务，例如：设计一个 AI 产品登录页 / 写一篇技术博客 / 生成 Python 脚本",
        outlineWord: "AGENT",
        subtitle: "观察人工智能如何推理、规划并执行",
      },
      state: {
        capabilities: [
          { accent: "secondary", label: "WEB_SEARCH" },
          { accent: "primary", label: "FILE_RAG" },
          { accent: "tertiary", label: "UI_ACTIONS" },
          { accent: "secondary", label: "OBS_TRACE" },
        ],
        capabilitiesLabel: "可用能力",
        metrics: [
          {
            accent: "primary",
            label: "Memory Window",
            progress: 10,
            valueLabel: "12.4k / 128k",
          },
          {
            accent: "secondary",
            label: "Tool Coverage",
            progress: 64,
            valueLabel: "4 / 6",
          },
          {
            accent: "tertiary",
            label: "Execution Timer",
            progress: 35,
            valueLabel: "00:07.12",
          },
        ],
        phases: [
          {
            accent: "primary",
            label: "PLAN",
            progress: 100,
            stateLabel: "DONE",
          },
          {
            accent: "secondary",
            label: "EXECUTE",
            progress: 72,
            stateLabel: "LIVE",
          },
          {
            accent: "tertiary",
            label: "REFLECT",
            progress: 18,
            stateLabel: "QUEUED",
          },
        ],
        statusLabel: "Agent Status",
        statusValue: "Active",
        title: "AGENT STATE",
      },
      steps: [
        {
          accent: "primary",
          body:
            "\"用户需要一个 AI SaaS 登录页原型。我先拆解为布局规划、视觉风格选定、交互细节设计和产物输出四个步骤，然后调用知识检索和策略工具补齐上下文。\"",
          eyebrow: "Task Analysis",
          time: "0ms",
          title: "1. PLAN",
        },
        {
          accent: "secondary",
          body: "调用知识检索获取 Agent UX 最佳实践，调用产物策略工具确定 HTML 原型方向和设计参数。",
          code: 'knowledge_search({ query: "AI product login page design" })\nartifact_strategy({ query: "login page prototype" })',
          eyebrow: "Tool Execution",
          time: "1.2s",
          title: "2. TOOL CALL",
        },
        {
          accent: "secondary",
          body:
            "检索到 8 条相关知识片段，策略建议使用 AuroraGlass 设计方向：蓝紫渐变、玻璃拟态、双栏布局。同步生成执行清单确保覆盖输入框、按钮、层级设计。",
          eyebrow: "Context Assembled",
          time: "4.8s",
          title: "3. OBSERVE",
        },
        {
          accent: "tertiary",
          body:
            "生成 3 个产物：高保真 HTML 原型（可直接预览）、配套说明文档（Markdown）、页面结构摘要（JSON），并整合为最终回答。",
          eyebrow: "Synthesis Complete",
          time: "7.1s",
          title: "4. RESPOND",
        },
      ],
      templates: {
        eyebrow: "Mission Templates",
        items: [
          {
            accent: "primary",
            description: "设计一个 AI SaaS 产品的登录页面原型，要求有产品质感和现代设计风格。",
            title: "设计一个 AI 产品登录页",
          },
          {
            accent: "secondary",
            description: "撰写一篇关于 AI Agent 架构演进的技术博客，涵盖从 ReAct 到 Multi-Agent 的发展脉络。",
            title: "撰写 AI Agent 技术博客",
          },
          {
            accent: "tertiary",
            description: "生成一个 Python 数据处理脚本，用于清洗 CSV 数据并输出统计报告。",
            title: "生成 Python 数据处理脚本",
          },
        ],
        title: "可以直接交给 Agent 的任务模板",
      },
    },
    arena: {
      battle: {
        left: {
          accent: "primary",
          eyebrow: "Streaming active",
          latency: "12.4s",
          name: "GPT-5.4",
          paragraphs: [
            "零知识证明允许一方在不暴露原始秘密的前提下，证明自己确实知道这个秘密。对产品工程师来说，它最关键的意义是“验证成立，但明文不出边界”。",
            "如果把传统登录理解成把钥匙交给系统检查，那么 ZKP 更像是在门口做一次不会泄露钥匙形状的验证仪式。它常出现在身份、链上验证和隐私支付这些场景。",
          ],
          status: "State of the art",
          tagline: "Reasoning depth",
        },
        promptLabel: "Challenge",
        question: "向一名产品工程师解释 zero-knowledge proofs，并说明它为什么重要。",
        right: {
          accent: "secondary",
          bullets: [
            "可以验证某个条件成立",
            "不需要公开底层秘密",
            "适合身份、支付和敏感数据协作",
          ],
          eyebrow: "Analysis complete",
          latency: "8.2s // FIRST",
          name: "CLAUDE",
          paragraphs: [
            "Zero-knowledge proof 解决的问题是：如何让系统相信你满足条件，而不让系统看到你真正持有的数据。它把“可信”与“暴露”拆开了。",
            "如果你在做产品设计，可以把它理解成一种新的信任接口。用户不再必须上传完整凭据，而是上传一种可验证的证明，这会改变隐私产品的交互范式。",
          ],
          status: "Precision mode",
          tagline: "Cognitive clarity",
        },
      },
      hallOfFame: {
        ctaLabel: "查看完整 Archive",
        description: "最近的高强度题目与胜出模型",
        records: [
          {
            category: "Systems Engineering",
            challenge: "Write a Rust implementation of a lock-free queue.",
            timestamp: "2h ago",
            voteSplit: "61 / 39",
            winner: "CLAUDE",
            winnerAccent: "secondary",
          },
          {
            category: "Agent Design",
            challenge: "Design a memory strategy for a long-running coding agent.",
            timestamp: "5h ago",
            voteSplit: "54 / 46",
            winner: "GPT-5.4",
            winnerAccent: "primary",
          },
          {
            category: "Product Thinking",
            challenge: "Explain AI artifacts to a PM with concrete UX examples.",
            timestamp: "Yesterday",
            voteSplit: "50 / 50",
            winner: "TIE",
            winnerAccent: "tertiary",
          },
        ],
        title: "Hall of Fame",
      },
      hero: {
        ctaLabel: "FIGHT",
        eyebrow: "MODEL ARENA",
        inputPlaceholder: "输入一条挑战题，立即发起 GPT 与 Claude 对决",
        leftModelLabel: "GPT-5.4",
        readinessLabel: "系统已武装，准备开战。",
        rightModelLabel: "CLAUDE",
      },
      metrics: {
        contextLabel: "Context Retention",
        leftContext: "128k",
        leftSpeed: "142",
        rightContext: "200k",
        rightSpeed: "189",
        speedLabel: "Processing Speed (Tokens/s)",
        voteOptions: [
          { accent: "primary", label: "GPT-5 Wins" },
          { accent: "tertiary", label: "It's a Tie" },
          { accent: "secondary", label: "Claude Wins" },
        ],
        voteTitle: "Cast your verdict",
      },
    },
    knowledge: {
      events: {
        items: [
          {
            accent: "primary",
            date: "6 min ago",
            description: "重新切分 `DESIGN.md` 与 `MEMORY.md`，补入新的页面骨架上下文。",
            title: "Prompt context refreshed",
          },
          {
            accent: "secondary",
            date: "28 min ago",
            description: "重新计算首页与 AI 页面片段的 embedding，以保持 sources 引用一致。",
            title: "Vector shards rebuilt",
          },
          {
            accent: "tertiary",
            date: "Today",
            description: "为后续 Resume/Blog 同步预留统一的知识摄入接口。",
            title: "Ingestion gateway reserved",
          },
        ],
        title: "Recent Syncs",
      },
      hero: {
        badges: [
          { accent: "secondary", label: "Searching knowledge base..." },
          { accent: "primary", label: "Found 6 ranked sources" },
          { accent: "tertiary", label: "Vector index warm" },
        ],
        ctaLabel: "RETRIEVE",
        inputPlaceholder: "查询一个主题，例如：这套站点的 AI 架构为什么这样设计？",
        outlineWord: "KNOWLEDGE",
        subtitle: "索引文档、检索意图，并把最合适的记忆碎片取出来。",
      },
      indexPanel: {
        collections: [
          "DESIGN.md",
          "MEMORY.md",
          "home.ts",
          "projects.ts",
          "timeline.ts",
          "site-copy.ts",
        ],
        collectionsLabel: "Indexed Collections",
        metrics: [
          { accent: "primary", label: "Vector Docs", value: "482" },
          { accent: "secondary", label: "Hit Rate", value: "91%" },
          { accent: "tertiary", label: "Embeddings", value: "128k" },
        ],
        signals: [
          {
            accent: "secondary",
            label: "Retrieval Latency",
            progress: 78,
            valueLabel: "42ms",
          },
          {
            accent: "primary",
            label: "Recall Quality",
            progress: 92,
            valueLabel: "92 / 100",
          },
          {
            accent: "tertiary",
            label: "Freshness",
            progress: 87,
            valueLabel: "6 min",
          },
        ],
        statusLabel: "Index Health",
        statusValue: "Synced 6m ago",
        title: "RAG CONTROL",
      },
      memoryAtlas: {
        description: "把文档打碎成可召回的向量块，再沿相关度重新聚类成一张可导航的知识地图。",
        title: "Memory Atlas",
      },
      results: {
        description: "当前查询命中最多的是架构、设计系统和 AI runtime 相关上下文。",
        items: [
          {
            accent: "primary",
            score: "0.97",
            snippet:
              "AI SDK 保持模型通信与 tool calling 的核心可控层，Mastra 作为 workflow / memory / RAG 的 enhancement layer 按需接入。",
            source: "DESIGN.md",
            tags: ["architecture", "AI SDK", "Mastra"],
            title: "Core stack decision",
          },
          {
            accent: "secondary",
            score: "0.92",
            snippet:
              "Stitch 的视觉语言正在被拆成 tokens、primitives 与 composable page shells，避免 AI 页面继续堆积硬编码样式。",
            source: "MEMORY.md",
            tags: ["design system", "phase 1"],
            title: "Current UI foundation",
          },
          {
            accent: "tertiary",
            score: "0.88",
            snippet:
              "typed content 是单一事实源，首页、AI 页面和后续 sources 引用都应该优先从 content 层读取。",
            source: "packages/content",
            tags: ["content schema", "single source of truth"],
            title: "Content layer guidance",
          },
          {
            accent: "primary",
            score: "0.83",
            snippet:
              "Knowledge 检索当前会读取 `DESIGN.md`、`MEMORY.md` 和多个 content 文件，生成 snippet 并写入 Context Panel。",
            source: "knowledge.ts",
            tags: ["retrieval", "sources", "snippets"],
            title: "Retrieval runtime",
          },
        ],
        title: "Retrieval Results",
      },
    },
    workflow: {
      canvas: {
        paths: [
          {
            accent: "secondary",
            d: "M 140 300 C 260 300, 300 300, 420 300",
            glowDotClassName: "left-[24%] top-[42%]",
          },
          {
            accent: "primary",
            d: "M 560 300 C 670 300, 710 250, 840 220",
            glowDotClassName: "left-[53%] top-[36%]",
          },
          {
            accent: "tertiary",
            d: "M 560 300 C 670 300, 710 360, 840 430",
            glowDotClassName: "left-[58%] top-[48%]",
          },
        ],
        title: "Main Canvas",
      },
      config: {
        actions: {
          primary: "Apply Changes",
          secondary: "Advanced Parameters",
        },
        modelLabel: "Selected Model",
        modelValue: "GPT-5 Sentient (Latest)",
        note: "\"The model currently demonstrates 98.4% coherence in logic chaining.\"",
        promptLabel: "System Prompt",
        promptValue:
          "Analyze the input stream and synthesize a neural summary that prioritizes high-context tokens while discarding noise...",
        temperatureLabel: "Temperature",
        temperatureValue: "0.72",
        title: "Node Config",
      },
      dock: {
        items: [
          { accent: "primary", active: true, label: "Logic", shortLabel: "LG" },
          { accent: "secondary", label: "Trigger", shortLabel: "TR" },
          { accent: "secondary", label: "Data", shortLabel: "DB" },
          { accent: "tertiary", label: "Action", shortLabel: "AC" },
          { accent: "primary", label: "Output", shortLabel: "OUT" },
        ],
      },
      log: {
        latency: "Latency: 24ms",
        lines: [
          "Initializing node sequence...",
          "[14:22:01] Trigger::Input captured 1.2kb stream",
          "[14:22:02] Inference::GPT-5 calculating high-order semantics...",
          "[14:22:04] Logic::Success bridge established",
          "_",
        ],
        status: "3 nodes running...",
        title: "Execution Log",
      },
      nodes: [
        {
          accent: "secondary",
          eyebrow: "Trigger",
          note: "Capture user input and normalize the stream.",
          positionClass: "left-[8%] top-[40%] w-48",
          title: "User Input",
        },
        {
          accent: "primary",
          badge: "Active",
          eyebrow: "Inference",
          note: "GPT-5 Neural // model-v5-sentient",
          positionClass: "left-[36%] top-[34%] w-60",
          title: "GPT-5 Neural",
        },
        {
          accent: "tertiary",
          eyebrow: "Logic",
          note: "Branch to success/fail and emit telemetry.",
          positionClass: "left-[72%] top-[20%] w-52",
          title: "Check Success",
        },
        {
          accent: "secondary",
          eyebrow: "Output",
          note: "Persist structured result and prepare downstream handoff.",
          positionClass: "left-[72%] top-[56%] w-52",
          title: "Synthesis Output",
        },
      ],
      shell: {
        runLabel: "Run",
        workflowName: "Neural Summarizer",
        zoomLabel: "Zoom",
        zoomValue: "94%",
      },
    },
  },
  en: {
    agent: {
      hero: {
        ctaLabel: "EXECUTE",
        helperText:
          "Drop in a mission and watch the agent decompose the task, call tools, and synthesize a response.",
        inputPlaceholder:
          "Give the agent a task, e.g.: Design an AI product login page / Write a tech blog / Generate a Python script",
        outlineWord: "AGENT",
        subtitle: "Watch artificial intelligence reason, plan, and act",
      },
      state: {
        capabilities: [
          { accent: "secondary", label: "WEB_SEARCH" },
          { accent: "primary", label: "FILE_RAG" },
          { accent: "tertiary", label: "UI_ACTIONS" },
          { accent: "secondary", label: "OBS_TRACE" },
        ],
        capabilitiesLabel: "Available capabilities",
        metrics: [
          {
            accent: "primary",
            label: "Memory Window",
            progress: 10,
            valueLabel: "12.4k / 128k",
          },
          {
            accent: "secondary",
            label: "Tool Coverage",
            progress: 64,
            valueLabel: "4 / 6",
          },
          {
            accent: "tertiary",
            label: "Execution Timer",
            progress: 35,
            valueLabel: "00:07.12",
          },
        ],
        phases: [
          {
            accent: "primary",
            label: "PLAN",
            progress: 100,
            stateLabel: "DONE",
          },
          {
            accent: "secondary",
            label: "EXECUTE",
            progress: 72,
            stateLabel: "LIVE",
          },
          {
            accent: "tertiary",
            label: "REFLECT",
            progress: 18,
            stateLabel: "QUEUED",
          },
        ],
        statusLabel: "Agent Status",
        statusValue: "Active",
        title: "AGENT STATE",
      },
      steps: [
        {
          accent: "primary",
          body:
            "\"The user needs an AI SaaS login page prototype. I'll decompose this into layout planning, visual style selection, interaction detail design, and artifact output, then call knowledge search and strategy tools.\"",
          eyebrow: "Task Analysis",
          time: "0ms",
          title: "1. PLAN",
        },
        {
          accent: "secondary",
          body:
            "Calling knowledge search for Agent UX best practices and artifact strategy tool to determine HTML prototype direction and design parameters.",
          code: 'knowledge_search({ query: "AI product login page design" })\nartifact_strategy({ query: "login page prototype" })',
          eyebrow: "Tool Execution",
          time: "1.2s",
          title: "2. TOOL CALL",
        },
        {
          accent: "secondary",
          body:
            "Retrieved 8 relevant knowledge snippets. Strategy recommends AuroraGlass design direction: blue-purple gradients, glassmorphism, split layout. Generating implementation checklist for inputs, buttons, and hierarchy.",
          eyebrow: "Context Assembled",
          time: "4.8s",
          title: "3. OBSERVE",
        },
        {
          accent: "tertiary",
          body:
            "Generating 3 artifacts: a high-fidelity HTML prototype (live-previewable), supporting documentation (Markdown), and page structure summary (JSON), then composing the final answer.",
          eyebrow: "Synthesis Complete",
          time: "7.1s",
          title: "4. RESPOND",
        },
      ],
      templates: {
        eyebrow: "Mission Templates",
        items: [
          {
            accent: "primary",
            description:
              "Design a polished login page prototype for an AI SaaS product with modern aesthetics and product-grade quality.",
            title: "Design an AI product login page",
          },
          {
            accent: "secondary",
            description:
              "Write a technical blog post about AI Agent architecture evolution, from ReAct patterns to Multi-Agent systems.",
            title: "Write an AI Agent tech blog",
          },
          {
            accent: "tertiary",
            description:
              "Generate a Python data processing script that cleans CSV data and outputs a statistical report.",
            title: "Generate a Python data pipeline",
          },
        ],
        title: "Mission templates ready for the agent",
      },
    },
    arena: {
      battle: {
        left: {
          accent: "primary",
          eyebrow: "Streaming active",
          latency: "12.4s",
          name: "GPT-5.4",
          paragraphs: [
            "Zero-knowledge proofs let one party prove it knows a secret without revealing the secret itself. For a product engineer, the key idea is that verification succeeds while the underlying private data stays sealed.",
            "If traditional authentication feels like handing over the key for inspection, ZKPs are more like demonstrating that the key fits without exposing its shape. That matters for identity, on-chain verification, and privacy-sensitive payments.",
          ],
          status: "State of the art",
          tagline: "Reasoning depth",
        },
        promptLabel: "Challenge",
        question:
          "Explain zero-knowledge proofs to a product engineer and why they matter.",
        right: {
          accent: "secondary",
          bullets: [
            "A condition can be verified",
            "The underlying secret never needs to be exposed",
            "Useful for identity, payments, and sensitive collaboration",
          ],
          eyebrow: "Analysis complete",
          latency: "8.2s // FIRST",
          name: "CLAUDE",
          paragraphs: [
            "A zero-knowledge proof solves this problem: how can a system trust that you satisfy a condition without ever seeing the protected data itself? It decouples trust from disclosure.",
            "From a product perspective, it changes the shape of the trust interface. Users no longer need to upload raw credentials, only a proof, which can fundamentally improve privacy-first interaction design.",
          ],
          status: "Precision mode",
          tagline: "Cognitive clarity",
        },
      },
      hallOfFame: {
        ctaLabel: "View full archive",
        description: "Recent high-stakes prompts and the winning model",
        records: [
          {
            category: "Systems Engineering",
            challenge: "Write a Rust implementation of a lock-free queue.",
            timestamp: "2h ago",
            voteSplit: "61 / 39",
            winner: "CLAUDE",
            winnerAccent: "secondary",
          },
          {
            category: "Agent Design",
            challenge: "Design a memory strategy for a long-running coding agent.",
            timestamp: "5h ago",
            voteSplit: "54 / 46",
            winner: "GPT-5.4",
            winnerAccent: "primary",
          },
          {
            category: "Product Thinking",
            challenge: "Explain AI artifacts to a PM with concrete UX examples.",
            timestamp: "Yesterday",
            voteSplit: "50 / 50",
            winner: "TIE",
            winnerAccent: "tertiary",
          },
        ],
        title: "Hall of Fame",
      },
      hero: {
        ctaLabel: "FIGHT",
        eyebrow: "MODEL ARENA",
        inputPlaceholder: "Enter a challenge prompt and launch a GPT vs Claude showdown",
        leftModelLabel: "GPT-5.4",
        readinessLabel: "System armed. Ready for deployment.",
        rightModelLabel: "CLAUDE",
      },
      metrics: {
        contextLabel: "Context Retention",
        leftContext: "128k",
        leftSpeed: "142",
        rightContext: "200k",
        rightSpeed: "189",
        speedLabel: "Processing Speed (Tokens/s)",
        voteOptions: [
          { accent: "primary", label: "GPT-5 Wins" },
          { accent: "tertiary", label: "It's a Tie" },
          { accent: "secondary", label: "Claude Wins" },
        ],
        voteTitle: "Cast your verdict",
      },
    },
    knowledge: {
      events: {
        items: [
          {
            accent: "primary",
            date: "6 min ago",
            description:
              "Re-chunked `DESIGN.md` and `MEMORY.md` to include the latest page skeleton decisions.",
            title: "Prompt context refreshed",
          },
          {
            accent: "secondary",
            date: "28 min ago",
            description:
              "Recomputed embeddings for the homepage and AI page content to keep cited sources aligned.",
            title: "Vector shards rebuilt",
          },
          {
            accent: "tertiary",
            date: "Today",
            description:
              "Reserved a unified ingestion interface for future Resume and Blog sync pipelines.",
            title: "Ingestion gateway reserved",
          },
        ],
        title: "Recent Syncs",
      },
      hero: {
        badges: [
          { accent: "secondary", label: "Searching knowledge base..." },
          { accent: "primary", label: "Found 6 ranked sources" },
          { accent: "tertiary", label: "Vector index warm" },
        ],
        ctaLabel: "RETRIEVE",
        inputPlaceholder:
          "Query a topic, for example: Why is the AI architecture for this site designed this way?",
        outlineWord: "KNOWLEDGE",
        subtitle:
          "Index documentation, retrieve intent, and surface the right memory shard for the current task.",
      },
      indexPanel: {
        collections: [
          "DESIGN.md",
          "MEMORY.md",
          "home.ts",
          "projects.ts",
          "timeline.ts",
          "site-copy.ts",
        ],
        collectionsLabel: "Indexed Collections",
        metrics: [
          { accent: "primary", label: "Vector Docs", value: "482" },
          { accent: "secondary", label: "Hit Rate", value: "91%" },
          { accent: "tertiary", label: "Embeddings", value: "128k" },
        ],
        signals: [
          {
            accent: "secondary",
            label: "Retrieval Latency",
            progress: 78,
            valueLabel: "42ms",
          },
          {
            accent: "primary",
            label: "Recall Quality",
            progress: 92,
            valueLabel: "92 / 100",
          },
          {
            accent: "tertiary",
            label: "Freshness",
            progress: 87,
            valueLabel: "6 min",
          },
        ],
        statusLabel: "Index Health",
        statusValue: "Synced 6m ago",
        title: "RAG CONTROL",
      },
      memoryAtlas: {
        description:
          "Break raw documents into retrievable vectors, then regroup them by semantic proximity into a navigable atlas of memory.",
        title: "Memory Atlas",
      },
      results: {
        description:
          "The current query is pulling strongest from architecture, design system, and AI runtime context.",
        items: [
          {
            accent: "primary",
            score: "0.97",
            snippet:
              "AI SDK remains the controllable core layer for model communication and tool calling, while Mastra is added only as an enhancement layer for workflow, memory, and RAG.",
            source: "DESIGN.md",
            tags: ["architecture", "AI SDK", "Mastra"],
            title: "Core stack decision",
          },
          {
            accent: "secondary",
            score: "0.92",
            snippet:
              "The Stitch visual language is being decomposed into tokens, primitives, and composable page shells so AI surfaces stop accumulating hard-coded styles.",
            source: "MEMORY.md",
            tags: ["design system", "phase 1"],
            title: "Current UI foundation",
          },
          {
            accent: "tertiary",
            score: "0.88",
            snippet:
              "Typed content is the single source of truth. The homepage, AI pages, and later cited sources should all read from the content layer first.",
            source: "packages/content",
            tags: ["content schema", "single source of truth"],
            title: "Content layer guidance",
          },
          {
            accent: "primary",
            score: "0.83",
            snippet:
              "Knowledge retrieval currently reads `DESIGN.md`, `MEMORY.md`, and several content files to build snippets that feed the Context Panel.",
            source: "knowledge.ts",
            tags: ["retrieval", "sources", "snippets"],
            title: "Retrieval runtime",
          },
        ],
        title: "Retrieval Results",
      },
    },
    workflow: {
      canvas: {
        paths: [
          {
            accent: "secondary",
            d: "M 140 300 C 260 300, 300 300, 420 300",
            glowDotClassName: "left-[24%] top-[42%]",
          },
          {
            accent: "primary",
            d: "M 560 300 C 670 300, 710 250, 840 220",
            glowDotClassName: "left-[53%] top-[36%]",
          },
          {
            accent: "tertiary",
            d: "M 560 300 C 670 300, 710 360, 840 430",
            glowDotClassName: "left-[58%] top-[48%]",
          },
        ],
        title: "Main Canvas",
      },
      config: {
        actions: {
          primary: "Apply Changes",
          secondary: "Advanced Parameters",
        },
        modelLabel: "Selected Model",
        modelValue: "GPT-5 Sentient (Latest)",
        note:
          "\"The model currently demonstrates 98.4% coherence in logic chaining.\"",
        promptLabel: "System Prompt",
        promptValue:
          "Analyze the input stream and synthesize a neural summary that prioritizes high-context tokens while discarding noise...",
        temperatureLabel: "Temperature",
        temperatureValue: "0.72",
        title: "Node Config",
      },
      dock: {
        items: [
          { accent: "primary", active: true, label: "Logic", shortLabel: "LG" },
          { accent: "secondary", label: "Trigger", shortLabel: "TR" },
          { accent: "secondary", label: "Data", shortLabel: "DB" },
          { accent: "tertiary", label: "Action", shortLabel: "AC" },
          { accent: "primary", label: "Output", shortLabel: "OUT" },
        ],
      },
      log: {
        latency: "Latency: 24ms",
        lines: [
          "Initializing node sequence...",
          "[14:22:01] Trigger::Input captured 1.2kb stream",
          "[14:22:02] Inference::GPT-5 calculating high-order semantics...",
          "[14:22:04] Logic::Success bridge established",
          "_",
        ],
        status: "3 nodes running...",
        title: "Execution Log",
      },
      nodes: [
        {
          accent: "secondary",
          eyebrow: "Trigger",
          note: "Capture user input and normalize the stream.",
          positionClass: "left-[8%] top-[40%] w-48",
          title: "User Input",
        },
        {
          accent: "primary",
          badge: "Active",
          eyebrow: "Inference",
          note: "GPT-5 Neural // model-v5-sentient",
          positionClass: "left-[36%] top-[34%] w-60",
          title: "GPT-5 Neural",
        },
        {
          accent: "tertiary",
          eyebrow: "Logic",
          note: "Branch to success or fail and emit telemetry.",
          positionClass: "left-[72%] top-[20%] w-52",
          title: "Check Success",
        },
        {
          accent: "secondary",
          eyebrow: "Output",
          note: "Persist structured result and prepare downstream handoff.",
          positionClass: "left-[72%] top-[56%] w-52",
          title: "Synthesis Output",
        },
      ],
      shell: {
        runLabel: "Run",
        workflowName: "Neural Summarizer",
        zoomLabel: "Zoom",
        zoomValue: "94%",
      },
    },
  },
};

export const aiPageExperiences = aiPageExperiencesByLocale[defaultLocale];

export function getAiPageExperiences(locale: SiteLocale) {
  return aiPageExperiencesByLocale[locale];
}
