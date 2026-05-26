import type { ResumeDoc, ResumeEvoFlowLayer, ResumeEvoFlowModule } from "./resume";
import { resumeProfileLine } from "./resume";

function mdEscapeInline(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\*/g, "\\*").replace(/_/g, "\\_");
}

function mdParagraph(text: string): string {
  return text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n\n");
}

function moduleBlock(
  mod: ResumeEvoFlowModule,
  indexLabel: string,
  locale: string,
): string {
  const labels =
    locale === "en"
      ? { problem: "Problem", tech: "Technology", scenario: "Scenario" }
      : { problem: "问题", tech: "技术", scenario: "场景" };
  return [
    `#### ${indexLabel} ${mdEscapeInline(mod.title)}`,
    "",
    `- **${labels.problem}**：${mdEscapeInline(mod.problem)}`,
    `- **${labels.tech}**：${mdEscapeInline(mod.tech)}`,
    `- **${labels.scenario}**：${mdEscapeInline(mod.scenario)}`,
    "",
  ].join("\n");
}

function layerBlock(layer: ResumeEvoFlowLayer, layerIndex: number, locale: string): string {
  return [
    `### ${layer.layer}`,
    "",
    mdParagraph(layer.subtitle),
    "",
    ...layer.modules.map((mod, modIndex) =>
      moduleBlock(mod, `${layerIndex + 1}.${modIndex + 1}`, locale),
    ),
  ].join("\n");
}

/** 由 ResumeDoc 生成完整 Markdown（与 Word 导出字段一致，不含网页导航/装饰） */
export function buildResumeMarkdown(
  doc: ResumeDoc,
  locale: string,
  optionalPhone?: string,
): string {
  const lines: string[] = [
    `# ${doc.name}`,
    "",
    `## ${doc.role}`,
    "",
    `*${resumeProfileLine(doc.profile, locale)}*`,
    "",
    mdParagraph(doc.tagline),
    "",
    `*${doc.heroEyebrow}*`,
    "",
    "---",
    "",
    `## ${doc.aboutTitle}`,
    "",
    mdParagraph(doc.aboutLead),
    "",
    ...doc.aboutParagraphs.flatMap((p) => [mdParagraph(p), ""]),
    ...doc.aboutHighlights.flatMap((h) => [
      `**${mdEscapeInline(h.label)}**`,
      "",
      mdParagraph(h.text),
      "",
    ]),
    "---",
    "",
    `## ${doc.resumeBlockTitle}`,
    "",
    `### ${doc.educationTitle}`,
    "",
    ...doc.educationRows.flatMap((row) => [
      `**${mdEscapeInline(row.title)}** · ${mdEscapeInline(row.location)}`,
      "",
      `*${row.date}*`,
      "",
      ...(row.detail.trim() ? [mdParagraph(row.detail), ""] : []),
    ]),
    `### ${doc.workTitle}`,
    "",
    ...doc.workRows.flatMap((row) => [
      `**${mdEscapeInline(row.title)}** · ${mdEscapeInline(row.location)}`,
      "",
      `*${row.date}*`,
      "",
      ...(row.detail.trim() ? [mdParagraph(row.detail), ""] : []),
    ]),
    `### ${doc.skillsBarsHeading}`,
    "",
    mdParagraph(doc.skillsBarsLead),
    "",
    ...doc.skillBarGroups.flatMap((g) => [
      `**${mdEscapeInline(g.name)}**`,
      "",
      ...g.skills.map(
        (s) => `- ${mdEscapeInline(s.name)} — ${s.level}/${s.max ?? 10}`,
      ),
      "",
    ]),
    "---",
    "",
    `## ${doc.evoflowTitle}`,
    "",
    mdParagraph(doc.evoflowLead),
    "",
    `### ${doc.evoflowPlanFlow.title}`,
    "",
    `**${locale === "en" ? "Architecture" : "架构"}**：${mdEscapeInline(doc.evoflowPlanFlow.architecture)}`,
    "",
    mdParagraph(doc.evoflowPlanFlow.lead),
    "",
    `**${locale === "en" ? "Phases" : "阶段轨道"}**：${doc.evoflowPlanFlow.phases.map((p) => p.label).join(" → ")}`,
    "",
    ...doc.evoflowPlanFlow.steps.flatMap((step, i) => [
      `${i + 1}. **${mdEscapeInline(step.title)}**（${step.phase}）`,
      "",
      mdParagraph(step.detail),
      "",
    ]),
    `### ${locale === "en" ? "Architecture layers" : "架构分层"}`,
    "",
    ...doc.evoflowLayers.flatMap((layer, i) => [layerBlock(layer, i, locale), ""]),
    "---",
    "",
    `## ${doc.portfolioTitle}`,
    "",
    mdParagraph(doc.portfolioLead),
    "",
    ...doc.projects.flatMap((p) => [
      `### ${mdEscapeInline(p.title)}`,
      "",
      ...(p.stack ? [`*${mdEscapeInline(p.stack)}*`, ""] : []),
      mdParagraph(p.summary),
      "",
      ...p.bullets.map((b) => `- ${mdEscapeInline(b)}`),
      "",
    ]),
    "---",
    "",
    `## ${doc.contactTitle}`,
    "",
    `- **${locale === "en" ? "Profile" : "基本信息"}**：${resumeProfileLine(doc.profile, locale)}`,
    "",
    ...(optionalPhone
      ? [
          locale === "en"
            ? `- **Phone**: ${optionalPhone} — Shanghai · weekday calls welcome`
            : `- **手机**：${optionalPhone} — 上海 · 工作日可约沟通`,
          "",
        ]
      : []),
    ...doc.contactItems.map((c) => {
      if (c.href) {
        const label = c.linkText ?? c.href;
        return `- **${mdEscapeInline(c.title)}**：[${mdEscapeInline(label)}](${c.href}) — ${mdEscapeInline(c.body)}`;
      }
      return `- **${mdEscapeInline(c.title)}**：${mdEscapeInline(c.body)}`;
    }),
    "",
  ];

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}
