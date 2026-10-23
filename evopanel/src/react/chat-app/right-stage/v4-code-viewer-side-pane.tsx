// V4CodeViewerSidePane — 右侧面板的 ZCode 代码/patch 查看器（对齐 ZCode 侧栏）。
// 头部：文件图标 + 标题 + 路径；内容：CodeViewer 渲染（patch → diff 红绿高亮）。
// 数据来自 ZCode 工具卡的 CodeViewerSource（buildEditCodeViewerSource 产物）。
import { useMemo, useEffect, useState } from "react";
import { CodeViewer } from "@zcode/ui/components/ui/code-viewer.js";
import type { CodeViewerSource } from "@zcode/ui/lib/codeViewer.js";
import { HighlightedLightweightDiffPreview } from "@zcode/ui/components/ui/highlighted-lightweight-diff-preview.js";
import { getPlainTextPatchPreviewLines } from "@zcode/ui/lib/patchDiffPreview.js";
import { inferCodeLanguage } from "@zcode/ui/lib/codeViewer.js";
import { getPathLeaf } from "@zcode/ui/lib/path.js";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@zcode/ui/lib/codePreviewSettings.js";
import { ZCodeIntlProvider } from "@zcode/ui/i18n/IntlProvider.js";
import { enrichPatchWithFileContext } from "@zcode/ui/lib/toolDiffPreview.js";

const EXT_LANGUAGE: Record<string, string> = {
  ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx", mjs: "javascript",
  py: "python", html: "html", css: "css", json: "json", md: "markdown",
  sh: "bash", yml: "yaml", yaml: "yaml", sql: "sql", rs: "rust", go: "go",
};

function inferLanguage(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() || "";
  return EXT_LANGUAGE[ext] ?? "";
}

async function fetchWorkspaceFileText(path: string, threadId?: string): Promise<string> {
  const q = new URLSearchParams({ path });
  if (threadId) q.set("thread_id", threadId);
  const resp = await fetch(`/api/workspaces/serve-file?${q.toString()}`);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.text();
}

export function V4CodeViewerSidePane(props: {
  source: CodeViewerSource;
  /** LangGraph thread id：serve-file 按会话沙箱解析相对路径。 */
  threadId?: string;
  onClose?: () => void;
}): React.JSX.Element {
  const { source, onClose, threadId } = props;

  const { language, title, path } = useMemo(() => {
    if (source.type === "patch") {
      return {
        language: "diff",
        title: source.title || source.path || "代码对比",
        path: source.path ?? "",
      };
    }
    if (source.type === "file") {
      return {
        language: inferLanguage(source.path),
        title: source.title || source.path || "文件",
        path: source.path,
      };
    }
    return { language: "", title: source.title ?? "", path: "" };
  }, [source]);

  const rawPatch = source.type === "patch" ? source.patch : "";

  // type:"file" 源：serve-file 拉文件文本（按会话沙箱解析相对路径）。
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  // type:"patch"：读磁盘文件给 hunk 补前后原文（工具 patch 通常只有 ± 行）。
  const [enrichedPatch, setEnrichedPatch] = useState<string | null>(null);

  useEffect(() => {
    if (source.type !== "file" || !source.path) {
      setFileContent(null);
      setFileError(null);
      return;
    }
    let cancelled = false;
    setFileContent(null);
    setFileError(null);
    void (async () => {
      try {
        const text = await fetchWorkspaceFileText(source.path, threadId);
        if (!cancelled) setFileContent(text);
      } catch (error) {
        if (!cancelled) {
          setFileError(
            `文件加载失败：${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [source.type, source.path, threadId]);

  useEffect(() => {
    if (source.type !== "patch" || !rawPatch) {
      setEnrichedPatch(null);
      return;
    }
    const filePath = String(source.path || "").trim();
    if (!filePath) {
      setEnrichedPatch(rawPatch);
      return;
    }
    let cancelled = false;
    setEnrichedPatch(null);
    void (async () => {
      try {
        const text = await fetchWorkspaceFileText(filePath, threadId);
        if (cancelled) return;
        const label = getPathLeaf(filePath) || "preview";
        setEnrichedPatch(enrichPatchWithFileContext(rawPatch, text, label));
      } catch {
        // 读文件失败时仍展示原始工具 patch，不挡审核。
        if (!cancelled) setEnrichedPatch(rawPatch);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [source.type, source.path, rawPatch, threadId]);

  const highlightTheme = useMemo(() => {
    if (typeof window === "undefined") return DEFAULT_CODE_PREVIEW_SETTINGS.lightTheme;
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? DEFAULT_CODE_PREVIEW_SETTINGS.darkTheme
      : DEFAULT_CODE_PREVIEW_SETTINGS.lightTheme;
  }, []);

  const patchForPreview = enrichedPatch ?? rawPatch;
  const patchLines = useMemo(
    () => (patchForPreview ? getPlainTextPatchPreviewLines(patchForPreview) : []),
    [patchForPreview],
  );

  // 右侧 stage 不在 V4ZCodeTimeline 的 Intl 树下；LightweightDiffPreview
  // 用 useZCodeIntl 渲染截断文案，必须在此自挂 Provider，否则点开 diff 直接炸。
  return (
    <ZCodeIntlProvider initialLocale="zh-CN">
      <div className="flex h-full min-h-0 flex-col bg-card">
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
          <span className="min-w-0 truncate text-ui-sm font-medium text-foreground">{title}</span>
          {path ? (
            <span className="min-w-0 truncate text-xs text-foreground-subtlest">{path}</span>
          ) : null}
          <div className="flex-1" />
          {onClose ? (
            <button
              type="button"
              className="rounded p-1 text-foreground-subtlest hover:bg-hover"
              onClick={onClose}
              aria-label="关闭"
            >
              ✕
            </button>
          ) : null}
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          {source.type === "patch" ? (
            enrichedPatch == null ? (
              <div className="flex h-full items-center justify-center text-ui-sm text-foreground-subtlest">
                正在加载上下文…
              </div>
            ) : (
              <HighlightedLightweightDiffPreview
                className="h-full bg-card"
                codePreviewSettings={DEFAULT_CODE_PREVIEW_SETTINGS}
                language={inferCodeLanguage(source.path ?? source.title, patchForPreview)}
                lines={patchLines}
                path={source.path ?? source.title}
                theme={highlightTheme}
              />
            )
          ) : source.type === "file" ? (
            fileContent != null ? (
              <CodeViewer
                code={fileContent}
                language={language}
                showLineNumbers
                fontSizePx={12}
              />
            ) : (
              <div className="flex h-full items-center justify-center text-ui-sm text-foreground-subtlest">
                {fileError || "正在加载文件…"}
              </div>
            )
          ) : null}
        </div>
      </div>
    </ZCodeIntlProvider>
  );
}
