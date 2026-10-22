// V4CodeViewerSidePane — 右侧面板的 ZCode 代码/patch 查看器（对齐 ZCode 侧栏）。
// 头部：文件图标 + 标题 + 路径；内容：CodeViewer 渲染（patch → diff 红绿高亮）。
// 数据来自 ZCode 工具卡的 CodeViewerSource（buildEditCodeViewerSource 产物）。
import { useMemo } from "react";
import { CodeViewer } from "@zcode/ui/components/ui/code-viewer.js";
import type { CodeViewerSource } from "@zcode/ui/lib/codeViewer.js";

export function V4CodeViewerSidePane(props: {
  source: CodeViewerSource;
  onClose?: () => void;
}): React.JSX.Element {
  const { source, onClose } = props;

  const { code, language, firstLineNumber, title, path } = useMemo(() => {
    if (source.type === "patch") {
      return {
        code: source.patch,
        language: "diff",
        firstLineNumber: 1,
        title: source.title || source.path || "代码对比",
        path: source.path ?? "",
      };
    }
    if (source.type === "file") {
      return {
        code: "",
        language: "",
        firstLineNumber: 1,
        title: source.title || source.path || "文件",
        path: source.path,
      };
    }
    return { code: "", language: "", firstLineNumber: 1, title: source.title ?? "", path: "" };
  }, [source]);

  return (
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
          <CodeViewer
            code={code}
            language={language}
            showLineNumbers
            fontSizePx={12}
            firstLineNumber={firstLineNumber}
          />
        ) : (
          <div className="flex h-full items-center justify-center px-4 text-center text-ui-sm text-foreground-subtlest">
            该文件暂无可展示的 diff 内容（v1 仅支持 patch 对比视图）
          </div>
        )}
      </div>
    </div>
  );
}
