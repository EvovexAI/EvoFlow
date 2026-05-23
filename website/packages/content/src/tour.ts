import { defaultLocale, type LocalizedValue, type SiteLocale } from "./locales";

export interface GuidedTourStep {
  description: string;
  id:
    | "hero"
    | "capabilities"
    | "scenarios"
    | "evolution-pulse"
    | "portals";
  targetId: string;
  title: string;
}

export interface GuidedTourContent {
  floating: {
    label: string;
    title: string;
  };
  revisit: {
    continueLabel: string;
    description: string;
    exploreLabel: string;
    eyebrow: string;
    restartLabel: string;
    title: string;
  };
  steps: GuidedTourStep[];
  tour: {
    closeLabel: string;
    doneLabel: string;
    eyebrow: string;
    nextLabel: string;
    previousLabel: string;
    progressLabel: string;
    skipLabel: string;
  };
  welcome: {
    description: string;
    exploreLabel: string;
    eyebrow: string;
    title: string;
    tourLabel: string;
  };
}

export const guidedTourContentByLocale: LocalizedValue<GuidedTourContent> = {
  zh: {
    floating: {
      label: "导览",
      title: "站点导览",
    },
    revisit: {
      continueLabel: "继续导览",
      description: "上次你停在某一步。要从那里继续，还是从头开始？",
      exploreLabel: "我自己浏览",
      eyebrow: "欢迎回来",
      restartLabel: "从头开始",
      title: "继续浏览 EvoFlow 官网",
    },
    steps: [
      {
        description:
          "首屏说明 EvoFlow 的定位：多智能体编排、沙箱执行、记忆与 Skills/MCP 集成，以及 EvoPanel 交付面；副卡补充当前工程重心与适合的业务类型。",
        id: "hero",
        targetId: "hero",
        title: "从 Hero 了解产品与边界",
      },
      {
        description:
          "能力矩阵把编排、沙箱、记忆、技能、MCP 与桌面端拆成可读模块，便于架构评审时对照「谁负责规划、谁负责执行、状态放哪」。",
        id: "capabilities",
        targetId: "capabilities",
        title: "阅读能力矩阵",
      },
      {
        description:
          "典型场景用「痛点—链路—可观测结果」写法，覆盖工单协同、运维、内部 Copilot 与企业 RAG 等常见落地路径。",
        id: "scenarios",
        targetId: "scenarios",
        title: "对照典型场景",
      },
      {
        description:
          "路线图脉冲概括基线、生态、产品、工程治理与文档建设的里程碑；详细时间线可跳转到演进日志页。",
        id: "evolution-pulse",
        targetId: "evolution-pulse",
        title: "浏览路线图脉冲",
      },
      {
        description: "首页正文在此收尾；Issue、讨论区与版本发布仍可通过顶栏「GitHub」进入。",
        id: "portals",
        targetId: "portals",
        title: "致谢与后续入口",
      },
    ],
    tour: {
      closeLabel: "关闭",
      doneLabel: "完成",
      eyebrow: "站点导览",
      nextLabel: "下一步",
      previousLabel: "上一步",
      progressLabel: "步骤",
      skipLabel: "先到这里",
    },
    welcome: {
      description: "约一分钟浏览首页的主线：能力矩阵、典型场景与路线图。",
      exploreLabel: "我自己看看",
      eyebrow: "欢迎",
      title: "快速了解 EvoFlow 官网结构",
      tourLabel: "开始导览",
    },
  },
  en: {
    floating: {
      label: "Tour",
      title: "Site tour",
    },
    revisit: {
      continueLabel: "Continue tour",
      description: "You stopped partway last time. Resume from there or restart from the top?",
      exploreLabel: "I'll browse on my own",
      eyebrow: "Welcome back",
      restartLabel: "Restart tour",
      title: "Continue exploring the EvoFlow site",
    },
    steps: [
      {
        description:
          "The hero states positioning: multi-agent orchestration, sandboxed execution, memory, Skills and MCP integrations, plus EvoPanel for delivery—side cards spell current engineering focus and fit.",
        id: "hero",
        targetId: "hero",
        title: "Start with the hero narrative",
      },
      {
        description:
          "The capability matrix splits orchestration, sandbox, memory, skills, MCP, and desktop responsibilities—handy when mapping who plans, who executes, and where durable state lives.",
        id: "capabilities",
        targetId: "capabilities",
        title: "Read the capability matrix",
      },
      {
        description:
          "Scenarios spell pain → wired flow → observability outcomes for tickets, ops, grounded copilots, and enterprise RAG—material you can reuse in reviews or RFPs.",
        id: "scenarios",
        targetId: "scenarios",
        title: "Scan concrete scenarios",
      },
      {
        description:
          "The roadmap pulse summarizes baseline, ecosystem, product, engineering guardrails, and documentation milestones; the full log lives on the Evolution page.",
        id: "evolution-pulse",
        targetId: "evolution-pulse",
        title: "Skim the roadmap pulse",
      },
      {
        description:
          "The narrative wraps here; issues, discussions, and releases remain one click away under GitHub in the header.",
        id: "portals",
        targetId: "portals",
        title: "Thanks and next steps",
      },
    ],
    tour: {
      closeLabel: "Close",
      doneLabel: "Finish",
      eyebrow: "Site tour",
      nextLabel: "Next",
      previousLabel: "Back",
      progressLabel: "Step",
      skipLabel: "Pause here",
    },
    welcome: {
      description:
        "About a minute across capabilities, scenarios, and the roadmap pulse.",
      exploreLabel: "I'll browse on my own",
      eyebrow: "Welcome",
      title: "Quick orientation for the EvoFlow marketing site",
      tourLabel: "Start tour",
    },
  },
};

export const guidedTourContent = guidedTourContentByLocale[defaultLocale];

export function getGuidedTourContent(locale: SiteLocale) {
  return guidedTourContentByLocale[locale];
}
