import {
  defaultLocale,
  type LocalizedValue,
  type SiteLocale,
} from "./locales";
import { siteLinks } from "./site-links";

export type HomeLandingCopy = {
  meta: { title: string; description: string };
  hero: {
    titleBefore: string;
    titleAccent: string;
    titleAfter: string;
    subtitle: string;
    primaryCta: { label: string; href: string };
    secondaryCta: { label: string; href: string };
  };
  showcase: {
    title: string;
    items: Array<{ title: string; blurb: string }>;
  };
  products: {
    heading: string;
    items: Array<{
      title: string;
      desc: string;
      detail: string;
      ctaLabel: string;
      ctaHref: string;
      visual: "employees" | "plan";
    }>;
  };
  audience: {
    heading: string;
    tabs: Array<{
      name: string;
      title: string;
      subtitle: string;
      ctaLabel: string;
      ctaHref: string;
    }>;
  };
  testimonials: {
    heading: string;
    items: Array<{ quote: string; name: string; role: string }>;
  };
  faq: {
    heading: string;
    items: Array<{ q: string; a: string }>;
  };
  cta: {
    title: string;
    buttonLabel: string;
    buttonHref: string;
  };
};

export const homeLandingByLocale: LocalizedValue<HomeLandingCopy> = {
  zh: {
    meta: {
      title: "EvoFlow | 智能体员工与超级 Agent 编排",
      description:
        "把 AI 雇成岗位同事：自动上班、写工作汇报；Skills / MCP / Plan 编排一站式落地。",
    },
    hero: {
      titleBefore: "EvoFlow，",
      titleAccent: "智能体员工",
      titleAfter: "与超级 Agent",
      subtitle: "从岗位雇佣到长任务编排，一站式解决 AI 落地难题",
      primaryCta: { label: "下载桌面端", href: siteLinks.blog },
      secondaryCta: { label: "了解智能体员工", href: "/employees" },
    },
    showcase: {
      title: "一键生成 可验收的交付物",
      items: [
        { title: "工作汇报", blurb: "员工到点干活，写清做了什么" },
        { title: "Plan 计划", blurb: "先规划再授权，全程可追溯" },
        { title: "媒体成片", blurb: "脚本到关键帧到成片一条链" },
      ],
    },
    products: {
      heading: "发现你的落地路径",
      items: [
        {
          title: "智能体员工",
          desc: "按岗位自动上班，干完写工作汇报",
          detail:
            "不是聊天机器人待命，而是有岗位名、职责与上班频率的同事。适合独立开发者与小团队先跑通单岗，再长成组织树。",
          ctaLabel: "立即了解",
          ctaHref: "/employees",
          visual: "employees",
        },
        {
          title: "Plan 与编排",
          desc: "长任务先计划、再确认、后执行",
          detail:
            "控制面看清谁在干活；Plan 模式把目标拆成可验收步骤。子智能体、记忆与沙箱执行在同一条可观测管线上。",
          ctaLabel: "阅读文档",
          ctaHref: "/docs",
          visual: "plan",
        },
      ],
    },
    audience: {
      heading: "适用人群",
      tabs: [
        {
          name: "独立开发者",
          title: "一个人也能先雇一个岗",
          subtitle: "模板预填职责 · 自动上班 · 工作汇报可回看",
          ctaLabel: "免费下载",
          ctaHref: siteLinks.blog,
        },
        {
          name: "小团队",
          title: "组织树 + 同意派发",
          subtitle: "上下级交工、卡住有诊断条、人效看得见",
          ctaLabel: "看员工文档",
          ctaHref: "/docs/employees/overview",
        },
        {
          name: "内容 / 增长",
          title: "选题到成片一条技能链",
          subtitle: "content-hunter → writer → hyperframes",
          ctaLabel: "看演示",
          ctaHref: "/showcase/",
        },
        {
          name: "工程团队",
          title: "Plan → 实现 → 评审",
          subtitle: "superpowers 技能链保持可验收节奏",
          ctaLabel: "打开 GitHub",
          ctaHref: siteLinks.github,
        },
        {
          name: "企业 IT",
          title: "沙箱、记忆与审计钩子",
          subtitle: "工单 / 运维 / Copilot / RAG 可观测交付",
          ctaLabel: "能力矩阵",
          ctaHref: "/#products",
        },
        {
          name: "创作者",
          title: "桌面端本地跑通再发布",
          subtitle: "发行版下载 · 文档教程 · 开源仓库",
          ctaLabel: "下载桌面端",
          ctaHref: siteLinks.blog,
        },
      ],
    },
    testimonials: {
      heading: "建造者的真实用法",
      items: [
        {
          quote:
            "先雇一个运维值班岗，每晚自动探活写汇报。卡住时诊断条直接告诉我下一步，比自己盯日志省心太多。",
          name: "阿哲",
          role: "独立全栈 · 侧车项目维护者",
        },
        {
          quote:
            "Plan 模式把需求拆成可勾选步骤，再派给研发助理。评审技能链一接上，交付节奏明显稳了。",
          name: "Mina",
          role: "小团队 Tech Lead",
        },
        {
          quote:
            "用 Skills 把选题、口播和成片串起来。本地桌面端跑通后再发，素材复用和关键帧质量都在可控范围。",
          name: "小周",
          role: "内容增长 · 短视频编导",
        },
        {
          quote:
            "我们要的是可审计的 Agent 管线，不是一次性聊天 Demo。EvoFlow 的记忆、沙箱和员工汇报刚好对齐。",
          name: "Hao",
          role: "企业 AI 平台工程师",
        },
      ],
    },
    faq: {
      heading: "常见问题解答",
      items: [
        {
          q: "EvoFlow 能帮我做什么？",
          a: "雇佣智能体员工按岗位自动上班并写工作汇报；用 Skills 扩展研究/媒体/桌面能力；用 Plan 与子智能体编排把长任务跑成可验收交付。",
        },
        {
          q: "如何开始使用？",
          a: "下载桌面端发行版 → 配置模型 → 在「智能体员工」里选模板雇佣，或在对话中直接下任务。详细步骤见文档「快速开始」。",
        },
        {
          q: "和普通 Chat UI 有什么区别？",
          a: "员工有岗位、频率与汇报；Skills 是可插拔能力包；Plan 模式强调先规划再执行。目标是把 AI 管成同事与流水线，而不只是一次对话。",
        },
        {
          q: "数据与代码会上传吗？",
          a: "桌面端默认在本机运行。是否调用云端模型 API 取决于你配置的供应商；工作区与沙箱策略可在设置中调整。",
        },
        {
          q: "Skills 与智能体员工怎么选？",
          a: "要 7×24 值班与汇报 → 员工；要给现有 Agent 加专项本事 → Skills。两者可叠加：员工角色也可以绑定 Skills。",
        },
      ],
    },
    cta: {
      title: "立即下载，开启智能体员工之旅",
      buttonLabel: "下载桌面端",
      buttonHref: siteLinks.blog,
    },
  },
  en: {
    meta: {
      title: "EvoFlow | Smart Employees & Super-agent Orchestration",
      description:
        "Hire AI into real roles that work on a schedule and leave reports—plus Skills, MCP, and Plan orchestration.",
    },
    hero: {
      titleBefore: "EvoFlow — ",
      titleAccent: "Smart Employees",
      titleAfter: " & super agents",
      subtitle: "From hiring roles to long-run orchestration—one place to ship AI work",
      primaryCta: { label: "Download desktop", href: siteLinks.blog },
      secondaryCta: { label: "Smart Employees", href: "/employees" },
    },
    showcase: {
      title: "Ship reviewable artifacts in one flow",
      items: [
        { title: "Work reports", blurb: "Roles work on cadence and write what they did" },
        { title: "Plan", blurb: "Plan → confirm → execute with a full trail" },
        { title: "Media cuts", blurb: "Script → keyframes → final cut" },
      ],
    },
    products: {
      heading: "Find your path to production",
      items: [
        {
          title: "Smart Employees",
          desc: "On-duty roles with schedules and written reports",
          detail:
            "Not a chatbot on standby—teammates with a job title, duties, and cadence. Start with one role, then grow the org tree.",
          ctaLabel: "Learn more",
          ctaHref: "/employees",
          visual: "employees",
        },
        {
          title: "Plan & orchestration",
          desc: "Plan first, authorize, then execute",
          detail:
            "See who is working on the control plane. Plan mode splits goals into reviewable steps. Sub-agents, memory, and sandbox share one observable pipeline.",
          ctaLabel: "Read the docs",
          ctaHref: "/docs",
          visual: "plan",
        },
      ],
    },
    audience: {
      heading: "Who it’s for",
      tabs: [
        {
          name: "Indie hackers",
          title: "Start with one role",
          subtitle: "Templates · auto-work · readable reports",
          ctaLabel: "Download",
          ctaHref: siteLinks.blog,
        },
        {
          name: "Small teams",
          title: "Org tree + approve dispatch",
          subtitle: "Handoffs, diagnosis chips, visible throughput",
          ctaLabel: "Employee docs",
          ctaHref: "/docs/employees/overview",
        },
        {
          name: "Content / growth",
          title: "Topic → script → cut",
          subtitle: "content-hunter → writer → hyperframes",
          ctaLabel: "Showcase",
          ctaHref: "/showcase/",
        },
        {
          name: "Engineering",
          title: "Plan → build → review",
          subtitle: "superpowers skill chains keep cadence",
          ctaLabel: "GitHub",
          ctaHref: siteLinks.github,
        },
        {
          name: "Enterprise IT",
          title: "Sandbox, memory, audit hooks",
          subtitle: "Tickets / ops / copilots / RAG you can observe",
          ctaLabel: "Capabilities",
          ctaHref: "/#products",
        },
        {
          name: "Creators",
          title: "Run local, then publish",
          subtitle: "Desktop builds · docs · open source",
          ctaLabel: "Get the app",
          ctaHref: siteLinks.blog,
        },
      ],
    },
    testimonials: {
      heading: "How builders use it",
      items: [
        {
          quote:
            "I hired an ops on-call role that probes nightly and leaves a report. Diagnosis chips tell me the next step when it’s stuck—far less log babysitting.",
          name: "Zhe",
          role: "Indie full-stack",
        },
        {
          quote:
            "Plan mode turns asks into checkable steps, then a dev assistant executes. Wiring review skills made delivery much steadier.",
          name: "Mina",
          role: "Small-team tech lead",
        },
        {
          quote:
            "Skills chain topics, voiceover, and cuts. Running on the desktop keeps assets and keyframes under control before we publish.",
          name: "Zhou",
          role: "Short-form editor",
        },
        {
          quote:
            "We needed an auditable agent pipeline, not a one-off chat demo. Memory, sandbox, and employee reports line up with that.",
          name: "Hao",
          role: "Enterprise AI platform",
        },
      ],
    },
    faq: {
      heading: "FAQ",
      items: [
        {
          q: "What can EvoFlow do?",
          a: "Hire Smart Employees that work on a schedule and write reports; extend agents with Skills; run long jobs via Plan and sub-agents into reviewable delivery.",
        },
        {
          q: "How do I start?",
          a: "Download a desktop release → configure a model → hire from an employee template, or just chat a goal. See Getting started in the docs.",
        },
        {
          q: "How is this different from a chat UI?",
          a: "Employees have roles, cadence, and reports. Skills are pluggable packs. Plan mode plans before execute. The point is managing AI as teammates and pipelines.",
        },
        {
          q: "Does my data leave the machine?",
          a: "Desktop runs locally by default. Cloud model calls depend on the provider you configure; workspace and sandbox policy live in settings.",
        },
        {
          q: "Smart Employees or Skills?",
          a: "Need 24/7 duty and reports → Employees. Need to add capabilities to an agent → Skills. You can bind Skills onto employee roles.",
        },
      ],
    },
    cta: {
      title: "Download and hire your first Smart Employee",
      buttonLabel: "Download desktop",
      buttonHref: siteLinks.blog,
    },
  },
};

export function getHomeLanding(locale: SiteLocale = defaultLocale) {
  return homeLandingByLocale[locale] ?? homeLandingByLocale[defaultLocale];
}
