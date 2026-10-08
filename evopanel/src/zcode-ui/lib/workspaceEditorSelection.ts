import type { EditorInfo, OpenInEditorRemoteTarget, RemoteTarget } from "@zcode/shared";
import { sortInstalledEditorsForOpenWith } from "@/lib/openWithEditors.js";

const REMOTE_SSH_EDITOR_IDS = ["vscode", "vscode-insiders"];
const REMOTE_WSL_EDITOR_IDS = ["vscode", "vscode-insiders", "explorer"];

type WorkspaceEditorSelectionKind = "preferred" | "fallback" | "empty" | "explicit";

interface WorkspaceEditorSelectionState {
  availableEditors: EditorInfo[];
  selectedEditor: EditorInfo | null;
  selectionKind: Exclude<WorkspaceEditorSelectionKind, "explicit">;
}

export function resolveWorkspaceFileManagerEditor(
  availableEditors: EditorInfo[],
  remoteTarget?: RemoteTarget | OpenInEditorRemoteTarget,
): EditorInfo | null {
  // WSL 的 Explorer 已具备 UNC 映射能力，“在资源管理器中打开”应与
  // “打开方式 → 资源管理器”复用同一个编辑器入口；SSH/Docker 仍保持失败关闭。
  if (remoteTarget?.kind !== "wsl") {
    return null;
  }
  return availableEditors.find((editor) => editor.id === "explorer") ?? null;
}

function filterEditorsByIdOrder(
  installedEditors: EditorInfo[],
  orderedIds: string[],
): EditorInfo[] {
  return orderedIds
    .map((id) => installedEditors.find((editor) => editor.id === id) ?? null)
    .filter((editor): editor is EditorInfo => editor !== null);
}

export function resolveWorkspaceEditorSelection({
  installedEditors,
  selectedEditorId,
  remoteTarget,
}: {
  installedEditors: EditorInfo[];
  selectedEditorId: string | null;
  remoteTarget?: RemoteTarget | OpenInEditorRemoteTarget;
}): WorkspaceEditorSelectionState {
  let availableEditors: EditorInfo[];

  if (remoteTarget?.kind === "ssh") {
    // SSH 工作区路径只在远端存在，Finder/Explorer/Terminal 这类本地 App
    // 不能直接打开 `/root/...`，否则会落到本机不存在或错误的目录。
    availableEditors = filterEditorsByIdOrder(installedEditors, REMOTE_SSH_EDITOR_IDS);
  } else if (remoteTarget?.kind === "wsl") {
    // WSL workspacePath 是 Linux 路径，只有 VS Code Remote-WSL 和 Windows 资源管理器 UNC
    // 边界能正确消费；其它本机编辑器不能继续裸接 `/home/...`。
    availableEditors = filterEditorsByIdOrder(installedEditors, REMOTE_WSL_EDITOR_IDS);
  } else if (remoteTarget) {
    // Docker 等远程路径没有可供本机编辑器消费的 URI/UNC 映射；
    // 继续展示本机应用只会把 Linux path 当成本地路径，必须在能力选择层失败关闭。
    availableEditors = [];
  } else {
    availableEditors = sortInstalledEditorsForOpenWith(installedEditors);
  }
  const preferredEditor =
    selectedEditorId === null
      ? null
      : (availableEditors.find((editor) => editor.id === selectedEditorId) ?? null);
  const fallbackEditor = availableEditors[0] ?? null;

  if (preferredEditor) {
    return {
      availableEditors,
      selectedEditor: preferredEditor,
      selectionKind: "preferred",
    };
  }

  return {
    availableEditors,
    selectedEditor: fallbackEditor,
    selectionKind: fallbackEditor ? "fallback" : "empty",
  };
}

export function shouldPersistWorkspaceEditorSelection(
  selectionKind: WorkspaceEditorSelectionKind,
): boolean {
  // SSH 工作区可能因为过滤本地 App 自动 fallback 到 VS Code。
  // 这种 fallback 不是用户显式选择，不能覆盖本地工作区继续使用的全局编辑器偏好。
  return selectionKind === "explicit";
}
