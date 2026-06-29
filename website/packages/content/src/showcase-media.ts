import type { LocalizedValue } from "./locales";

/** Public URL prefix (files synced from repo `docs/assets/` via `pnpm sync:media`). */
export const showcaseMediaBase = "/media";

export type ShowcaseVideo = {
  src: string;
  poster: string;
  title: Record<"zh" | "en", string>;
  caption: Record<"zh" | "en", string>;
};

export type ShowcaseImage = {
  src: string;
  alt: Record<"zh" | "en", string>;
  caption: Record<"zh" | "en", string>;
};

export type ShowcasePageCopy = {
  title: string;
  description: string;
  planSection: {
    title: string;
    lead: string;
    videosTitle: string;
    galleryTitle: string;
  };
  guiSection: {
    title: string;
    lead: string;
  };
};

export const homeVisualShowcaseByLocale: LocalizedValue<{
  eyebrow: string;
  title: string;
  lead: string;
  snapshotsLabel: string;
  moreLabel: string;
}> = {
  zh: {
    eyebrow: "产品演示",
    title: "Plan 模式 · 从 0 到 1 真实协作",
    lead: "两段实拍演示：Agent Teams 分工完成项目，以及交付后项目跑通效果；下方为计划分析图、步骤分工与预设角色等关键界面。",
    snapshotsLabel: "界面快照",
    moreLabel: "查看全部演示",
  },
  en: {
    eyebrow: "Live demo",
    title: "Plan mode · 0 → 1 in production",
    lead: "Two screen recordings: Agent Teams shipping a project, then the running result. Key UI snapshots below—analysis diagram, step breakdown, preset teams & roles.",
    snapshotsLabel: "UI snapshots",
    moreLabel: "Full showcase",
  },
};

export const showcasePageCopyByLocale: LocalizedValue<ShowcasePageCopy> = {
  zh: {
    title: "产品演示",
    description:
      "Plan 模式 Agent Teams 从 0 到 1 协作，以及 EvoPanel 桌面端界面截图与演示视频（与 GitHub README 素材同源）。",
    planSection: {
      title: "Plan 模式 · Agent Teams 从 0 到 1",
      lead:
        "Supervisor 按「先澄清 → 再规划 → 确认后执行」推进；Agent Teams 将各 Step 派给最合适的子 Agent。下列视频与截图展示一次典型软件项目协作闭环。",
      videosTitle: "视频演示",
      galleryTitle: "协作过程一览",
    },
    guiSection: {
      title: "界面预览",
      lead: "EvoPanel 桌面端主界面、预设角色（团队 + 角色）与其它能力示意。",
    },
  },
  en: {
    title: "Product showcase",
    description:
      "Plan-mode Agent Teams from zero to delivery, plus EvoPanel GUI screenshots and demo videos (same assets as the GitHub README).",
    planSection: {
      title: "Plan mode · Agent Teams · 0 → 1",
      lead:
        "The Supervisor runs clarify → plan → confirm → execute; Agent Teams assign each step to the right sub-agent. Videos and screenshots walk through a typical greenfield project.",
      videosTitle: "Videos",
      galleryTitle: "Collaboration gallery",
    },
    guiSection: {
      title: "GUI preview",
      lead: "EvoPanel main chat, preset roles (teams + roles), and other capability screenshots.",
    },
  },
};

const p = (subdir: string, file: string) => `${showcaseMediaBase}/${subdir}/${file}`;

export const planShowcaseVideos: ShowcaseVideo[] = [
  {
    src: p("plan-supervisor", "video-01-plan-clarify-to-ready.mp4"),
    poster: p("plan-supervisor", "video-01-plan-clarify-to-ready-poster.png"),
    title: {
      zh: "视频一 · Plan 协作全过程",
      en: "Video 1 · Full Plan collaboration",
    },
    caption: {
      zh: "澄清 → 结构化计划 → Agent Teams 分工执行至交付物产出",
      en: "Clarify → structured plan → Agent Teams execution through deliverables",
    },
  },
  {
    src: p("plan-supervisor", "video-02-plan-project-running-result.mp4"),
    poster: p("plan-supervisor", "video-02-plan-project-running-result-poster.png"),
    title: {
      zh: "视频二 · 项目运行结果展示",
      en: "Video 2 · Running project demo",
    },
    caption: {
      zh: "协作交付完成后启动项目，演示页面交互、接口或核心功能验收",
      en: "After delivery, start the app and demo UI flows, APIs, or acceptance checks",
    },
  },
];

