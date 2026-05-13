import type { LocalizedValue } from "./locales";
import { siteLinks } from "./site-links";

/**
 * Section anchors — aligned with tbakerx/react-resume-template (MIT).
 * @see https://github.com/tbakerx/react-resume-template
 */
export type ResumeTemplateSectionId = "about" | "resume" | "portfolio" | "contact";

export interface ResumeHeroAction {
  href: string;
  text: string;
  primary?: boolean;
}

export interface ResumeHighlight {
  label: string;
  text: string;
}

export interface ResumeTimelineRow {
  title: string;
  location: string;
  date: string;
  detail: string;
}

export interface ResumeSkillBar {
  name: string;
  level: number;
  max?: number;
}

export interface ResumeSkillBarGroup {
  name: string;
  skills: ResumeSkillBar[];
}

export interface ResumeProjectCard {
  title: string;
  summary: string;
  bullets: string[];
  stack?: string;
}

export interface ResumeContactItem {
  title: string;
  body: string;
  href?: string;
  /** 链接可见文案；不填时外链仍展示 URL，站内链用标题去括号后缀 */
  linkText?: string;
}

export interface ResumeDoc {
  pdfLabel: string;
  pdfHref: string | null;
  heroEyebrow: string;
  sectionNav: Array<{ id: ResumeTemplateSectionId; label: string }>;
  name: string;
  role: string;
  tagline: string;
  heroActions: ResumeHeroAction[];

  aboutTitle: string;
  aboutLead: string;
  aboutParagraphs: string[];
  aboutHighlights: ResumeHighlight[];

  resumeBlockTitle: string;
  educationTitle: string;
  educationRows: ResumeTimelineRow[];
  workTitle: string;
  workRows: ResumeTimelineRow[];
  skillsBarsHeading: string;
  skillsBarsLead: string;
  skillBarGroups: ResumeSkillBarGroup[];

  portfolioTitle: string;
  portfolioLead: string;
  projects: ResumeProjectCard[];

  contactTitle: string;
  contactItems: ResumeContactItem[];

  /** 页脚致谢；不填则不展示（MIT 归属见组件 NOTICE 与源码注释） */
  templateCredit?: string;
}

