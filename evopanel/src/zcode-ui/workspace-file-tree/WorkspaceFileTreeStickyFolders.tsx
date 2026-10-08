import type { KeyboardEvent } from "react";
import type { WorkspaceFileGitStatus, WorkspaceFileTreeRow } from "@/workspace-file-tree/model.js";
import {
  areWorkspaceFilePathsEqual,
  getWorkspaceDirectoryGitStatuses,
  getWorkspaceFileGitStatus,
  isWorkspaceFileGitIgnored,
} from "@/workspace-file-tree/model.js";
import { WorkspaceFileTreeRowView } from "@/workspace-file-tree/WorkspaceFileTreeRowView.js";
import type {
  WorkspaceFileGitStatusLabels,
  WorkspaceFileTreeContextMenuLabels,
  WorkspaceFileTreeEditorState,
  WorkspaceFileTreeStickyFolderItem,
} from "@/workspace-file-tree/types.js";

export function WorkspaceFileTreeStickyFolders({
  items,
  selectedPath,
  gitStatusByPath,
  ignoredPathSet,
  gitStatusLabelByStatus,
  contextMenuLabels,
  editorState,
  workspacePath,
  workspaceIdentity,
  onSelect,
  onToggleDirectory,
  onRevealRow,
  onOpenPreview,
  onOpenBrowserUrl,
  onKeyDown,
}: {
  items: WorkspaceFileTreeStickyFolderItem[];
  selectedPath: string | null;
  gitStatusByPath: Map<string, WorkspaceFileGitStatus>;
  ignoredPathSet: Set<string>;
  gitStatusLabelByStatus: WorkspaceFileGitStatusLabels;
  contextMenuLabels: WorkspaceFileTreeContextMenuLabels;
  editorState: WorkspaceFileTreeEditorState;
  workspacePath: string;
  workspaceIdentity?: string;
  onSelect: (path: string) => void;
  onToggleDirectory: (row: WorkspaceFileTreeRow) => void;
  onRevealRow: (item: WorkspaceFileTreeStickyFolderItem) => void;
  onOpenPreview: (row: WorkspaceFileTreeRow) => void;
  onOpenBrowserUrl?: (url: string) => void;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>, row: WorkspaceFileTreeRow) => void;
}) {
  if (items.length === 0) {
    return null;
  }

  return (
    <div className="pointer-events-none sticky top-0 z-10 h-0 overflow-visible px-1">
      <div className="pointer-events-auto overflow-hidden rounded-lg">
        {items.map((item) => {
          const row = item.row;
          const handleToggle = (nextRow: WorkspaceFileTreeRow) => {
            onToggleDirectory(nextRow);
            if (nextRow.expanded) {
              requestAnimationFrame(() => onRevealRow(item));
            }
          };
          return (
            <WorkspaceFileTreeRowView
              key={row.path}
              layout="static"
              row={row}
              selected={selectedPath !== null && areWorkspaceFilePathsEqual(selectedPath, row.path)}
              gitStatus={
                getWorkspaceFileGitStatus(gitStatusByPath, row.path) ??
                (isWorkspaceFileGitIgnored(ignoredPathSet, row.path) ? "ignored" : null)
              }
              directoryGitStatuses={getWorkspaceDirectoryGitStatuses(gitStatusByPath, row.path)}
              gitStatusLabelByStatus={gitStatusLabelByStatus}
              contextMenuLabels={contextMenuLabels}
              canOpenLocalFileManager={editorState.canOpenLocalFileManager}
              installedEditors={editorState.installedEditors}
              isRemoteWorkspaceFileTree={editorState.isRemoteWorkspaceFileTree}
              remoteTarget={editorState.remoteTarget}
              workspacePath={workspacePath}
              workspaceIdentity={workspaceIdentity}
              style={{}}
              onSelect={onSelect}
              onToggleDirectory={handleToggle}
              onOpenPreview={onOpenPreview}
              onOpenBrowserUrl={onOpenBrowserUrl}
              onKeyDown={onKeyDown}
            />
          );
        })}
      </div>
    </div>
  );
}
