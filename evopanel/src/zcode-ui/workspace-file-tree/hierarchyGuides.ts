import type { CSSProperties } from "react";

const WORKSPACE_FILE_TREE_HIERARCHY_GUIDE_BACKGROUND =
  "repeating-linear-gradient(to right, transparent 0 calc(0.375rem - 1px), var(--color-border) calc(0.375rem - 1px) 0.375rem, transparent 0.375rem 0.75rem)";

export function getWorkspaceFileTreeHierarchyGuideStyle(depth: number): CSSProperties | null {
  if (depth <= 0) {
    return null;
  }

  return {
    width: `calc(${depth} * 0.75rem)`,
    backgroundImage: WORKSPACE_FILE_TREE_HIERARCHY_GUIDE_BACKGROUND,
  };
}
