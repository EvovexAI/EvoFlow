import type { PaneSplitSide } from "@/v4/paneLayoutTree.js";
import { resolveWorkbenchDropSide } from "@/v4/workbenchDragDrop.js";
import type { WorkbenchSessionDragPayload } from "@/v4/workbenchDragDrop.js";

interface WorkbenchPointerDropTargetController {
  canDrop?: (payload: WorkbenchSessionDragPayload) => boolean;
  onDrop: (side: PaneSplitSide, payload: WorkbenchSessionDragPayload) => void;
  onPreview: (side: PaneSplitSide | null) => void;
}

interface WorkbenchPointerDropTarget {
  controller: WorkbenchPointerDropTargetController;
  element: HTMLElement;
}

const targets = new Set<WorkbenchPointerDropTarget>();
let previewedTarget: WorkbenchPointerDropTarget | null = null;

function clearPreview(): void {
  previewedTarget?.controller.onPreview(null);
  previewedTarget = null;
}

function resolveTarget(
  payload: WorkbenchSessionDragPayload,
  clientX: number,
  clientY: number,
): { side: PaneSplitSide; target: WorkbenchPointerDropTarget } | null {
  for (const target of targets) {
    if (target.controller.canDrop && !target.controller.canDrop(payload)) {
      continue;
    }
    const side = resolveWorkbenchDropSide(target.element.getBoundingClientRect(), clientX, clientY);
    if (side) {
      return { side, target };
    }
  }
  return null;
}

function registerWorkbenchPointerDropTarget(
  element: HTMLElement,
  controller: WorkbenchPointerDropTargetController,
): () => void {
  const target = { controller, element };
  targets.add(target);
  return () => {
    if (previewedTarget === target) {
      clearPreview();
    }
    targets.delete(target);
  };
}

function updateWorkbenchPointerDrag(
  payload: WorkbenchSessionDragPayload,
  clientX: number,
  clientY: number,
): boolean {
  const resolved = resolveTarget(payload, clientX, clientY);
  if (!resolved) {
    clearPreview();
    return false;
  }
  if (previewedTarget !== resolved.target) {
    clearPreview();
    previewedTarget = resolved.target;
  }
  resolved.target.controller.onPreview(resolved.side);
  return true;
}

function finishWorkbenchPointerDrag(
  payload: WorkbenchSessionDragPayload,
  clientX: number,
  clientY: number,
): boolean {
  const resolved = resolveTarget(payload, clientX, clientY);
  clearPreview();
  if (!resolved) {
    return false;
  }
  resolved.target.controller.onDrop(resolved.side, payload);
  return true;
}

function cancelWorkbenchPointerDrag(): void {
  clearPreview();
}

export {
  cancelWorkbenchPointerDrag,
  finishWorkbenchPointerDrag,
  registerWorkbenchPointerDropTarget,
  updateWorkbenchPointerDrag,
};
