import {
  defaultLocale,
  type LocalizedValue,
  type SiteLocale,
} from "./locales";
import { siteLinks } from "./site-links";

export type SkillsPageCopy = {
  meta: { title: string; description: string };
  hero: {
    badge: string;
    titleLine1: string;
    titleLine2: string;
    lead: string;
    guideCta: { label: string; href: string };
    installCta: { label: string; href: string };
  };
  agents: {
    heading: string;
    items: Array<{ name: string; color: string; initial: string }>;
  };
  quickStart: {
    heading: string;
    prereqLabel: string;
    prerequisites: Array<{ text: string; linkLabel?: string; linkHref?: string }>;
    steps: Array<{
      title: string;
      subtitle: string;
      panelStep: string;
      panelTitle: string;
      panelBody: string;
      options?: Array<{
        label: string;
        body: string;
        prompt?: string;
        hint?: string;
      }>;
      bullets?: string[];
    }>;
    copyLabel: string;
    copiedLabel: string;
  };
  scenarios: {
    heading: string;
    lead: string;
    promptLabel: string;
    items: Array<{
      title: string;
      body: string;
      prompt: string;
      icon: "research" | "code" | "media" | "content" | "desktop" | "knowledge";
    }>;
  };
  capabilities: {
    heading: string;
    lead: string;
    columns: [string, string, string];
    rows: Array<[string, string, string]>;
  };
  faq: {
    heading: string;
    lead: string;
    items: Array<{
      question: string;
      answer: string | string[];
    }>;
  };
  community: {
    heading: string;
    lead: string;
    ctaLabel: string;
    ctaHref: string;
  };
};

