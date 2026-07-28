import {
  defaultLocale,
  type LocalizedValue,
  type SiteLocale,
} from "./locales";
import { siteLinks } from "./site-links";

export const employeesPageByLocale: LocalizedValue<{
  meta: { title: string; description: string };
  hero: {
    brand: string;
    title: string;
    lead: string;
    primaryCta: { label: string; href: string };
    secondaryCta: { label: string; href: string };
  };
  stages: Array<{
    kicker: string;
    title: string;
    body: string;
  }>;
  roles: Array<{
    name: string;
    duty: string;
  }>;
  rolesHeading: string;
  rolesLead: string;
  animLinkLabel: string;
  animLinkHref: string;
  closing: {
    title: string;
    body: string;
    ctaLabel: string;
    ctaHref: string;
  };
}> = {
  zh: {
    meta: {
      title: "智能体员工 | EvoFlow",
      description:
        "EvoFlow 智能体员工：把 AI 雇成真实岗位，按职责自动上班、写工作汇报；你看结果、偶尔审批。",
    },
    hero: {
      brand: "EvoFlow",
      title: "智能体员工",
      lead: "不是聊天机器人待命，而是到岗上班的同事：有岗位名、有职责、有上班频率，干完写工作汇报。",
      primaryCta: { label: "下载桌面端", href: siteLinks.blog },
      secondaryCta: { label: "看文档教程", href: "/docs" },
    },
    stages: [
      {
        kicker: "01",
        title: "选岗位 · 写职责",
        body: "用模板一键预填：研发助理、运维值班、学习助理、内容策划、文档管理员。职责写成可验收的几条，绑上工作文件夹。",
      },
      {
        kicker: "02",
        title: "开启自动上班",
        body: "页头打开自动上班总开关。到点按频率干活；也可随时点「现在开始工作」手动开一轮。",
      },
      {
        kicker: "03",
        title: "看汇报 · 点审批",
        body: "工作日志默认近两天；转交同事前常见「同意派发」。卡住、没干活、汇报没写完——诊断条一句话说清，并给出下一步。",
      },
    ],
    roles: [
      { name: "研发助理", duty: "盯仓库脏文件与临时垃圾，下班写清单" },
      { name: "运维值班", duty: "探活服务，异常写工作汇报" },
      { name: "学习助理", duty: "对照计划提醒进度与缺项" },
      { name: "内容策划", duty: "盯选题日历与素材缺口" },
      { name: "文档管理员", duty: "抽查断链、重复与过期页" },
    ],
    rolesHeading: "开箱岗位",
    rolesLead: "雇佣弹窗可点模板预填——岗位名就是现实世界职称。",
    animLinkLabel: "动画预览合集 →",
    animLinkHref: "/animations/employees/",
    closing: {
      title: "一个人也能先雇一个岗",
      body: "适合独立开发者与小团队：先跑通单岗，再按组织树加下级与同意派发。",
      ctaLabel: "回到首页",
      ctaHref: "/",
    },
  },
  en: {
    meta: {
      title: "Smart Employees | EvoFlow",
      description:
        "EvoFlow Smart Employees: hire AI into real roles that work on a schedule and leave written reports.",
    },
    hero: {
      brand: "EvoFlow",
      title: "Smart Employees",
      lead: "Not a chatbot on standby—teammates on duty: a job title, duties, a work cadence, and a written report when the round ends.",
      primaryCta: { label: "Download", href: siteLinks.blog },
      secondaryCta: { label: "Read the docs", href: "/docs" },
    },
    stages: [
      {
        kicker: "01",
        title: "Pick a role · write duties",
        body: "Templates for dev assistant, ops on-call, study coach, content planner, and docs admin. Bind a workspace folder.",
      },
      {
        kicker: "02",
        title: "Turn on auto-work",
        body: "Flip the page-head switch. Roles work on cadence—or hit “Start work now” anytime.",
      },
      {
        kicker: "03",
        title: "Read reports · approve",
        body: "Work logs default to two days. Downstream wake often needs “approve dispatch”. Diagnosis chips explain idle, stuck, or unfinished reports.",
      },
    ],
    roles: [
      { name: "Dev assistant", duty: "Watch dirty files and leave a checklist" },
      { name: "Ops on-call", duty: "Probe services; report anomalies" },
      { name: "Study coach", duty: "Track plan progress and gaps" },
      { name: "Content planner", duty: "Watch calendar and asset gaps" },
      { name: "Docs admin", duty: "Spot broken links and stale pages" },
    ],
    rolesHeading: "Starter roles",
    rolesLead: "Hire templates prefill duties—job titles match the real world.",
    animLinkLabel: "Animation gallery →",
    animLinkHref: "/animations/employees/",
    closing: {
      title: "Start with one role",
      body: "Solo builders and small teams: ship a single role first, then grow the org tree when you need handoffs.",
      ctaLabel: "Back home",
      ctaHref: "/",
    },
  },
};

export function getEmployeesPage(locale: SiteLocale = defaultLocale) {
  return employeesPageByLocale[locale] ?? employeesPageByLocale[defaultLocale];
}
