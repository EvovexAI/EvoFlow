import type { LocalizedValue } from "./locales";
import { evoflowLayersByLocale } from "./resume-evoflow-layers";
import { evoflowPlanFlowByLocale, type ResumePlanFlowDoc } from "./resume-evoflow-plan";
import { siteLinks } from "./site-links";
import { siteIdentity } from "./site-identity";

export type { ResumePlanFlowDoc, ResumePlanFlowPhase, ResumePlanFlowStep } from "./resume-evoflow-plan";

/**
 * Section anchors — aligned with tbakerx/react-resume-template (MIT).
 * @see https://github.com/tbakerx/react-resume-template
 */
export type ResumeTemplateSectionId = "about" | "resume" | "evoflow" | "portfolio" | "contact";

/** EvoFlow 单模块：问题 / 技术 / 场景 */
export interface ResumeEvoFlowModule {
  title: string;
  problem: string;
  tech: string;
  scenario: string;
}

/** EvoFlow 架构分层（L1–L8） */
export interface ResumeEvoFlowLayer {
  layer: string;
  subtitle: string;
  modules: ResumeEvoFlowModule[];
}

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
  linkText?: string;
}

/** 基本信息（出生年月用于推算年龄） */
export interface ResumePersonalProfile {
  gender: string;
  /** 展示用，如 1998.01 */
  birthDisplay: string;
  birthYear: number;
  /** 1–12 */
  birthMonth: number;
  location: string;
}

/** 按当前日期推算周岁 */
export function resumeAge(
  birthYear: number,
  birthMonth: number,
  asOf: Date = new Date(),
): number {
  let age = asOf.getFullYear() - birthYear;
  const month = asOf.getMonth() + 1;
  if (month < birthMonth) age -= 1;
  return age;
}

export function resumeProfileLine(profile: ResumePersonalProfile, locale: string): string {
  const age = resumeAge(profile.birthYear, profile.birthMonth);
  if (locale === "en") {
    return `${profile.gender} · Born ${profile.birthDisplay} · Age ${age} · ${profile.location}`;
  }
  return `${profile.gender} · ${profile.birthDisplay} 生 · ${age} 岁 · ${profile.location}`;
}

export interface ResumeDoc {
  pdfLabel: string;
  wordLabel: string;
  headerBrand: string;
  headerHomeHref: string | null;
  heroEyebrow: string;
  sectionNav: Array<{ id: ResumeTemplateSectionId; label: string }>;
  name: string;
  role: string;
  /** 导出文件名（不含扩展名），如 景银泰-Harness全栈研发工程师 */
  exportBasename: string;
  profile: ResumePersonalProfile;
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

  evoflowTitle: string;
  evoflowLead: string;
  evoflowPlanFlow: ResumePlanFlowDoc;
  evoflowLayers: ResumeEvoFlowLayer[];

  portfolioTitle: string;
  portfolioLead: string;
  projects: ResumeProjectCard[];

  contactTitle: string;
  contactItems: ResumeContactItem[];

  templateCredit?: string;
}

