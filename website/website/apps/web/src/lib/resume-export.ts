import type { ResumeDoc, ResumeEvoFlowLayer, ResumeEvoFlowModule } from "@ai-site/content";
import { buildResumeMarkdown, resumeProfileLine } from "@ai-site/content";
import {
  AlignmentType,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  TextRun,
} from "docx";
import html2canvas from "html2canvas";
import { jsPDF } from "jspdf";
import { resumeMarkdownToHtml, resumePrintDocumentHtml } from "./resume-print-html";

const PDF_JPEG_QUALITY = 0.82;
const PDF_MAX_CANVAS_PIXELS = 12_000_000;

function sanitizeExportFilename(base: string): string {
  return base.replace(/[\\/:*?"<>|]/g, "-").trim();
}

export function resumeExportFilename(doc: ResumeDoc, ext: "pdf" | "docx" | "md"): string {
  return `${sanitizeExportFilename(doc.exportBasename)}.${ext}`;
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function downloadText(text: string, filename: string, mime = "text/markdown;charset=utf-8") {
  downloadBlob(new Blob([text], { type: mime }), filename);
}

function bulletParagraph(text: string) {
  return new Paragraph({
    text: `• ${text}`,
    spacing: { after: 80 },
  });
}

function sectionHeading(text: string) {
  return new Paragraph({
    text,
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 240, after: 120 },
  });
}

function evoFlowLayerParagraphs(layer: ResumeEvoFlowLayer, layerIndex: number, locale: string) {
  return [
    new Paragraph({
      children: [new TextRun({ text: layer.layer, bold: true, size: 26 })],
      spacing: { before: 200, after: 80 },
    }),
    new Paragraph({ text: layer.subtitle, spacing: { after: 120 } }),
    ...layer.modules.flatMap((mod, modIndex) =>
      evoFlowModuleParagraphs(mod, `${layerIndex + 1}.${modIndex + 1}`, locale),
    ),
  ];
}

function evoFlowModuleParagraphs(mod: ResumeEvoFlowModule, indexLabel: string, locale: string) {
  const labels =
    locale === "en"
      ? { problem: "Problem", tech: "Technology", scenario: "Scenario" }
      : { problem: "问题", tech: "技术", scenario: "场景" };
  return [
    new Paragraph({
      children: [
        new TextRun({ text: `${indexLabel} ${mod.title}`, bold: true, size: 24 }),
      ],
      spacing: { before: 120, after: 80 },
    }),
    new Paragraph({ text: `${labels.problem}：${mod.problem}`, spacing: { after: 60 } }),
    new Paragraph({ text: `${labels.tech}：${mod.tech}`, spacing: { after: 60 } }),
    new Paragraph({ text: `${labels.scenario}：${mod.scenario}`, spacing: { after: 120 } }),
  ];
}

function timelineBlock(row: { title: string; location: string; date: string; detail: string }) {
  return [
    new Paragraph({
      children: [
        new TextRun({ text: row.title, bold: true, size: 24 }),
        new TextRun({ text: `  ·  ${row.location}`, size: 22 }),
      ],
      spacing: { after: 40 },
    }),
    new Paragraph({
      children: [new TextRun({ text: row.date, italics: true, size: 20, color: "666666" })],
      spacing: { after: row.detail.trim() ? 80 : 160 },
    }),
    ...(row.detail.trim()
      ? [new Paragraph({ text: row.detail, spacing: { after: 160 } })]
      : []),
  ];
}

/** 导出前可选填写手机号；点「取消」则中止导出 */
export function promptOptionalPhoneForExport(locale: string): string | undefined {
  const msg =
    locale === "en"
      ? "Optional phone for this export (leave empty and OK to skip; Cancel to abort export)"
      : "可选：为本份导出填写手机号（留空并确定则不含手机；取消则中止导出）";
  const raw = window.prompt(msg, "");
  if (raw === null) return undefined;
  return raw.trim();
}

/** 下载 Markdown 源稿（与 PDF/Word 同源） */
export function exportResumeMarkdown(
  doc: ResumeDoc,
  locale: string,
  optionalPhone?: string,
) {
  const md = buildResumeMarkdown(doc, locale, optionalPhone);
  downloadText(md, resumeExportFilename(doc, "md"));
}

/** 由结构化履历生成 .docx */
export async function exportResumeDocx(
  doc: ResumeDoc,
  locale: string,
  optionalPhone?: string,
) {
  const children: Paragraph[] = [
    new Paragraph({
      text: doc.name,
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.CENTER,
    }),
    new Paragraph({
      text: doc.role,
      alignment: AlignmentType.CENTER,
      spacing: { after: 80 },
    }),
    new Paragraph({
      text: resumeProfileLine(doc.profile, locale),
      alignment: AlignmentType.CENTER,
      spacing: { after: 80 },
    }),
    new Paragraph({
      text: doc.tagline,
      alignment: AlignmentType.CENTER,
      spacing: { after: 200 },
    }),
    sectionHeading(doc.aboutTitle),
    new Paragraph({ text: doc.aboutLead, spacing: { after: 120 } }),
    ...doc.aboutParagraphs.map((p) => new Paragraph({ text: p, spacing: { after: 120 } })),
    ...doc.aboutHighlights.flatMap((h) => [
      new Paragraph({
        children: [new TextRun({ text: h.label, bold: true, size: 22 })],
        spacing: { before: 80, after: 60 },
      }),
      new Paragraph({ text: h.text, spacing: { after: 120 } }),
    ]),
    sectionHeading(doc.resumeBlockTitle),
    new Paragraph({
      text: doc.educationTitle,
      heading: HeadingLevel.HEADING_3,
      spacing: { before: 120, after: 80 },
    }),
    ...doc.educationRows.flatMap((row) => timelineBlock(row)),
    new Paragraph({
      text: doc.workTitle,
      heading: HeadingLevel.HEADING_3,
      spacing: { before: 120, after: 80 },
    }),
    ...doc.workRows.flatMap((row) => timelineBlock(row)),
    new Paragraph({
      text: doc.skillsBarsHeading,
      heading: HeadingLevel.HEADING_3,
      spacing: { before: 120, after: 80 },
    }),
    new Paragraph({ text: doc.skillsBarsLead, spacing: { after: 120 } }),
    ...doc.skillBarGroups.flatMap((g) => [
      new Paragraph({
        children: [new TextRun({ text: g.name, bold: true, size: 22 })],
        spacing: { before: 80, after: 80 },
      }),
      ...g.skills.map((s) =>
        bulletParagraph(`${s.name} — ${s.level}/${s.max ?? 10}`),
      ),
    ]),
    sectionHeading(doc.evoflowTitle),
    new Paragraph({ text: doc.evoflowLead, spacing: { after: 120 } }),
    new Paragraph({
      children: [new TextRun({ text: doc.evoflowPlanFlow.title, bold: true, size: 26 })],
      spacing: { before: 160, after: 80 },
    }),
    new Paragraph({
      text:
        (locale === "en" ? "Architecture: " : "架构：") + doc.evoflowPlanFlow.architecture,
      spacing: { after: 80 },
    }),
    new Paragraph({ text: doc.evoflowPlanFlow.lead, spacing: { after: 120 } }),
    new Paragraph({
      text:
        (locale === "en" ? "Phases: " : "阶段轨道：") +
        doc.evoflowPlanFlow.phases.map((p) => p.label).join(" → "),
      spacing: { after: 120 },
    }),
    ...doc.evoflowPlanFlow.steps.flatMap((step, i) => [
      new Paragraph({
        children: [new TextRun({ text: `${i + 1}. ${step.title}`, bold: true, size: 22 })],
        spacing: { before: 100, after: 60 },
      }),
      new Paragraph({ text: step.detail, spacing: { after: 80 } }),
    ]),
    new Paragraph({
      text: locale === "en" ? "Architecture layers" : "架构分层",
      heading: HeadingLevel.HEADING_3,
      spacing: { before: 200, after: 120 },
    }),
    ...doc.evoflowLayers.flatMap((layer, i) => evoFlowLayerParagraphs(layer, i, locale)),
    sectionHeading(doc.portfolioTitle),
    new Paragraph({ text: doc.portfolioLead, spacing: { after: 160 } }),
    ...doc.projects.flatMap((p) => [
      new Paragraph({
        children: [new TextRun({ text: p.title, bold: true, size: 24 })],
        spacing: { after: 40 },
      }),
      ...(p.stack
        ? [new Paragraph({ text: p.stack, spacing: { after: 80 } })]
        : []),
      new Paragraph({ text: p.summary, spacing: { after: 80 } }),
      ...p.bullets.map((b) => bulletParagraph(b)),
      new Paragraph({ text: "", spacing: { after: 120 } }),
    ]),
    sectionHeading(doc.contactTitle),
    new Paragraph({
      text: `${locale === "en" ? "Profile" : "基本信息"}: ${resumeProfileLine(doc.profile, locale)}`,
      spacing: { after: 80 },
    }),
    ...(optionalPhone
      ? [
          new Paragraph({
            text:
              locale === "en"
                ? `Phone: ${optionalPhone} — Shanghai · weekday calls welcome`
                : `手机：${optionalPhone} — 上海 · 工作日可约沟通`,
            spacing: { after: 80 },
          }),
        ]
      : []),
    ...doc.contactItems.map((c) => {
      const line = c.href ? `${c.title}: ${c.linkText ?? c.href} — ${c.body}` : `${c.title}: ${c.body}`;
      return new Paragraph({ text: line, spacing: { after: 80 } });
    }),
  ];

  const wordDoc = new Document({
    sections: [{ properties: {}, children }],
  });
  const blob = await Packer.toBlob(wordDoc);
  downloadBlob(blob, resumeExportFilename(doc, "docx"));
}

function pdfCaptureScale(width: number, height: number): number {
  const base = 1.25;
  if (width <= 0 || height <= 0) return base;
  const pixels = width * height * base * base;
  if (pixels <= PDF_MAX_CANVAS_PIXELS) return base;
  return Math.max(1, Math.sqrt(PDF_MAX_CANVAS_PIXELS / (width * height)));
}

function sliceCanvasToPdfPages(
  source: HTMLCanvasElement,
  pageContentWidthMm: number,
  pageContentHeightMm: number,
  fillStyle: string,
): Array<{ dataUrl: string; heightMm: number }> {
  const sliceHeightPx = Math.max(
    1,
    Math.floor((pageContentHeightMm * source.width) / pageContentWidthMm),
  );
  const pages: Array<{ dataUrl: string; heightMm: number }> = [];

  for (let y = 0; y < source.height; y += sliceHeightPx) {
    const hPx = Math.min(sliceHeightPx, source.height - y);
    const hMm = (hPx * pageContentWidthMm) / source.width;
    const slice = document.createElement("canvas");
    slice.width = source.width;
    slice.height = hPx;
    const ctx = slice.getContext("2d");
    if (!ctx) continue;
    ctx.fillStyle = fillStyle;
    ctx.fillRect(0, 0, slice.width, slice.height);
    ctx.drawImage(source, 0, y, source.width, hPx, 0, 0, source.width, hPx);
    pages.push({
      dataUrl: slice.toDataURL("image/jpeg", PDF_JPEG_QUALITY),
      heightMm: hMm,
    });
  }

  return pages;
}

const PDF_EXPORT_HOST_ID = "resume-pdf-export-host";

/** 将打印 HTML 挂到主文档离屏节点（html2canvas 要求节点属于当前 window） */
function mountResumeHtmlHost(html: string): HTMLElement {
  document.getElementById(PDF_EXPORT_HOST_ID)?.remove();

  const parsed = new DOMParser().parseFromString(html, "text/html");
  const styleText = parsed.querySelector("style")?.textContent ?? "";
  const main = parsed.querySelector("main");

  const host = document.createElement("div");
  host.id = PDF_EXPORT_HOST_ID;
  host.setAttribute("aria-hidden", "true");
  host.style.cssText =
    "position:fixed;left:-10000px;top:0;width:794px;max-width:794px;background:#fff;color:#1c1917;pointer-events:none;";

  if (styleText) {
    const style = document.createElement("style");
    style.textContent = styleText;
    host.appendChild(style);
  }

  if (main) {
    host.appendChild(main.cloneNode(true));
  } else {
    const fallback = document.createElement("div");
    fallback.innerHTML = parsed.body?.innerHTML ?? "";
    host.appendChild(fallback);
  }

  document.body.appendChild(host);
  return host;
}

async function downloadPdfFromHtml(
  html: string,
  locale: string,
  filename: string,
): Promise<void> {
  const host = mountResumeHtmlHost(html);

  try {
    await new Promise((r) => setTimeout(r, 350));

    const scale = pdfCaptureScale(host.scrollWidth, host.scrollHeight);
    const canvas = await html2canvas(host, {
      scale,
      useCORS: true,
      logging: false,
      backgroundColor: "#ffffff",
    });

    const pdf = new jsPDF({ orientation: "p", unit: "mm", format: "a4" });
    const pageWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();
    const margin = 8;
    const contentWidth = pageWidth - margin * 2;
    const contentHeight = pageHeight - margin * 2;

    const slices = sliceCanvasToPdfPages(
      canvas,
      contentWidth,
      contentHeight,
      "#ffffff",
    );

    slices.forEach((slice, index) => {
      if (index > 0) pdf.addPage();
      pdf.addImage(
        slice.dataUrl,
        "JPEG",
        margin,
        margin,
        contentWidth,
        slice.heightMm,
        undefined,
        "FAST",
      );
    });

    pdf.save(filename);
  } finally {
    host.remove();
  }
}

/**
 * Markdown → 纯 HTML → 直接下载 PDF（与 Word 同源，非整页网页截图）。
 */
export async function exportResumePdf(
  doc: ResumeDoc,
  locale: string,
  optionalPhone?: string,
) {
  const md = buildResumeMarkdown(doc, locale, optionalPhone);
  const bodyHtml = resumeMarkdownToHtml(md);
  const html = resumePrintDocumentHtml(bodyHtml, locale);
  await downloadPdfFromHtml(html, locale, resumeExportFilename(doc, "pdf"));
}
