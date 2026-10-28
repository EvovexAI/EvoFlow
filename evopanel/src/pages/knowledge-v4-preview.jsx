/**
 * Thin V4 adapters for the owned-knowledge reader:
 * - MessageResponse (same Streamdown stack as chat V4)
 * - WorkspaceFileTree (same panel as workspace-browse), filtered to KB-supported files
 */
import React, { useCallback, useMemo } from "react";
import { findOwnedDocByWorkspacePath } from "../lib/knowledge-owned-path.js";
import {
  isSupportedKnowledgeFile,
  shouldSkipKnowledgeDir,
  shouldSkipKnowledgeFile,
} from "../lib/knowledge-file-filter.js";
import { MessageResponse } from "../zcode-ui/components/ai-elements/message.js";
import { V4WorkspaceFileTreePane } from "../react/chat-app/right-stage/v4-workspace-file-tree-pane.js";
import "@/styles-bridge.css";

export { findOwnedDocByWorkspacePath };

export function KnowledgeV4Markdown({ content, className = "" }) {
  const text = String(content || "");
  return (
    <div
      className={`zcode-bridge-root ko-v4-md ${className}`.trim()}
      data-markdown-preview="true"
      data-testid="ko-v4-md"
    >
      <div className="ko-v4-md__inner">
        <MessageResponse className="min-w-0 break-words" theme="system">
          {text}
        </MessageResponse>
      </div>
    </div>
  );
}

export function KnowledgeV4FileTree({
  workspacePath,
  activePreviewPath = null,
  onOpenFile,
  className = "",
}) {
  const root = String(workspacePath || "").trim();
  const active = useMemo(() => activePreviewPath || null, [activePreviewPath]);
  const acceptFileName = useCallback((fileName) => {
    const name = String(fileName || "");
    if (!name || shouldSkipKnowledgeFile(name)) return false;
    return isSupportedKnowledgeFile(name);
  }, []);
  const acceptDirectoryName = useCallback((dirName) => {
    return !shouldSkipKnowledgeDir(dirName);
  }, []);

  if (!root) {
    return <div className="ko-empty" style={{ padding: 16 }}>未绑定本地文件夹</div>;
  }
  return (
    <div className={`ko-zcode-file-tree zcode-bridge-root h-full min-h-0 ${className}`.trim()}>
      <V4WorkspaceFileTreePane
        workspacePath={root}
        activePreviewPath={active}
        acceptFileName={acceptFileName}
        acceptDirectoryName={acceptDirectoryName}
        hideEmptyDirectories
        onClose={() => {}}
        onOpenCodeViewer={(source) => {
          const path =
            source && typeof source === "object"
              ? String(source.path || source.filePath || source.absolutePath || "")
              : "";
          if (!path) return;
          const leaf = path.replace(/\\/g, "/").split("/").pop() || "";
          if (!acceptFileName(leaf)) return;
          onOpenFile?.(path, source);
        }}
      />
    </div>
  );
}