export const skillsPageByLocale: LocalizedValue<SkillsPageCopy> = {
  zh: {
    meta: {
      title: "EvoFlow Skills",
      description:
        "把可复用职业能力包装进 Agent：深度研究、媒体生产、桌面操控、知识库与开发流程。支持 EvoFlow 桌面端、SkillHub 与主流 AI Agent。",
    },
    hero: {
      badge: "EvoFlow Skills × AI Agent",
      titleLine1: "让你的 Agent",
      titleLine2: "装上可复用职业能力包",
      lead: "用自然语言触发技能：覆盖深度研究、媒体成片、桌面操控、知识库、开发协作与内容运营。",
      guideCta: { label: "使用指南", href: "/docs/ext/skills" },
      installCta: { label: "立即安装", href: "#start" },
    },
    agents: {
      heading: "支持所有主流 AI Agent 工具",
      items: [
        { name: "EvoFlow", color: "#111827", initial: "EF" },
        { name: "Claude Code", color: "#D97706", initial: "CC" },
        { name: "Codex", color: "#2563EB", initial: "CX" },
        { name: "OpenClaw", color: "#DC2626", initial: "OC" },
        { name: "SkillHub", color: "#059669", initial: "SH" },
      ],
    },
    quickStart: {
      heading: "快速开始：3 步安装配置",
      prereqLabel: "前置条件",
      prerequisites: [
        {
          text: "已安装可用 AI Agent，如 EvoFlow 桌面端、Claude Code、Codex、OpenClaw 等。",
        },
        {
          text: "了解 Skill 是文件夹 + SKILL.md 的标准打包形式；可从内置目录、SkillHub 或本地 zip 安装。详见",
          linkLabel: "技能管理文档",
          linkHref: "/docs/ext/skills",
        },
        {
          text: "在「智能体管理」中为角色勾选技能后，对话里即可按需触发。",
        },
      ],
      steps: [
        {
          title: "安装 Skill",
          subtitle: "市场 / 本地 / Git",
          panelStep: "STEP 1 · 安装 EvoFlow Skill",
          panelTitle: "把技能装进你的 Agent",
          panelBody:
            "在 EvoFlow 侧栏「技能」里搜索安装，或导入本地 zip / Git 仓库；也可复制安装 Prompt 发给支持 Skill 的 AI Agent。",
          options: [
            {
              label: "EvoFlow 应用内安装",
              body: "打开桌面端 → 智能体 → 技能 → 市场 / 导入本地技能。内置 50+ 公开技能开箱可用。",
              hint: "推荐：安装后默认可在角色白名单中勾选启用。",
            },
            {
              label: "Agent 自动安装",
              body: "把下方 Prompt 发给 Claude Code / Codex / OpenClaw 等，让 Agent 按文档拉取并部署 Skill。",
              prompt:
                "帮我安装 EvoFlow 技能：参考 https://github.com/EvovexAI/EvoFlow/tree/main/skills/public ，按 SKILL.md 规范部署到本地 skills 目录并验证可被 Agent 加载。",
              hint: "推荐使用该方式。Agent 会按说明完成下载与部署，无需手动挪文件。",
            },
          ],
        },
        {
          title: "绑定到角色",
          subtitle: "勾选技能白名单",
          panelStep: "STEP 2 · 给智能体开通技能",
          panelTitle: "在角色配置里勾选要用的技能",
          panelBody:
            "技能安装后默认全局可用；若角色有白名单，需在「智能体管理」中勾选对应技能，对话时才会注入。",
          bullets: [
            "侧栏进入智能体 / 预设角色",
            "编辑角色 → 勾选 Skills",
            "保存后新开对话验证触发",
          ],
        },
        {
          title: "对话触发验证",
          subtitle: "用 Prompt 验收",
          panelStep: "STEP 3 · 验证连通",
          panelTitle: "用一句自然语言确认技能生效",
          panelBody:
            "在对话里描述目标任务；Agent 应自动选用已绑定技能。也可在作曲器技能选择器中手动指定。",
          bullets: [
            "示例：「用深度研究技能对比三家竞品定价并输出表格」",
            "示例：「用 hyperframes 技能把这段脚本做成 15 秒成片」",
            "失败时检查：技能是否启用、角色是否勾选、模型是否支持工具调用",
          ],
        },
      ],
      copyLabel: "复制命令",
      copiedLabel: "已复制",
    },
    scenarios: {
      heading: "六大典型使用场景",
      lead: "把技能交给 Agent，完成研究复盘、代码协作、媒体成片、内容运营、桌面自动化与知识检索。",
      promptLabel: "Prompt",
      items: [
        {
          icon: "research",
          title: "深度研究复盘",
          body: "研究员与产品可让 Agent 联网检索、多来源对比，输出结构化报告与引用。",
          prompt:
            "用深度研究技能调研「企业级 Agent 平台」近 90 天动态，输出竞品表、定价带与关键能力对比",
        },
        {
          icon: "code",
          title: "仓库协作与评审",
          body: "开发可让 Agent 走计划→实现→评审技能链，保持可验收的工程节奏。",
          prompt:
            "按 superpowers 流程：先写实现计划，再分技能执行，最后发起 code review 清单",
        },
        {
          icon: "media",
          title: "短视频 / 动画成片",
          body: "内容与增长可让 Agent 用 HyperFrames 等技能从脚本到关键帧再到成片。",
          prompt:
            "用 hyperframes 技能把产品发布稿做成 20 秒竖版动画，含字幕与转场",
        },
        {
          icon: "content",
          title: "新媒体选题与文案",
          body: "运营可让 Agent 抓热点、写多平台文案，并按账号人设去 AI 味润色。",
          prompt:
            "用 content-hunter + content-writer：本周 AI 工具赛道出 5 个选题，并写一条抖音口播稿",
        },
        {
          icon: "desktop",
          title: "桌面 / 浏览器自动化",
          body: "运营与助理可让 Agent 操控桌面应用或浏览器，完成重复点击与填表。",
          prompt:
            "用 desktop-control / agent-browser：打开后台导出昨日订单 CSV 并放到工作区",
        },
        {
          icon: "knowledge",
          title: "知识库问答交付",
          body: "团队可让 Agent 绑定知识库技能，按库内文档回答并附带来源。",
          prompt:
            "用 knowledge-vault 查询「智能体员工排障」文档，给出卡住时的诊断步骤清单",
        },
      ],
    },
    capabilities: {
      heading: "核心能力地图",
      lead: "EvoFlow Skills 覆盖研究、开发、媒体、内容、自动化与平台治理等模块",
      columns: ["能力模块", "包含能力", "典型技能"],
      rows: [
        [
          "深度研究",
          "联网检索、多源对比、结构化报告、GitHub 深挖",
          "deep-research / github-deep-research",
        ],
        [
          "开发协作",
          "计划、并行子智能体、TDD、评审、worktree",
          "superpowers-* / coding-agent",
        ],
        [
          "媒体成片",
          "脚本、分镜、动画、字幕、口播、素材复用",
          "hyperframes / media-use / podcast",
        ],
        [
          "内容运营",
          "选题、文案、社媒优化、去 AI 味、公众号",
          "content-hunter / content-writer",
        ],
        [
          "桌面与浏览器",
          "桌面操控、浏览器自动化、安卓 Agent",
          "desktop-control / agent-browser",
        ],
        [
          "文档与数据",
          "PDF/PPT/XLSX、图表、数据分析",
          "pdf / pptx / xlsx / data-analysis",
        ],
        [
          "知识与记忆",
          "知识库检索、Obsidian/Notion 协作",
          "knowledge-vault / obsidian / notion",
        ],
        [
          "平台治理",
          "技能创建与校验、管理员、Plan 工作流",
          "skill-creator / evoflow-admin",
        ],
      ],
    },
    faq: {
      heading: "常见问题",
      lead: "围绕安装失败、角色未勾选、技能未触发和 SkillHub 导入这些高频问题给出处理路径。",
      items: [
        {
          question: "安装后对话里不触发技能？",
          answer: [
            "确认技能在「已安装」列表中为启用状态；",
            "检查当前角色是否勾选了该技能白名单；",
            "新开一轮对话再试，或在作曲器中手动指定技能。",
          ],
        },
        {
          question: "从 SkillHub / zip 导入失败？",
          answer: [
            "确认包内含合法 SKILL.md（含 YAML frontmatter）；",
            "名称需唯一，勿与已有 public/custom 技能冲突；",
            "可改用「导入本地技能」选择解压后的文件夹。",
          ],
        },
        {
          question: "内置技能可以删除吗？",
          answer:
            "skills/public 下的系统技能不可删除，只能全局停用；自定义与 SkillHub 安装的技能可删除。",
        },
        {
          question: "技能如何计费？",
          answer:
            "EvoFlow Skills 本身不按次扣积分；实际费用取决于你配置的大模型 API 与第三方工具（如生图、媒体服务）账单。",
        },
        {
          question: "我该选智能体员工还是 Skills？",
          answer:
            "智能体员工适合 7×24 按岗位自动上班、写工作汇报；Skills 是可插拔能力包，给任意 Agent 增加专项本事。两者可叠加：员工角色也可以绑定 Skills。",
        },
      ],
    },
    community: {
      heading: "继续深入：文档与开源仓库",
      lead: "获取安装支持、技能编写规范，以及后续能力更新。",
      ctaLabel: "打开 GitHub",
      ctaHref: siteLinks.github,
    },
  },
  en: {
    meta: {
      title: "EvoFlow Skills",
      description:
        "Pack reusable job capabilities into agents—research, media, desktop control, knowledge, and engineering workflows. Works with EvoFlow Desktop, SkillHub, and mainstream AI agents.",
    },
    hero: {
      badge: "EvoFlow Skills × AI Agent",
      titleLine1: "Give your Agent",
      titleLine2: "reusable job-ready skills",
      lead: "Trigger skills in natural language across research, media production, desktop control, knowledge, engineering, and content ops.",
      guideCta: { label: "Guide", href: "/docs/ext/skills" },
      installCta: { label: "Install now", href: "#start" },
    },
    agents: {
      heading: "Works with mainstream AI Agent tools",
      items: [
        { name: "EvoFlow", color: "#111827", initial: "EF" },
        { name: "Claude Code", color: "#D97706", initial: "CC" },
        { name: "Codex", color: "#2563EB", initial: "CX" },
        { name: "OpenClaw", color: "#DC2626", initial: "OC" },
        { name: "SkillHub", color: "#059669", initial: "SH" },
      ],
    },
    quickStart: {
      heading: "Quick start: 3-step setup",
      prereqLabel: "Prerequisites",
      prerequisites: [
        {
          text: "An AI Agent is available—EvoFlow Desktop, Claude Code, Codex, OpenClaw, etc.",
        },
        {
          text: "Skills are folders + SKILL.md. Install from bundled catalog, SkillHub, or a local zip. See",
          linkLabel: "Skills docs",
          linkHref: "/docs/ext/skills",
        },
        {
          text: "Enable skills on the role whitelist under Agent management before chatting.",
        },
      ],
      steps: [
        {
          title: "Install a Skill",
          subtitle: "Market / local / Git",
          panelStep: "STEP 1 · Install an EvoFlow Skill",
          panelTitle: "Get the skill into your Agent",
          panelBody:
            "Use EvoFlow’s Skills tab to search/install, import a local zip/Git repo, or paste an install prompt into agents that support Skills.",
          options: [
            {
              label: "Install in EvoFlow",
              body: "Desktop → Agents → Skills → Market / Import local. 50+ public skills ship ready to use.",
              hint: "Recommended: enable on the role whitelist after install.",
            },
            {
              label: "Agent auto-install",
              body: "Send the prompt below to Claude Code / Codex / OpenClaw so the agent fetches and deploys the skill.",
              prompt:
                "Install EvoFlow skills from https://github.com/EvovexAI/EvoFlow/tree/main/skills/public following SKILL.md, place them under the local skills directory, and verify the agent can load them.",
              hint: "Preferred path—the agent handles download and deploy for you.",
            },
          ],
        },
        {
          title: "Bind to a role",
          subtitle: "Whitelist skills",
          panelStep: "STEP 2 · Enable on the agent",
          panelTitle: "Check skills on the role config",
          panelBody:
            "Installed skills are globally available; if a role uses a whitelist, tick the skill under Agent management so chat can inject it.",
          bullets: [
            "Open Agents / preset roles",
            "Edit role → select Skills",
            "Save and start a new chat to verify",
          ],
        },
        {
          title: "Verify in chat",
          subtitle: "Prompt acceptance",
          panelStep: "STEP 3 · Verify",
          panelTitle: "Confirm with one natural-language ask",
          panelBody:
            "Describe the job in chat; the agent should pick bound skills. You can also pin a skill in the composer.",
          bullets: [
            'Example: “Use deep-research to compare three competitors’ pricing in a table”',
            'Example: “Use hyperframes to turn this script into a 15s video”',
            "If it fails: check enabled state, role whitelist, and tool-calling model support",
          ],
        },
      ],
      copyLabel: "Copy",
      copiedLabel: "Copied",
    },
    scenarios: {
      heading: "Six typical scenarios",
      lead: "Hand skills to your agent for research, coding, media, content, desktop automation, and knowledge Q&A.",
      promptLabel: "Prompt",
      items: [
        {
          icon: "research",
          title: "Deep research",
          body: "Let the agent search the web, compare sources, and ship structured reports with citations.",
          prompt:
            "Use deep-research on enterprise agent platforms for the last 90 days—competitors, pricing bands, and key capabilities",
        },
        {
          icon: "code",
          title: "Repo collaboration",
          body: "Run plan → implement → review skill chains for an auditable engineering cadence.",
          prompt:
            "Follow superpowers: write an implementation plan, execute by skill, then produce a code-review checklist",
        },
        {
          icon: "media",
          title: "Short-form / motion video",
          body: "From script to keyframes to final cut with HyperFrames and media skills.",
          prompt:
            "Use hyperframes to turn this launch brief into a 20s vertical animation with captions",
        },
        {
          icon: "content",
          title: "Social content ops",
          body: "Hunt topics, draft multi-platform copy, and de-AI polish to match voice.",
          prompt:
            "With content-hunter + content-writer: 5 AI-tools topics this week plus one Douyin voiceover script",
        },
        {
          icon: "desktop",
          title: "Desktop / browser automation",
          body: "Drive desktop apps or the browser for repetitive clicks and exports.",
          prompt:
            "With desktop-control / agent-browser: export yesterday’s orders CSV into the workspace",
        },
        {
          icon: "knowledge",
          title: "Knowledge Q&A",
          body: "Bind knowledge-vault skills so answers stay grounded in your docs.",
          prompt:
            "Use knowledge-vault on “smart employee troubleshooting” and list diagnosis steps when a role is stuck",
        },
      ],
    },
    capabilities: {
      heading: "Capability map",
      lead: "EvoFlow Skills span research, engineering, media, content, automation, and platform ops",
      columns: ["Module", "Capabilities", "Example skills"],
      rows: [
        [
          "Research",
          "Web search, multi-source compare, structured reports, GitHub deep dives",
          "deep-research / github-deep-research",
        ],
        [
          "Engineering",
          "Plans, parallel sub-agents, TDD, review, worktrees",
          "superpowers-* / coding-agent",
        ],
        [
          "Media",
          "Scripts, storyboards, motion, captions, voiceover, asset reuse",
          "hyperframes / media-use / podcast",
        ],
        [
          "Content",
          "Topics, copy, social optimize, de-AI polish, WeChat MP",
          "content-hunter / content-writer",
        ],
        [
          "Desktop & browser",
          "Desktop control, browser automation, Android agent",
          "desktop-control / agent-browser",
        ],
        [
          "Docs & data",
          "PDF/PPT/XLSX, charts, data analysis",
          "pdf / pptx / xlsx / data-analysis",
        ],
        [
          "Knowledge",
          "Vault retrieval, Obsidian/Notion workflows",
          "knowledge-vault / obsidian / notion",
        ],
        [
          "Platform",
          "Skill authoring/lint, admin, Plan workflows",
          "skill-creator / evoflow-admin",
        ],
      ],
    },
    faq: {
      heading: "FAQ",
      lead: "Fixes for install failures, missing role grants, skills not firing, and SkillHub imports.",
      items: [
        {
          question: "Installed but never triggers in chat?",
          answer: [
            "Confirm the skill is enabled in Installed;",
            "Check the role whitelist includes it;",
            "Start a new chat or pin the skill in the composer.",
          ],
        },
        {
          question: "SkillHub / zip import failed?",
          answer: [
            "Ensure a valid SKILL.md with YAML frontmatter;",
            "Name must be unique vs public/custom skills;",
            "Try Import local skill on the unzipped folder.",
          ],
        },
        {
          question: "Can I delete bundled skills?",
          answer:
            "skills/public system skills cannot be deleted—only globally disabled. Custom and SkillHub skills can be removed.",
        },
        {
          question: "How are skills billed?",
          answer:
            "EvoFlow Skills have no per-call platform points. You pay your model API and any third-party tools (image/media) you configure.",
        },
        {
          question: "Smart Employees or Skills?",
          answer:
            "Smart Employees are on-duty roles with schedules and reports. Skills are pluggable capability packs for any agent. You can bind Skills onto employee roles.",
        },
      ],
    },
    community: {
      heading: "Go deeper: docs & open source",
      lead: "Install help, authoring rules, and upcoming capability updates.",
      ctaLabel: "Open GitHub",
      ctaHref: siteLinks.github,
    },
  },
};

export function getSkillsPage(locale: SiteLocale = defaultLocale) {
  return skillsPageByLocale[locale] ?? skillsPageByLocale[defaultLocale];
}
