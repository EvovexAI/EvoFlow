import type { PptxCodeViewerSource, PptxReferencePreviewNavigation } from "@/lib/codeViewer.js";
import {
  isPptxElementReferenceInWorkspaceScope,
  type PptxElementReference,
} from "@/lib/pptxElementReference.js";
import { isWorkspaceFilePathInside } from "@/workspace-file-tree/model.js";

interface PptxElementReferencePreviewScope {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}

function createPptxReferencePreviewNavigation(
  reference: PptxElementReference,
): PptxReferencePreviewNavigation {
  const requestId =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `pptx-preview-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    requestId,
    pageIndex: reference.slideIndex,
    expectedSourceFingerprint: reference.sourceFingerprint,
  };
}

export function createPptxElementReferencePreviewSource(
  reference: PptxElementReference,
  scope: PptxElementReferencePreviewScope,
): PptxCodeViewerSource | null {
  if (
    !isPptxElementReferenceInWorkspaceScope(reference, scope) ||
    !isWorkspaceFilePathInside(reference.workspacePath, reference.sourcePath)
  ) {
    return null;
  }

  return {
    type: "pptx",
    title: reference.sourceTitle,
    path: reference.sourcePath,
    workspacePath: reference.workspacePath,
    ...(reference.workspaceIdentity ? { workspaceIdentity: reference.workspaceIdentity } : {}),
    ...(reference.remoteSessionId ? { workspaceRemoteSessionId: reference.remoteSessionId } : {}),
    referenceNavigation: createPptxReferencePreviewNavigation(reference),
  };
}