export const planShowcaseImages: ShowcaseImage[] = [
  {
    src: p("plan-supervisor", "plan-02-structured-plan-modal.png"),
    alt: { zh: "任务分析图", en: "Task analysis diagram" },
    caption: { zh: "② 计划 · 任务分析图", en: "② Plan · analysis diagram" },
  },
  {
    src: p("plan-supervisor", "plan-02-structured-plan-modal-2.png"),
    alt: { zh: "执行步骤与智能体任务", en: "Steps and agent task details" },
    caption: { zh: "② 计划 · 步骤与智能体目标/验收", en: "② Plan · steps & agent tasks" },
  },
  {
    src: p("plan-supervisor", "plan-04-exec-confirm-dock.png"),
    alt: { zh: "开始执行确认", en: "Start execution confirm" },
    caption: { zh: "④ 执行闸口", en: "④ Execution gate" },
  },
  {
    src: p("plan-supervisor", "plan-05-supervisor-workflow-panel.png"),
    alt: { zh: "子任务工作流面板", en: "Subtask workflow panel" },
    caption: { zh: "⑤ Supervisor 工作流", en: "⑤ Supervisor workflow" },
  },
  {
    src: p("plan-supervisor", "video-02-plan-project-running-result-poster.png"),
    alt: { zh: "多 Agent 子任务执行", en: "Multi-agent subtasks running" },
    caption: { zh: "⑥ 多 Agent 协作", en: "⑥ Multi-agent run" },
  },
];

export const guiShowcaseImages: ShowcaseImage[] = [
  {
    src: p("screenshots", "main-chat.png"),
    alt: { zh: "主界面", en: "Main chat" },
    caption: { zh: "主界面 · 流式对话与工具可视化", en: "Main · streaming & tools" },
  },
  {
    src: p("screenshots", "agents-preset-teams.png"),
    alt: { zh: "预设角色 · 团队总览", en: "Preset roles · teams" },
    caption: { zh: "预设角色（一）· 团队总览", en: "Preset roles (1) · teams" },
  },
  {
    src: p("screenshots", "agents-preset-roles.png"),
    alt: { zh: "预设角色 · 团队内角色", en: "Preset roles · roles in team" },
    caption: { zh: "预设角色（二）· 项目团队角色", en: "Preset roles (2) · project team" },
  },
  {
    src: p("screenshots", "scheduled-tasks-1.png"),
    alt: { zh: "自动化（一）", en: "Scheduled tasks (1)" },
    caption: { zh: "自动化（一）", en: "Scheduled (1)" },
  },
  {
    src: p("screenshots", "scheduled-tasks-2.png"),
    alt: { zh: "自动化（二）", en: "Scheduled tasks (2)" },
    caption: { zh: "自动化（二）", en: "Scheduled (2)" },
  },
  {
    src: p("screenshots", "hosted-1.png"),
    alt: { zh: "托管任务（一）", en: "Hosted (1)" },
    caption: { zh: "托管任务（一）", en: "Hosted (1)" },
  },
  {
    src: p("screenshots", "hosted-2.png"),
    alt: { zh: "托管任务（二）", en: "Hosted (2)" },
    caption: { zh: "托管任务（二）", en: "Hosted (2)" },
  },
  {
    src: p("screenshots", "browser.png"),
    alt: { zh: "浏览器自动化", en: "Browser automation" },
    caption: { zh: "浏览器操作", en: "Browser" },
  },
];