export const resumeDocByLocale: LocalizedValue<ResumeDoc> = {
  zh: {
    pdfLabel: "PDF 履历",
    pdfHref: null,
    heroEyebrow: "项目履历",
    sectionNav: [
      { id: "about", label: "简介" },
      { id: "resume", label: "履历" },
      { id: "portfolio", label: "项目" },
      { id: "contact", label: "联系" },
    ],
    name: "EvoFlow",
    role: "超级 Agent 驾驭框架",
    tagline:
      "编排子 Agent、DAG 汇合、记忆与上下文治理、沙箱执行与 Skills/MCP 集成——面向工单、运维、Copilot 与企业 RAG 等可观测交付。",
    heroActions: [
      { href: "/#capabilities", text: "能力矩阵", primary: true },
      { href: "/evolution", text: "演进日志" },
      { href: siteLinks.github, text: "GitHub" },
    ],
    aboutTitle: "关于",
    aboutLead:
      "EvoFlow 把「多智能体、记忆、沙箱、技能、业务集成」放到同一条可观测链路上：编排层输出结构化子任务与轨迹，执行层约束工具与脚本，记忆层绑定工单与知识句柄，集成层通过 MCP/HTTP 对接存量系统。项目在 DeerFlow 2.0 工程基线上持续演进，目标是把严肃场景跑稳、跑可审计。",
    aboutParagraphs: [
      "持续补齐 EvoPanel 桌面体验、任务调度、护栏与 MCP / Skills 生态，方便在约束清晰的环境里交付 Agent 系统。",
      "典型业务操作包括：跨系统工单与自动化运维、带工具轨迹的内部 Copilot、需要引用溯源的 RAG/知识问答、以及多步骤审批或调研类长任务。",
    ],
    aboutHighlights: [
      { label: "编排面", text: "Plan · DAG · 子 Agent 委派 / 汇合 · 可回放轨迹" },
      { label: "集成面", text: "Skills · MCP · HTTP / 业务 API · 可插拔工具" },
      { label: "GitHub", text: "Issue、发行说明见顶栏「GitHub」入口" },
    ],
    resumeBlockTitle: "履历与技能",
    educationTitle: "路线图",
    educationRows: [
      {
        title: "工程起点",
        location: "里程碑",
        date: "2024 —",
        detail: "确立多包工程结构、官网叙事与能力矩阵，并打通编排 / 沙箱 / 记忆 / 技能的分层边界。",
      },
      {
        title: "编排深化",
        location: "里程碑",
        date: "2025 —",
        detail: "强化多智能体编排、任务链路与桌面端 EvoPanel，完善技能与 MCP 接入体验。",
      },
      {
        title: "持续迭代",
        location: "里程碑",
        date: "进行中",
        detail: "以真实场景驱动护栏、观测与文档；欢迎 PR 与场景反馈。",
      },
    ],
    workTitle: "核心模块",
    workRows: [
      {
        title: "EvoFlow Core",
        location: "运行时",
        date: "Python · TypeScript · Agent runtime",
        detail:
          "编排核心：任务分解、DAG 分支汇合、子 Agent 委派与人工接管点；观测、存储与执行器边界清晰，可按环境替换实现而不改写业务编排语义。",
      },
      {
        title: "EvoPanel",
        location: "桌面端",
        date: "Tauri · React · TypeScript",
        detail:
          "本地开发与调试入口：与网关、任务 API、技能清单对齐；支持护栏开关、模拟 MCP 延迟与轨迹回放，缩短「写技能—看轨迹—改策略」反馈环。",
      },
      {
        title: "Skills 生态",
        location: "扩展",
        date: "MCP · Skills · Extensions",
        detail:
          "技能发现、版本、依赖与发布流水线；把内部 HTTP、数据库只读、脚本与消息渠道封装为可复用单元，并把授权面接到租户与角色模型上。",
      },
    ],
    skillsBarsHeading: "技能快照",
    skillsBarsLead: "以下为能力侧重示意（非考试打分），可按团队方向在 content 中自行调整。",
    skillBarGroups: [
      {
        name: "Agent / 编排",
        skills: [
          { name: "多智能体编排与任务边界", level: 9, max: 10 },
          { name: "Plan / 工具链路与兜底", level: 8, max: 10 },
          { name: "运行观测与排障", level: 8, max: 10 },
        ],
      },
      {
        name: "工程栈",
        skills: [
          { name: "TypeScript / 前端工具链", level: 9, max: 10 },
          { name: "Python / 服务与 Worker", level: 9, max: 10 },
          { name: "容器化与交付", level: 7, max: 10 },
        ],
      },
      {
        name: "集成",
        skills: [
          { name: "MCP / 工具接入", level: 8, max: 10 },
          { name: "Skills 扩展模型", level: 8, max: 10 },
        ],
      },
    ],
    portfolioTitle: "作品与模块",
    portfolioLead: "与首页能力矩阵呼应的核心交付单元：从运行时到桌面与扩展生态。",
    projects: [
      {
        title: "EvoFlow Core",
        summary: "运行时与编排核心：连接模型、工具与企业侧工作流。",
        bullets: [
          "任务分解与子 Agent 协作语义",
          "与观测、存储、执行器的接口边界清晰，便于替换实现",
        ],
        stack: "Python · TypeScript · Agent runtime",
      },
      {
        title: "EvoPanel",
        summary: "桌面端入口：把编排与调试体验带到本地开发环境。",
        bullets: ["贴近日常开发的交互与排障路径", "与网关 / 任务 API 协作的可视化面板"],
        stack: "Tauri · React · TypeScript",
      },
      {
        title: "Skills 生态",
        summary: "可扩展技能与 MCP：统一外部系统接入面。",
        bullets: [
          "技能发现、版本与依赖约束的可扩展模型",
          "面向团队内部的工具接入与安全策略挂钩点",
        ],
        stack: "MCP · Skills · Extensions",
      },
    ],
    contactTitle: "联系与仓库",
    contactItems: [
      {
        title: "能力矩阵（站内）",
        body: "一屏对齐编排、沙箱、记忆、Skills、MCP 与 EvoPanel 的职责边界。",
        href: "/#capabilities",
        linkText: "打开能力矩阵",
      },
      {
        title: "演进日志（站内）",
        body: "版本节点与里程碑，便于对齐交付节奏与能力生长。",
        href: "/evolution",
        linkText: "打开演进日志",
      },
      {
        title: "GitHub 仓库",
        body: "需要 Issue、讨论区或发行说明时，从仓库入口进入。",
        href: siteLinks.github,
        linkText: "在 GitHub 打开仓库",
      },
    ],
  },
  en: {
    pdfLabel: "PDF portfolio",
    pdfHref: null,
    heroEyebrow: "Project portfolio",
    sectionNav: [
      { id: "about", label: "About" },
      { id: "resume", label: "Resume" },
      { id: "portfolio", label: "Portfolio" },
      { id: "contact", label: "Contact" },
    ],
    name: "EvoFlow",
    role: "Super-agent orchestration framework",
    tagline:
      "Coordinate sub-agents, DAG merges, memory and context, sandboxed execution, and Skills/MCP integrations—observable delivery for tickets, ops, copilots, and enterprise RAG.",
    heroActions: [
      { href: "/#capabilities", text: "Capabilities", primary: true },
      { href: "/evolution", text: "Evolution log" },
      { href: siteLinks.github, text: "Source & collab" },
    ],
    aboutTitle: "About",
    aboutLead:
      "EvoFlow keeps orchestration, memory, sandboxing, integrations, and skills on one observable pipeline: planning emits structured tasks and traces, execution constrains tools and scripts, memory binds tickets and knowledge handles, and MCP/HTTP skills attach legacy systems. Built on DeerFlow 2.0 with EvoPanel, scheduling, guardrails, and telemetry aimed at serious, auditable deployments.",
    aboutParagraphs: [
      "Typical business operations: cross-system tickets and ops automation, internal copilots with tool traces, RAG/knowledge Q&A with citations, and long-running research or approval flows.",
    ],
    aboutHighlights: [
      { label: "Orchestration", text: "Plan · DAG · delegate/merge · replayable traces" },
      { label: "Integration", text: "Skills · MCP · HTTP / business APIs · pluggable tools" },
      { label: "GitHub", text: "Issues and releases via the header GitHub entry" },
    ],
    resumeBlockTitle: "Resume & skills",
    educationTitle: "Roadmap",
    educationRows: [
      {
        title: "Foundation",
        location: "Milestone",
        date: "2024 —",
        detail: "Multi-package layout, marketing narrative, and clear seams across orchestration, sandbox, memory, and skills.",
      },
      {
        title: "Orchestration depth",
        location: "Milestone",
        date: "2025 —",
        detail: "Stronger multi-agent orchestration, job flows, EvoPanel, and MCP/skills onboarding.",
      },
      {
        title: "Continuous iteration",
        location: "Milestone",
        date: "Ongoing",
        detail: "Guardrails, telemetry, and docs driven by real deployments—PRs and scenario feedback welcome.",
      },
    ],
    workTitle: "Core modules",
    workRows: [
      {
        title: "EvoFlow Core",
        location: "Runtime",
        date: "Python · TypeScript · Agent runtime",
        detail:
          "Orchestration core: decomposition, DAG branch/merge, delegate semantics, and human takeover seams with clear boundaries for observability, storage, and swappable executors.",
      },
      {
        title: "EvoPanel",
        location: "Desktop",
        date: "Tauri · React · TypeScript",
        detail:
          "Local debugging aligned with gateway and job APIs and skill manifests; guardrail toggles, mocked MCP latency, and trace replay to tighten the skill authoring loop.",
      },
      {
        title: "Skills ecosystem",
        location: "Extensions",
        date: "MCP · Skills · Extensions",
        detail:
          "Discovery, versioning, dependencies, and release workflows packaging internal HTTP, read-only SQL, scripts, and chat channels—authorization mapped to tenant and role models.",
      },
    ],
    skillsBarsHeading: "Skills snapshot",
    skillsBarsLead: "Illustrative emphasis bars for scanning—not exam scores. Tune freely in content.",
    skillBarGroups: [
      {
        name: "Agents / orchestration",
        skills: [
          { name: "Multi-agent orchestration", level: 9, max: 10 },
          { name: "Planning / tool pipelines", level: 8, max: 10 },
          { name: "Runtime observability", level: 8, max: 10 },
        ],
      },
      {
        name: "Engineering",
        skills: [
          { name: "TypeScript / frontend toolchain", level: 9, max: 10 },
          { name: "Python / services & workers", level: 9, max: 10 },
          { name: "Containers & delivery", level: 7, max: 10 },
        ],
      },
      {
        name: "Integrations",
        skills: [
          { name: "MCP / tools", level: 8, max: 10 },
          { name: "Skills extension model", level: 8, max: 10 },
        ],
      },
    ],
    portfolioTitle: "Portfolio",
    portfolioLead: "Highlights aligned with the homepage capability story—from runtime to desktop and extensions.",
    projects: [
      {
        title: "EvoFlow Core",
        summary: "Runtime and orchestration core connecting models, tools, and enterprise workflows.",
        bullets: [
          "Task decomposition and sub-agent collaboration semantics",
          "Clear seams for observability, storage, and executors",
        ],
        stack: "Python · TypeScript · Agent runtime",
      },
      {
        title: "EvoPanel",
        summary: "Desktop surface for local debugging and day-to-day operator workflows.",
        bullets: [
          "Developer-friendly navigation and troubleshooting paths",
          "Visual panels coordinated with gateway/task APIs",
        ],
        stack: "Tauri · React · TypeScript",
      },
      {
        title: "Skills ecosystem",
        summary: "Extensible skills plus MCP as the integration plane for external systems.",
        bullets: [
          "Discovery, versioning, and dependency constraints for skills",
          "Hook points for internal tooling and security policy",
        ],
        stack: "MCP · Skills · Extensions",
      },
    ],
    contactTitle: "Where to go next",
    contactItems: [
      {
        title: "Capability matrix (on-site)",
        body: "One screen for orchestration, sandbox, memory, Skills, MCP, and EvoPanel.",
        href: "/#capabilities",
        linkText: "Open capability matrix",
      },
      {
        title: "Evolution log (on-site)",
        body: "Milestones and releases to align delivery expectations.",
        href: "/evolution",
        linkText: "Open evolution log",
      },
      {
        title: "Source & collaboration",
        body: "Issues, discussions, and release notes from the repository entry.",
        href: siteLinks.github,
        linkText: "Open repository on GitHub",
      },
    ],
  },
};
