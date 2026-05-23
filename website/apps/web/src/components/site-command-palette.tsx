"use client";

import { type LocalizedValue, siteIdentity, siteLinks, staticPageHref } from "@ai-site/content";
import * as Dialog from "@radix-ui/react-dialog";
import { Command } from "cmdk";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { useLocalizedValue, useSiteLocale } from "./locale-provider";

type PaletteGroupKey = "pages" | "links";
type PaletteMode = "default" | "terminal";

interface PaletteItem {
  description: string;
  group: PaletteGroupKey;
  id: string;
  keywords: string[];
  label: string;
  type: "external" | "route";
  url: string;
}

interface CommandPaletteCopy {
  aiResponseLabel: string;
  aiSuggestionLabel: string;
  askAiLabel: string;
  artifactKindLabels: {
    executionReview: string;
    knowledgeSignalRadar: string;
    techRadar: string;
  };
  artifactsLabel: string;
  defaultModeLabel: string;
  dialogDescription: string;
  dialogTitle: string;
  emptyLabel: string;
  enterLabel: string;
  footerHint: string;
  fitLabel: string;
  groups: Record<PaletteGroupKey, string>;
  inputPlaceholder: string;
  items: PaletteItem[];
  latencyLabel: string;
  metricsLabel: string;
  navigatingLabel: string;
  runTerminalLabel: string;
  searchingLabel: string;
  selectLabel: string;
  sourcesLabel: string;
  stepsLabel: string;
  terminalEmptyLabel: string;
  terminalFooterHint: string;
  terminalModeLabel: string;
  terminalPlaceholder: string;
  terminalReadyLabel: string;
}

