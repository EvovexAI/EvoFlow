import { evoVexBrand } from "./site-identity";
import { siteLinks } from "./site-links";
import {
  defaultLocale,
  type LocalizedValue,
  type SiteLocale,
} from "./locales";

export interface SiteCopy {
  shell: {
    status: string;
    githubLabel: string;
    initializeAi: string;
    themeLabel: string;
    navigation: Array<{
      href: string;
      label: string;
    }>;
  };
  footer: {
    brand: string;
    tagline: string;
    links: Array<{
      href: string;
      label: string;
    }>;
  };
  aiLayout: {
    eyebrow: string;
    title: string;
    description: string;
  };
  adminLayout: {
    eyebrow: string;
    title: string;
    description: string;
  };
  pages: {
    ai: PlaceholderPageContent;
    aiChat: PlaceholderPageContent;
    aiAgent: PlaceholderPageContent;
    aiOs: PlaceholderPageContent;
    aiWorkflow: PlaceholderPageContent;
    aiKnowledge: PlaceholderPageContent;
    aiMcp: PlaceholderPageContent;
    aiArena: PlaceholderPageContent;
    about: PlaceholderPageContent;
    evolution: PlaceholderPageContent;
    lab: PlaceholderPageContent;
    labDetail: PlaceholderPageContent;
    admin: PlaceholderPageContent;
    adminObservability: PlaceholderPageContent;
    adminJobs: PlaceholderPageContent;
    adminEvolution: PlaceholderPageContent;
    resume: PlaceholderPageContent;
  };
}

interface PlaceholderPageContent {
  eyebrow: string;
  title: string;
  description: string;
}

