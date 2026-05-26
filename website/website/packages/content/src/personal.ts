import { defaultLocale, type LocalizedValue, type SiteLocale } from "./locales";
import { personalProfileSchema } from "./schemas";

export const personalProfiles: LocalizedValue<
  ReturnType<typeof personalProfileSchema.parse>
> = {
  zh: personalProfileSchema.parse({
    name: "EvoFlow",
    title: "超级 Agent 驾驭框架",
    summary:
      "通过编排子 Agent、DAG 式任务分解与汇合，把复杂流程变成可回放轨迹；记忆与上下文层统一会话、工单与知识句柄，支撑跨天、跨渠道的长任务。沙箱与护栏约束工具与脚本执行，Skills / MCP 将 CRM、ITSM、IM 与内部 HTTP 服务接进同一条可观测链路；EvoPanel 提供桌面侧联调。项目在 DeerFlow 2.0 工程基线上持续演进，面向工单、运维、内部 Copilot 与企业 RAG 等严肃落地场景。",
  }),
  en: personalProfileSchema.parse({
    name: "EvoFlow",
    title: "Super-agent orchestration framework",
    summary:
      "Orchestrate sub-agents with DAG-style decomposition and merge points so complex flows become replayable traces. Memory binds sessions, tickets, and knowledge handles for long-horizon work across channels. Sandboxes and guardrails wrap tools and scripts; Skills and MCP wire CRM, ITSM, chat, and internal HTTP services into one observable pipeline, with EvoPanel for desktop co-debugging. Built atop DeerFlow 2.0 for production-grade tickets, ops, copilots, and enterprise RAG.",
  }),
};

export const personalProfile = personalProfiles[defaultLocale];

export function getPersonalProfile(locale: SiteLocale) {
  return personalProfiles[locale];
}