const commandPaletteCopyByLocale: LocalizedValue<CommandPaletteCopy> = {
  zh: {
    aiResponseLabel: "AI 响应",
    aiSuggestionLabel: "AI 推荐",
    askAiLabel: "跳转到首个匹配结果",
    artifactKindLabels: {
      executionReview: "执行审阅",
      knowledgeSignalRadar: "知识信号雷达",
      techRadar: "技术雷达",
    },
    artifactsLabel: "ARTIFACTS",
    defaultModeLabel: "标准模式",
    dialogDescription: "搜索首页能力矩阵、典型场景、关于、演进、Lab 或终端页；外链为 GitHub、版本发布与快速上手。",
    dialogTitle: "EvoFlow 命令面板",
    emptyLabel: "没有匹配结果，试试其它关键词。",
    enterLabel: "回车",
    footerHint: "按 Ctrl / Cmd + K 随时唤起",
    fitLabel: "匹配",
    groups: {
      links: "外部链接",
      pages: "页面",
    },
    inputPlaceholder: "搜索页面或链接…",
    items: [
      {
        description: "返回首页与能力总览",
        group: "pages",
        id: "page-home",
        keywords: ["首页", "home", "hero", "capabilities"],
        label: "首页",
        type: "route",
        url: "/",
      },
      {
        description: "跳转到能力矩阵锚点",
        group: "pages",
        id: "page-capabilities",
        keywords: ["能力", "capabilities", "matrix"],
        label: "能力矩阵",
        type: "route",
        url: "/#capabilities",
      },
      {
        description: "工单、运维、Copilot、企业 RAG 等典型落地叙事",
        group: "pages",
        id: "page-scenarios",
        keywords: ["场景", "scenarios", "用例", "落地", "工单", "运维"],
        label: "典型场景",
        type: "route",
        url: "/#scenarios",
      },
      {
        description: "关于 EvoFlow 项目",
        group: "pages",
        id: "page-about",
        keywords: ["about", "关于", "项目"],
        label: "关于",
        type: "route",
        url: "/about",
      },
      {
        description: "版本与能力演进时间线",
        group: "pages",
        id: "page-evolution",
        keywords: ["evolution", "timeline", "进化", "路线"],
        label: "演进日志",
        type: "route",
        url: "/evolution",
      },
      {
        description: "实验与展示页",
        group: "pages",
        id: "page-lab",
        keywords: ["lab", "实验"],
        label: "Lab",
        type: "route",
        url: "/lab",
      },
      {
        description: "复古终端导航",
        group: "pages",
        id: "page-terminal",
        keywords: ["terminal", "终端", "shell"],
        label: "终端",
        type: "route",
        url: "/terminal",
      },
      {
        description: "Issue、讨论区、发行说明与仓库入口",
        group: "links",
        id: "link-github",
        keywords: ["github", "source", "code", "仓库", "协作", "star"],
        label: "GitHub",
        type: "external",
        url: siteLinks.github,
      },
      {
        description: "站内文档：快速开始、概念与架构",
        group: "pages",
        id: "page-docs",
        keywords: ["docs", "文档", "说明", "getting started"],
        label: "文档",
        type: "route",
        url: siteLinks.docsSite,
      },
      {
        description: "发行说明、安装包与构建产物",
        group: "links",
        id: "link-releases",
        keywords: ["release", "发行版", "版本", "download", "下载"],
        label: "下载与发行版",
        type: "external",
        url: siteLinks.blog,
      },
      {
        description: "愿景、快速开始与架构说明",
        group: "links",
        id: "link-readme",
        keywords: ["readme", "文档", "开始", "上手"],
        label: "快速上手",
        type: "external",
        url: siteLinks.source,
      },
    ],
    latencyLabel: "延迟",
    metricsLabel: "指标",
    navigatingLabel: "导航",
    runTerminalLabel: "跳转到首个匹配结果",
    searchingLabel: "正在筛选匹配项…",
    selectLabel: "选择",
    sourcesLabel: "来源",
    stepsLabel: "步骤",
    terminalEmptyLabel: "终端模式下列出可用路由预览。",
    terminalFooterHint: "终端模式同样用于导航，回车跳转到首个匹配项",
    terminalModeLabel: "终端模式",
    terminalPlaceholder: "筛选路由，例如：evolution",
    terminalReadyLabel: "终端模式已就绪",
  },
  en: {
    aiResponseLabel: "AI RESPONSE",
    aiSuggestionLabel: "AI SUGGEST",
    askAiLabel: "Open first matching result",
    artifactKindLabels: {
      executionReview: "Execution Review",
      knowledgeSignalRadar: "Knowledge Signal Radar",
      techRadar: "Tech Radar",
    },
    artifactsLabel: "ARTIFACTS",
    defaultModeLabel: "Default Mode",
    dialogDescription:
      "Search the capability matrix, scenarios, About, Evolution, Lab, or Terminal; external links for source, releases, and quickstart.",
    dialogTitle: "EvoFlow command palette",
    emptyLabel: "No matches — try different keywords.",
    enterLabel: "Enter",
    footerHint: "Press Ctrl / Cmd + K anytime",
    fitLabel: "Fit",
    groups: {
      links: "External Links",
      pages: "Pages",
    },
    inputPlaceholder: "Search pages or links…",
    items: [
      {
        description: "Homepage and capability overview",
        group: "pages",
        id: "page-home",
        keywords: ["home", "hero", "capabilities"],
        label: "Home",
        type: "route",
        url: "/",
      },
      {
        description: "Scroll to the capability matrix",
        group: "pages",
        id: "page-capabilities",
        keywords: ["capabilities", "matrix", "skills"],
        label: "Capabilities",
        type: "route",
        url: "/#capabilities",
      },
      {
        description: "Tickets, ops, copilots, enterprise RAG adoption narratives",
        group: "pages",
        id: "page-scenarios",
        keywords: ["scenarios", "use cases", "tickets", "ops", "rag"],
        label: "Scenarios",
        type: "route",
        url: "/#scenarios",
      },
      {
        description: "About the EvoFlow project",
        group: "pages",
        id: "page-about",
        keywords: ["about", "project"],
        label: "About",
        type: "route",
        url: "/about",
      },
      {
        description: "Release and roadmap timeline",
        group: "pages",
        id: "page-evolution",
        keywords: ["evolution", "timeline", "roadmap"],
        label: "Evolution",
        type: "route",
        url: "/evolution",
      },
      {
        description: "Experiment lab pages",
        group: "pages",
        id: "page-lab",
        keywords: ["lab", "experiments"],
        label: "Lab",
        type: "route",
        url: "/lab",
      },
      {
        description: "Retro terminal navigation",
        group: "pages",
        id: "page-terminal",
        keywords: ["terminal", "shell"],
        label: "Terminal",
        type: "route",
        url: "/terminal",
      },
      {
        description: "Issues, discussions, releases, and the repository",
        group: "links",
        id: "link-github",
        keywords: ["github", "source", "code", "collab", "star"],
        label: "GitHub",
        type: "external",
        url: siteLinks.github,
      },
      {
        description: "On-site docs: getting started, concepts, architecture",
        group: "pages",
        id: "page-docs",
        keywords: ["docs", "documentation", "readme", "getting started"],
        label: "Documentation",
        type: "route",
        url: siteLinks.docsSite,
      },
      {
        description: "Release notes, binaries, and build artifacts",
        group: "links",
        id: "link-releases",
        keywords: ["release", "version", "download"],
        label: "Downloads & releases",
        type: "external",
        url: siteLinks.blog,
      },
      {
        description: "Vision, quickstart, and architecture notes",
        group: "links",
        id: "link-readme",
        keywords: ["readme", "docs", "quickstart"],
        label: "Quickstart",
        type: "external",
        url: siteLinks.source,
      },
    ],
    latencyLabel: "Latency",
    metricsLabel: "Metrics",
    navigatingLabel: "Navigate",
    runTerminalLabel: "Open first matching result",
    searchingLabel: "Querying neural index...",
    selectLabel: "Select",
    sourcesLabel: "Sources",
    stepsLabel: "Steps",
    terminalEmptyLabel: "Terminal mode shows a route preview.",
    terminalFooterHint: "Terminal mode is still for navigation — Enter opens the first match",
    terminalModeLabel: "Terminal Mode",
    terminalPlaceholder: "Filter routes, e.g. evolution",
    terminalReadyLabel: "Terminal mode armed",
  },
};