export const resumeDocByLocale: LocalizedValue<ResumeDoc> = {
  zh: {
    pdfLabel: "导出 PDF",
    wordLabel: "导出 Word",
    headerBrand: "景银泰",
    headerHomeHref: null,
    heroEyebrow: "应聘 · Agent Harness 研发工程师",
    sectionNav: [
      { id: "about", label: "关于我" },
      { id: "resume", label: "履历" },
      { id: "evoflow", label: "EvoFlow" },
      { id: "portfolio", label: "其他项目" },
      { id: "contact", label: "联系" },
    ],
    name: "景银泰",
    role: "Agent Harness / 全栈研发工程师",
    exportBasename: "景银泰-Harness全栈研发工程师",
    profile: {
      gender: "男",
      birthDisplay: "1998.01",
      birthYear: 1998,
      birthMonth: 1,
      location: "上海",
    },
    tagline:
      "聚焦长任务 Harness 编排与 Token 治理；六年企业级架构与大模型落地，个人从 0 构建 EvoFlow（即将开源）。熟悉 Agent Loop、Tool Use、MCP/Skills 与可观测桌面交付。",
    heroActions: [
      { href: "#evoflow", text: "EvoFlow 架构", primary: true },
      { href: siteLinks.github, text: "EvoFlow · GitHub" },
      { href: `mailto:${siteIdentity.contactEmail}`, text: "邮件联系" },
    ],
    aboutTitle: "关于我",
    aboutLead:
      "我专注 Agent Harness：在「Model + Harness = Agent」中负责 Harness 一侧——把模型能力做成可交付、可复盘、适合开发者日常使用的桌面 Agent。六年企业级架构与大模型工程化背景；业余时间从 0 搭建 EvoFlow，已形成可演示的 Harness 全栈（即将开源）。",
    aboutParagraphs: [
      "方向与愿景：持续攻克长任务编排、断点续跑与运行稳定性，通过上下文治理、工具按需暴露与全链路可观测，系统性降低智能体 Token 消耗；对标 Cursor、Claude Code 等主流编码 Agent，争取在桌面 Harness 的体验与成本效率上实现赶超——目标宏大，有梦就去追。架构完备后，推进 AI 主导、AI 自主的自我进化闭环。",
      "交付方式：以 Cursor、Claude Code 等 Agent 工具驱动跨栈实现（TypeScript / Python / Java）。对经验不足的栈，用需求规格、自动化测试与轨迹回放保证质量；在模型行为、工具暴露粒度与上下文/Token 成本上，坚持以产品可用性为先。",
      "能力映射：EvoFlow 桌面端对应开发者主入口与交互面；编排内核、统一网关与 Skills/MCP 覆盖 Agent 循环、工具调用与扩展生态；任职期间的识别、质检、RAG、Text2SQL 等真实业务，为 Harness 迭代提供线上反馈。",
    ],
    aboutHighlights: [
      {
        label: "解决的问题",
        text: "长任务编排与稳定运行 · Token 消耗治理 · 工具调用护栏 · 全链路轨迹复盘 · 亿级检索与同步 · 多渠道消息幂等",
      },
      {
        label: "AI & 工程栈",
        text: "TypeScript · React · Next.js · Tauri 桌面 · Agent Loop · Tool Use · MCP · Skills · Prompt / 上下文治理 · RAG · 多厂商 LLM API · Python Agent Runtime · Cursor / Claude Code 协作交付",
      },
      {
        label: "典型场景",
        text: "桌面 Agent · 企业 Copilot · 工单与运维自动化 · 客服坐席辅助 · 知识库问答 · 近实时检索 · 全渠道触达",
      },
    ],
    resumeBlockTitle: "履历与技能",
    educationTitle: "教育背景",
    educationRows: [
      {
        title: "吉林大学",
        location: "计算机科学与技术 · 本科",
        date: "2022.03 — 2024.07",
        detail: "",
      },
    ],
    workTitle: "工作经历",
    workRows: [
      {
        title: "EvoFlow · 超级 Agent Harness",
        location: "Agent Harness · 即将开源",
        date: "2026 — 至今",
        detail:
          "自研超级 Agent 驾驭框架（DeerFlow 2.0 基线，即将开源）。下方 EvoFlow 区按 L1→L8 架构分层自上而下展开各模块能力，详见独立章节。",
      },
      {
        title: "架构与大模型应用工程师",
        location: "国华人寿 · 上海",
        date: "2020 — 至今",
        detail:
          "问题：核心业务库 Oracle 关联查询变慢；检索与分析需近实时；客服/核保/运营多条链路需 AI 赋能且可运维。技术：消息中台（Gateway 路由 + Kafka/RocketMQ + 幂等）；DTS（MySQL CDC → Kafka → ES，QL 映射/批量写/主备切换）；Flink + OGG 亿级同步至 MySQL 分表 + ES；大模型侧 Spring AI / LangChain、Dify/FastGPT/RagFlow、向量库 Milvus/ES、多厂商 API。场景：资料智能识别与结构化、视频质检与合规、坐席实时知识辅助、自然语言查数（Text2SQL）、客户意向/风险评分、智能陪练/外呼、知识库 RAG 分段与召回优化。",
      },
    ],
    skillsBarsHeading: "技能侧重",
    skillsBarsLead: "面向 Agent Harness 岗位的能力分布示意（非考试打分）。",
    skillBarGroups: [
      {
        name: "Agent / Harness",
        skills: [
          { name: "Agent Loop · Tool Use · MCP · Skills", level: 9, max: 10 },
          { name: "Context / Prompt Engineering", level: 9, max: 10 },
          { name: "编排运行时与可观测交付", level: 9, max: 10 },
        ],
      },
      {
        name: "工程栈",
        skills: [
          { name: "TypeScript / React / 桌面端 (Tauri)", level: 9, max: 10 },
          { name: "Python / Agent Runtime", level: 8, max: 10 },
          { name: "Java / 微服务与中台", level: 8, max: 10 },
        ],
      },
      {
        name: "数据与 AI 平台",
        skills: [
          { name: "Flink / ES / 实时同步", level: 8, max: 10 },
          { name: "RAG / 工作流平台", level: 8, max: 10 },
          { name: "Docker / K8s / 交付运维", level: 7, max: 10 },
        ],
      },
    ],
    evoflowTitle: "EvoFlow · Agent Harness",
    evoflowLead:
      "按架构分层自上而下展开（L1 交付与体验 → L8 进化与治理）；每一层下列出模块，均独立写清「问题 / 技术 / 场景」，对应桌面 Harness 全栈交付面。",
    evoflowPlanFlow: evoflowPlanFlowByLocale.zh,
    evoflowLayers: evoflowLayersByLocale.zh,
    portfolioTitle: "其他项目",
    portfolioLead: "任职期间企业级交付（与上方 EvoFlow 架构分层区独立列出）。",
    projects: [
      {
        title: "国华人寿 · AI 与基础架构（2020—至今）",
        summary: "企业内平台化交付：数据实时化、消息触达、大模型应用矩阵；下列为可单独复用的能力模块。",
        bullets: [
          "【实时检索 / 数据同步】问题：MySQL 业务库变更无法支撑秒级搜索与报表 → 技术：CDC 监听 + Kafka 削峰 + 字段映射/QL 过滤 + ES 批量写 + 优雅停机与监控告警；Flink + OGG 亿级入湖/分表 + ES 关键词检索 → 场景：保单检索、运营看板、风控指标近实时刷新",
          "【消息中台】问题：短信/邮件/企微/APP 等多通道重复建设、扩展成本高 → 技术：Gateway 动态路由（增通道仅配置）、模板与定时任务、异步发送 + 幂等键、下游短信/邮件/公众平台子系统 → 场景：营销触达、验证码、告警通知、客服自动回复",
          "【资料智能识别】问题：投保影像杂乱、缺件难以及时校验 → 技术：OCR + 大模型结构化抽取 + 缺件/字段校验 + 无序文件重排 → 场景：核保前置、减少人工补录",
          "【视频质检 / 坐席辅助】问题：合规风险与客服质量难规模化检查 → 技术：视频关键帧/语音转写 + 敏感词与证件识别 + 知识库向量检索（Milvus/ES）+ 低延迟推送 → 场景：销售合规、热线/在线客服实时话术提示",
          "【Text2SQL / RAG / 工作流】问题：业务人员不会写 SQL、文档检索召回低 → 技术：自然语言 → SQL（Schema 约束）、文档智能分段/索引、Dify/FastGPT/RagFlow 编排、多模型路由与评测 → 场景：经营分析问数、内部制度/产品问答、运营配置化 AI 流程",
        ],
        stack: "Java · Spring Boot · Dubbo · Kafka · Flink · OGG · ES · Milvus · LLM API · Dify",
      },
    ],
    contactTitle: "联系方式",
    contactItems: [
      {
        title: "邮箱",
        body: "欢迎就 Agent Harness 岗位联系",
        href: `mailto:${siteIdentity.contactEmail}`,
        linkText: siteIdentity.contactEmail,
      },
      {
        title: "EvoFlow 仓库",
        body: "Harness 实现与 EvoFlow 桌面端说明",
        href: siteLinks.github,
        linkText: "GitHub · EvovexAI/EvoFlow",
      },
    ],
  },
  en: {
    pdfLabel: "Export PDF",
    wordLabel: "Export Word",
    headerBrand: "Jing Yintai",
    headerHomeHref: null,
    heroEyebrow: "Applying · Agent Harness Engineer",
    sectionNav: [
      { id: "about", label: "About" },
      { id: "resume", label: "Resume" },
      { id: "evoflow", label: "EvoFlow" },
      { id: "portfolio", label: "Other work" },
      { id: "contact", label: "Contact" },
    ],
    name: "Jing Yintai (景银泰)",
    role: "Agent Harness / Full-stack Engineer",
    exportBasename: "JingYintai-Harness-Fullstack-Engineer",
    profile: {
      gender: "Male",
      birthDisplay: "1998-01",
      birthYear: 1998,
      birthMonth: 1,
      location: "Shanghai",
    },
    tagline:
      "Focused on long-run harness orchestration and token efficiency; six years of enterprise architecture and LLM delivery, built EvoFlow from scratch (opening source soon). Strong on Agent Loop, Tool Use, MCP/Skills, and observable desktop delivery.",
    heroActions: [
      { href: "#evoflow", text: "EvoFlow architecture", primary: true },
      { href: siteLinks.github, text: "EvoFlow on GitHub" },
      { href: `mailto:${siteIdentity.contactEmail}`, text: "Email" },
    ],
    aboutTitle: "About",
    aboutLead:
      "I focus on Agent Harness—the layer in Model + Harness = Agent that turns model capability into deliverable, replayable desktop agents engineers use daily. Six years of enterprise architecture and LLM engineering; built EvoFlow from zero into a demonstrable harness stack (opening source soon).",
    aboutParagraphs: [
      "Direction: keep improving long-task orchestration, checkpointing, and runtime stability; govern context, expose tools on demand, and observe end-to-end runs to cut agent token spend. Aim to match and surpass Cursor, Claude Code, and similar coding agents on desktop harness UX and cost—ambitious, worth pursuing. Once the architecture matures, move toward AI-led, autonomous self-evolution.",
      "How I ship: agentic IDEs (Cursor, Claude Code) across TypeScript, Python, and Java. On unfamiliar stacks I lean on specs, automated tests, and trace replay; I treat model behavior, progressive tool exposure, and context/token cost as product decisions.",
      "Capability map: EvoFlow desktop is the developer entry and UI; orchestration, gateway, and Skills/MCP cover the agent loop, tool use, and extensions; production workloads (recognition, QA, RAG, Text2SQL) supply real feedback for iteration.",
    ],
    aboutHighlights: [
      {
        label: "Problems solved",
        text: "Long-task orchestration & stability · token spend control · tool guardrails · end-to-end trace replay · search/sync at scale · omnichannel idempotency",
      },
      {
        label: "AI & engineering",
        text: "TypeScript · React · Next.js · Tauri desktop · Agent loop · Tool use · MCP · Skills · Prompt / context governance · RAG · Multi-vendor LLM APIs · Python agent runtime · Cursor / Claude Code delivery",
      },
      {
        label: "Scenarios",
        text: "Desktop agents · enterprise copilots · tickets & ops automation · agent assist · knowledge QA · near-real-time search · omnichannel outreach",
      },
    ],
    resumeBlockTitle: "Resume & skills",
    educationTitle: "Education",
    educationRows: [
      {
        title: "Jilin University",
        location: "B.S. Computer Science and Technology",
        date: "2022.03 — 2024.07",
        detail: "",
      },
    ],
    workTitle: "Experience",
    workRows: [
      {
        title: "EvoFlow · super-agent harness",
        location: "Agent Harness · opening source soon",
        date: "2026 — present",
        detail:
          "Personal super-agent harness (DeerFlow 2.0 baseline, opening source soon). The EvoFlow section below walks through L1→L8 architecture layers top to bottom—see the dedicated chapter.",
      },
      {
        title: "Architect · LLM applications",
        location: "Guohua Life · Shanghai",
        date: "2020 — present",
        detail:
          "Problems: Oracle join latency at scale; search/analytics need near-real-time paths; underwriting/ops/service need production-grade AI. Tech: message hub (Gateway + Kafka/RocketMQ + idempotency); DTS (MySQL CDC → Kafka → ES with QL mapping); Flink/OGG billion-row sync to sharded MySQL + ES; LLM stack with Spring AI/LangChain, Dify/FastGPT/RagFlow, Milvus/ES vectors, multi-vendor APIs. Scenarios: document OCR/structuring, video compliance QA, real-time agent assist, Text2SQL, intent/risk scoring, coaching/outbound voice, RAG chunking/recall tuning.",
      },
    ],
    skillsBarsHeading: "Skills snapshot",
    skillsBarsLead: "Illustrative emphasis for the Harness role—not exam scores.",
    skillBarGroups: [
      {
        name: "Agents / Harness",
        skills: [
          { name: "Agent loop · Tool Use · MCP · Skills", level: 9, max: 10 },
          { name: "Context / prompt engineering", level: 9, max: 10 },
          { name: "Orchestration & observable delivery", level: 9, max: 10 },
        ],
      },
      {
        name: "Engineering",
        skills: [
          { name: "TypeScript / React / desktop (Tauri)", level: 9, max: 10 },
          { name: "Python / agent runtime", level: 8, max: 10 },
          { name: "Java / microservices & platform", level: 8, max: 10 },
        ],
      },
      {
        name: "Data & AI platform",
        skills: [
          { name: "Flink / ES / real-time sync", level: 8, max: 10 },
          { name: "RAG / workflow platforms", level: 8, max: 10 },
          { name: "Docker / K8s / delivery", level: 7, max: 10 },
        ],
      },
    ],
    evoflowTitle: "EvoFlow · Agent Harness",
    evoflowLead:
      "Architecture layers L1–L8, top to bottom (delivery & experience → evolution & governance). Each layer lists modules with problem, technology, and scenarios—mapped to desktop Harness delivery.",
    evoflowPlanFlow: evoflowPlanFlowByLocale.en,
    evoflowLayers: evoflowLayersByLocale.en,
    portfolioTitle: "Other work",
    portfolioLead: "Employer delivery (separate from the EvoFlow layered architecture above).",
    projects: [
      {
        title: "Guohua Life · AI & platform (2020–present)",
        summary: "Platform modules for real-time data, messaging, and LLM products—reusable patterns below.",
        bullets: [
          "[Search / sync] Problem: OLTP changes lag search/reporting → Tech: CDC + Kafka + ES bulk writes; Flink/OGG billion-row sync + sharded MySQL/ES → Scenario: policy lookup, ops dashboards, near-real-time risk metrics",
          "[Message hub] Problem: duplicated channel integrations → Tech: Gateway routing, templates/schedulers, async idempotent send, SMS/email/WeChat subsystems → Scenario: campaigns, OTP, alerts, auto-reply",
          "[Document AI] Problem: messy underwriting images and missing fields → Tech: OCR + LLM structuring + validation/reordering → Scenario: faster underwriting prep",
          "[Video QA / assist] Problem: compliance and quality at scale → Tech: AV keyframes/transcripts, sensitive-term/id checks, vector KB retrieval with low latency → Scenario: sales compliance, live agent hints",
          "[Text2SQL / RAG / workflows] Problem: non-SQL users and weak recall → Tech: NL→SQL with schema constraints, smart chunking/indexing, Dify/FastGPT/RagFlow orchestration → Scenario: analytics questions, internal policy Q&A, ops-configurable AI flows",
        ],
        stack: "Java · Spring Boot · Dubbo · Kafka · Flink · OGG · ES · Milvus · LLM API · Dify",
      },
    ],
    contactTitle: "Contact",
    contactItems: [
      {
        title: "Email",
        body: "Agent Harness role inquiries",
        href: `mailto:${siteIdentity.contactEmail}`,
        linkText: siteIdentity.contactEmail,
      },
      {
        title: "EvoFlow repository",
        body: "Harness implementation and EvoFlow desktop docs",
        href: siteLinks.github,
        linkText: "GitHub · EvovexAI/EvoFlow",
      },
    ],
  },
};