export const siteCopyByLocale: LocalizedValue<SiteCopy> = {
  zh: {
    shell: {
      status: "",
      githubLabel: "GitHub",
      initializeAi: "仓库与协作",
      themeLabel: "主题",
      navigation: [
        { href: siteLinks.docsSite, label: "文档" },
        { href: "/#capabilities", label: "功能说明" },
        { href: siteLinks.blog, label: "下载" },
        { href: "/about", label: "关于" },
      ],
    },
    footer: {
      brand: "EvoFlow",
      tagline:
        `「${evoVexBrand.sloganZh}」${evoVexBrand.blurbZh} 超级智能体编排栈：Supervisor 总控、沙箱工具执行、可恢复状态与 Skills/MCP 集成。本站概述能力矩阵、典型场景与演进节奏；安装包与文档可下载体验，欢迎在 GitHub Star；完整源码开放将结合社区反馈推进。`,
      links: [
        { href: siteLinks.docsSite, label: "项目文档" },
        { href: siteLinks.github, label: "GitHub 仓库" },
        { href: siteLinks.blog, label: "下载与发行版" },
        { href: siteLinks.source, label: "快速上手" },
      ],
    },
    aiLayout: {
      eyebrow: "规划中",
      title: "演示型 AI 壳层（未在官网开放）",
      description: "与 EvoFlow 编排叙事对齐的占位路由；当前营销站仅提供产品文档式页面与键盘导航。",
    },
    adminLayout: {
      eyebrow: "内部控制台",
      title: "管理台",
      description: "可观测性、任务链路与进化控制",
    },
    pages: {
      ai: {
        eyebrow: "占位",
        title: "AI 演示入口（未开放）",
        description: "此官网不提供访客对话或模型竞技场；编排能力请参见首页能力矩阵与 EvoFlow 运行时仓库。",
      },
      aiChat: {
        eyebrow: "占位",
        title: "Chat 演示（未开放）",
        description: "若未来需要浏览器内对话，将与 EvoFlow 编排核与工具轨迹打通；当前仅保留路由占位。",
      },
      aiAgent: {
        eyebrow: "占位",
        title: "Agent 控制台（未开放）",
        description: "规划—工具—反思的可视化与 EvoFlow DAG/子 Agent 语义对齐的方向，尚未作为公开产品发布。",
      },
      aiOs: {
        eyebrow: "占位",
        title: "运行时大屏（未开放）",
        description: "会话、任务与工具链观测在 EvoFlow 管理台与指标体系中落地；此处为模板占位。",
      },
      aiWorkflow: {
        eyebrow: "占位",
        title: "工作流画布（未开放）",
        description: "与编排 DAG、任务重试与遥测结合的潜在 UI 方向；当前请用文档与 API 理解编排语义。",
      },
      aiKnowledge: {
        eyebrow: "占位",
        title: "知识库 UI（未开放）",
        description: "企业 RAG 与记忆治理见首页典型场景；浏览器侧知识索引非本阶段交付物。",
      },
      aiMcp: {
        eyebrow: "占位",
        title: "MCP 控制台（未开放）",
        description: "MCP Server 发现与授权在 EvoFlow 技能与集成面实现；此处无实时控制台。",
      },
      aiArena: {
        eyebrow: "占位",
        title: "模型对比（未开放）",
        description: "官网不承载模型打榜；选型请结合自有评测与 EvoFlow 编排/护栏成本评估。",
      },
      about: {
        eyebrow: "关于",
        title: "关于 EvoFlow",
        description:
          "设计原则、模块职责、入口矩阵与 GitHub / 文档入口——帮助架构师与采购在「编排 / 沙箱 / 记忆 / 集成」上对齐口径。",
      },
      evolution: {
        eyebrow: "演进",
        title: "演进日志",
        description:
          "超级总控智能体（Supervisor）长任务、依赖与信息传递、异步同步、监控与并发、持续与定时、纠错重试与重编排、飞书汇报等产品里程碑（非代码栈展示）。",
      },
      lab: {
        eyebrow: "实验",
        title: "Lab",
        description:
          "围绕编排、MCP、EvoPanel 与观测的实验页与演示骨架，用于验证集成故事与交互稿（非生产服务）。",
      },
      labDetail: {
        eyebrow: "实验",
        title: "单项实验",
        description: "动态路由承载具体实验说明、依赖能力与当前状态（实验/规划中）。",
      },
      admin: {
        eyebrow: "Admin",
        title: "Internal Console",
        description: "受保护的内部控制台，用于 observability、jobs 和 evolution 管理。",
      },
      adminObservability: {
        eyebrow: "Admin",
        title: "Observability",
        description: "LLM runs、tool calls、artifact renders 与 session visibility 将在这里集中展示。",
      },
      adminJobs: {
        eyebrow: "Admin",
        title: "Job Runs",
        description: "查看 worker 执行历史、调度计划、失败记录与重试状态。",
      },
      adminEvolution: {
        eyebrow: "Admin",
        title: "Evolution Admin",
        description: "用于检查同步状态、成长日志与生成式 digest 的内部控制界面。",
      },
      resume: {
        eyebrow: "文档",
        title: "项目履历页",
        description:
          "以履历版式呈现 EvoFlow 的模块路线图、能力快照与站内 / GitHub 入口，便于对外转发 PDF 或链接。",
      },
    },
  },
  en: {
    shell: {
      status: "",
      githubLabel: "GitHub",
      initializeAi: "Repo & collab",
      themeLabel: "Theme",
      navigation: [
        { href: siteLinks.docsSite, label: "Docs" },
        { href: "/#capabilities", label: "Product" },
        { href: siteLinks.blog, label: "Download" },
        { href: "/about", label: "About" },
      ],
    },
    footer: {
      brand: "EvoFlow",
      tagline:
        `"${evoVexBrand.sloganEn}" — ${evoVexBrand.blurbEn} Super-agent orchestration: Supervisor control, sandboxed tools, durable state, and Skills/MCP integrations. This site summarizes capabilities, scenarios, and roadmap—downloadable builds and docs are linked below; star us on GitHub for updates, with full source opening tied to community traction.`,
      links: [
        { href: siteLinks.docsSite, label: "Documentation" },
        { href: siteLinks.github, label: "GitHub" },
        { href: siteLinks.blog, label: "Downloads & releases" },
        { href: siteLinks.source, label: "Quickstart" },
      ],
    },
    aiLayout: {
      eyebrow: "Planned",
      title: "Demo AI shell (not shipped on this site)",
      description: "Placeholder routes aligned with EvoFlow storytelling; the marketing site stays documentation-first with keyboard navigation.",
    },
    adminLayout: {
      eyebrow: "Internal Console",
      title: "Admin",
      description: "Observability, jobs, and evolution control",
    },
    pages: {
      ai: {
        eyebrow: "Placeholder",
        title: "AI demo hub (not available)",
        description:
          "This marketing site does not ship visitor chat or model arenas; see the homepage matrix and the EvoFlow runtime repository for orchestration depth.",
      },
      aiChat: {
        eyebrow: "Placeholder",
        title: "Chat demo (not available)",
        description:
          "Any future browser chat would align with EvoFlow traces and guardrails; the route remains a template stub.",
      },
      aiAgent: {
        eyebrow: "Placeholder",
        title: "Agent console (not available)",
        description:
          "Visual plan–tool–reflect flows may mirror EvoFlow DAG semantics; nothing here is a released product surface yet.",
      },
      aiOs: {
        eyebrow: "Placeholder",
        title: "Runtime dashboard (not available)",
        description:
          "Session, job, and tool-chain telemetry belongs in EvoFlow admin and metrics stacks; this is a scaffold only.",
      },
      aiWorkflow: {
        eyebrow: "Placeholder",
        title: "Workflow canvas (not available)",
        description:
          "Potential UI for DAG editing, retries, and telemetry—today orchestration is documented via APIs and specs.",
      },
      aiKnowledge: {
        eyebrow: "Placeholder",
        title: "Knowledge UI (not available)",
        description:
          "Enterprise RAG and memory governance are described under homepage scenarios; no hosted knowledge product here.",
      },
      aiMcp: {
        eyebrow: "Placeholder",
        title: "MCP console (not available)",
        description:
          "MCP discovery and authorization ship through EvoFlow skills and integrations; there is no live console on this site.",
      },
      aiArena: {
        eyebrow: "Placeholder",
        title: "Model arena (not available)",
        description:
          "The marketing site does not host leaderboards; evaluate models with your own harness plus EvoFlow orchestration costs.",
      },
      about: {
        eyebrow: "About",
        title: "About EvoFlow",
        description:
          "Principles, module responsibilities, entry matrix, and GitHub entry points—so architecture and procurement align on orchestration, sandboxing, memory, and integrations.",
      },
      evolution: {
        eyebrow: "Evolution",
        title: "Evolution log",
        description:
          "Product milestones for supervised long runs, dependencies, async/sync joins, monitoring, schedules, Feishu reporting—not a programming-language résumé.",
      },
      lab: {
        eyebrow: "Lab",
        title: "Experiment lab",
        description:
          "Experiment pages for orchestration, MCP, EvoPanel, and telemetry narratives—scaffold demos without pretending they are production services.",
      },
      labDetail: {
        eyebrow: "Lab",
        title: "Single experiment",
        description: "Dynamic routes for experiment briefs, required capabilities, and status (experimental or planned).",
      },
      admin: {
        eyebrow: "Admin",
        title: "Internal Console",
        description: "Protected internal console for observability, jobs, and evolution management.",
      },
      adminObservability: {
        eyebrow: "Admin",
        title: "Observability",
        description: "LLM runs, tool calls, artifact renders, and session visibility will live here.",
      },
      adminJobs: {
        eyebrow: "Admin",
        title: "Job Runs",
        description: "Worker execution history, schedules, failures, and retry visibility.",
      },
      adminEvolution: {
        eyebrow: "Admin",
        title: "Evolution Admin",
        description: "Internal controls and inspection for sync status, growth logs, and generated digests.",
      },
      resume: {
        eyebrow: "Doc",
        title: "Project resume page",
        description:
          "Resume-shaped view of EvoFlow module roadmap, capability snapshot, and on-site plus GitHub entry points for easy PDF or link sharing.",
      },
    },
  },
};

export type PlaceholderPageKey = keyof SiteCopy["pages"];

export const siteCopy = siteCopyByLocale[defaultLocale];

export function getSiteCopy(locale: SiteLocale) {
  return siteCopyByLocale[locale];
}