function matchesPaletteItem(item: PaletteItem, query: string) {
  if (!query) {
    return true;
  }

  const normalizedQuery = query.toLowerCase();
  return [item.label, item.description, item.url, ...item.keywords].some((value) =>
    value.toLowerCase().includes(normalizedQuery),
  );
}

function buildTerminalPreview(items: PaletteItem[], query: string) {
  const rows = items.slice(0, 4).map((item) => {
    const type = item.type === "route" ? "ROUTE" : "LINK ";
    const label = item.label.padEnd(20, " ").slice(0, 20);
    const target = item.url.padEnd(28, " ").slice(0, 28);

    return `| ${type} | ${label} | ${target} |`;
  });

  return [
    "+----------------------------------------------------------------+",
    "| TYPE  | TARGET               | RESOLVE                         |",
    "+----------------------------------------------------------------+",
    ...(rows.length
      ? rows
      : ["| IDLE  | waiting_input        | type to filter routes           |"]),
    "+----------------------------------------------------------------+",
    "",
    `[SYSTEM]: ${items.length} commands indexed.`,
    `[QUERY]: ${query || "waiting input"}`,
    "[STATUS]: Terminal navigation mode.",
  ].join("\n");
}

export function SiteCommandPalette({
  onOpenChange,
  open,
}: {
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const copy = useLocalizedValue(commandPaletteCopyByLocale);
  const { locale } = useSiteLocale();
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [mode, setMode] = useState<PaletteMode>("default");

  const trimmedSearch = search.trim();

  const filteredItems = useMemo(() => {
    return copy.items.filter((item) => matchesPaletteItem(item, trimmedSearch));
  }, [copy.items, trimmedSearch]);

  const groupedItems = useMemo(() => {
    return {
      links: filteredItems.filter((item) => item.group === "links"),
      pages: filteredItems.filter((item) => item.group === "pages"),
    };
  }, [filteredItems]);

  function handleSelect(item: PaletteItem) {
    setSearch("");
    onOpenChange(false);

    if (item.type === "external") {
      window.open(item.url, "_blank", "noopener,noreferrer");
      return;
    }

    router.push(staticPageHref(item.url));
  }

  function handleJumpFirstMatch() {
    if (!trimmedSearch || filteredItems.length === 0) {
      return;
    }
    handleSelect(filteredItems[0]!);
  }

  function handleToggleMode() {
    setMode((current) => (current === "default" ? "terminal" : "default"));
  }

  function handleDialogOpenChange(nextOpen: boolean) {
    if (!nextOpen) {
      setSearch("");
      setMode("default");
    }

    onOpenChange(nextOpen);
  }

  return (
    <Command.Dialog
      label="Global command palette"
      onOpenChange={handleDialogOpenChange}
      open={open}
    >
      <div className="fixed inset-0 z-[70] bg-black/60 backdrop-blur-md" />
      <Dialog.Title className="sr-only">{copy.dialogTitle}</Dialog.Title>
      <Dialog.Description className="sr-only">
        {copy.dialogDescription}
      </Dialog.Description>
      <Command
        className={[
          "fixed left-1/2 top-[8vh] z-[80] h-[min(480px,calc(100vh-4rem))] w-[min(600px,calc(100vw-1.5rem))] -translate-x-1/2 overflow-hidden md:top-[16vh]",
          mode === "terminal"
            ? "rounded-[24px] border border-cyan-400/20 bg-black text-cyan-400 shadow-[0_0_30px_rgba(34,211,238,0.2)]"
            : "rounded-[28px] border border-white/10 bg-background/95 shadow-[0_0_80px_-24px_rgba(99,102,241,0.45)]",
        ].join(" ")}
        loop
        shouldFilter={false}
      >
        <div
          className={[
            "flex items-center gap-3 px-5",
            mode === "terminal"
              ? "h-16 border-b border-cyan-900/30 font-mono"
              : "border-b border-white/[0.08] py-4",
          ].join(" ")}
        >
          <span
            className={[
              mode === "terminal" ? "text-cyan-400" : "text-secondary",
              "shrink-0 text-sm",
            ].join(" ")}
          >
            {mode === "terminal" ? "$" : "✦"}
          </span>
          <Command.Input
            className={[
              "w-full bg-transparent outline-none",
              mode === "terminal"
                ? "font-mono text-lg text-cyan-400 placeholder:text-cyan-900/60"
                : "font-body-ui text-base text-foreground placeholder:text-foreground-muted",
            ].join(" ")}
            onValueChange={setSearch}
            placeholder={mode === "terminal" ? copy.terminalPlaceholder : copy.inputPlaceholder}
            value={search}
          />
          <button
            className={[
              "shrink-0 rounded px-2 py-1 text-[10px] uppercase tracking-[0.22em]",
              mode === "terminal"
                ? "border border-cyan-500/30 bg-cyan-500/10 text-cyan-300"
                : "border border-white/[0.08] bg-white/[0.04] text-foreground-muted",
            ].join(" ")}
            onClick={handleToggleMode}
            type="button"
          >
            {mode === "terminal" ? copy.defaultModeLabel : copy.terminalModeLabel}
          </button>
          <span
            className={[
              "shrink-0 rounded px-2 py-1 text-[10px] uppercase tracking-[0.22em]",
              mode === "terminal"
                ? "border border-cyan-900/30 text-cyan-700"
                : "border border-outline-variant/30 bg-surface-low text-foreground-muted",
            ].join(" ")}
          >
            ESC
          </span>
        </div>

        <Command.List
          className={[
            "max-h-[420px] overflow-y-auto",
            mode === "terminal" ? "p-2 font-mono" : "p-3",
          ].join(" ")}
        >
          {trimmedSearch && filteredItems.length > 0 ? (
            <Command.Item
              className={[
                "mb-2 flex cursor-pointer items-start justify-between rounded-[22px] px-4 py-4 text-left outline-none transition-colors",
                mode === "terminal"
                  ? "border border-cyan-500/20 bg-cyan-500/5 data-[selected=true]:bg-cyan-500/10"
                  : "bg-white/[0.04] data-[selected=true]:bg-primary/12",
              ].join(" ")}
              onSelect={handleJumpFirstMatch}
              value={`${mode}-${trimmedSearch}`}
            >
              <div>
                <p
                  className={[
                    "text-base font-semibold tracking-[-0.03em]",
                    mode === "terminal"
                      ? "font-mono text-cyan-300"
                      : "font-display-ui text-primary",
                  ].join(" ")}
                >
                  {copy.askAiLabel}
                </p>
                <p
                  className={[
                    "mt-1 text-sm leading-6",
                    mode === "terminal" ? "font-mono text-cyan-400/70" : "text-foreground-muted",
                  ].join(" ")}
                >
                  {trimmedSearch}
                </p>
              </div>
              <span
                className={[
                  "text-[11px] uppercase tracking-[0.2em]",
                  mode === "terminal" ? "font-mono text-cyan-600" : "font-label-ui text-foreground-muted",
                ].join(" ")}
              >
                {copy.enterLabel}
              </span>
            </Command.Item>
          ) : null}

          {mode === "terminal" ? (
            <div className="mb-3 rounded-[18px] border border-cyan-900/30 bg-black px-4 py-4">
              <pre className="overflow-x-auto text-xs leading-relaxed text-cyan-400">
                {buildTerminalPreview(filteredItems, trimmedSearch)}
              </pre>
              <p className="mt-4 text-sm leading-relaxed text-cyan-400/60">
                {trimmedSearch ? copy.terminalReadyLabel : copy.terminalEmptyLabel}
              </p>
            </div>
          ) : null}

          {filteredItems.length === 0 && !trimmedSearch ? (
            <div className="px-4 py-10 text-center text-sm text-foreground-muted">
              {mode === "terminal" ? copy.terminalEmptyLabel : copy.emptyLabel}
            </div>
          ) : null}

          {filteredItems.length === 0 && trimmedSearch && mode === "default" ? (
            <div className="px-4 py-10 text-center text-sm text-foreground-muted">
              {copy.emptyLabel}
            </div>
          ) : null}

          {/* Easter Egg #3: "hire" keyword */}
          {mode === "default" && /hire|招聘|offer|opportunity|job|work together|合作/i.test(trimmedSearch) ? (
            <Command.Group heading={locale === "zh" ? "🥚 彩蛋" : "🥚 Easter Egg"}>
              <Command.Item
                className="group flex cursor-pointer items-start gap-3 rounded-[20px] px-4 py-3 outline-none data-[selected=true]:bg-white/[0.06]"
                onSelect={() => {
                  window.open(`mailto:${siteIdentity.contactEmail}`, "_blank");
                  setSearch("");
                  onOpenChange(false);
                }}
                value="hire-easter-egg"
              >
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-purple-500/20 via-pink-500/20 to-orange-400/20 text-lg">
                  ✉️
                </div>
                <div className="min-w-0 flex-1">
                  <p className="bg-gradient-to-r from-purple-400 via-pink-400 to-orange-400 bg-clip-text text-sm font-semibold tracking-[-0.02em] text-transparent font-display-ui" style={{ backgroundSize: "200% 200%", animation: "hire-shimmer 2s ease infinite" }}>
                    {locale === "zh" ? "📬 联系我 — 聊聊合作机会" : "📬 Get in touch — Let's talk opportunities"}
                  </p>
                  <p className="mt-1 text-sm leading-6 text-foreground-muted">
                    {locale === "zh"
                      ? "你发现了第 3 个彩蛋 🥚  发个邮件，我会认真回复。"
                      : "You found Easter egg #3 🥚  Send an email, I'll reply thoughtfully."}
                  </p>
                </div>
                <span className="font-label-ui shrink-0 text-[10px] uppercase tracking-[0.18em] text-purple-400/60">
                  {locale === "zh" ? "发送邮件" : "send email"}
                </span>
              </Command.Item>
            </Command.Group>
          ) : null}

          {(Object.keys(groupedItems) as PaletteGroupKey[]).map((groupKey) =>
            groupedItems[groupKey].length ? (
              <Command.Group
                heading={copy.groups[groupKey]}
                key={groupKey}
                className="mb-2"
              >
                {groupedItems[groupKey].map((item) => (
                  <Command.Item
                    className={[
                      "flex cursor-pointer items-start gap-3 outline-none transition-colors",
                      mode === "terminal"
                        ? "rounded-[16px] px-4 py-3 font-mono data-[selected=true]:bg-cyan-500/8"
                        : "rounded-[20px] px-4 py-3 data-[selected=true]:bg-white/[0.06]",
                    ].join(" ")}
                    key={item.id}
                    keywords={item.keywords}
                    onSelect={() => handleSelect(item)}
                    value={item.label}
                  >
                    <div className="min-w-0 flex-1">
                      <p
                        className={[
                          "text-sm font-semibold tracking-[-0.02em]",
                          mode === "terminal"
                            ? "font-mono text-cyan-300"
                            : "font-display-ui text-foreground",
                        ].join(" ")}
                      >
                        {item.label}
                      </p>
                      <p
                        className={[
                          "mt-1 text-sm leading-6",
                          mode === "terminal"
                            ? "font-mono text-cyan-400/70"
                            : "text-foreground-muted",
                        ].join(" ")}
                      >
                        {item.description}
                      </p>
                    </div>
                    <span
                      className={[
                        "shrink-0 text-[10px] uppercase tracking-[0.18em]",
                        mode === "terminal" ? "font-mono text-cyan-700" : "font-label-ui text-foreground-muted/60",
                      ].join(" ")}
                    >
                      {item.type === "route" ? copy.navigatingLabel : copy.selectLabel}
                    </span>
                  </Command.Item>
                ))}
              </Command.Group>
            ) : null,
          )}
        </Command.List>

        <div
          className={[
            "px-5 py-3",
            mode === "terminal"
              ? "border-t border-cyan-900/30"
              : "border-t border-white/[0.08]",
          ].join(" ")}
        >
          <p
            className={[
              "text-[11px] uppercase tracking-[0.24em]",
              mode === "terminal"
                ? "font-mono text-cyan-700"
                : "font-label-ui text-foreground-muted",
            ].join(" ")}
          >
            {mode === "terminal" ? copy.terminalFooterHint : copy.footerHint}
          </p>
        </div>
      </Command>
    </Command.Dialog>
  );
}
