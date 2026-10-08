const WORKSPACE_SIDEBAR_RESIZING_ATTR = "data-workspace-sidebar-resizing";
const WORKSPACE_SIDEBAR_RESIZE_END_EVENT = "zcode:workspace-sidebar-resize-end";

const WORKSPACE_SIDEBAR_RESIZING_VALUE = "true";

type WorkspaceResizeStateElement =
  | (Pick<HTMLElement, "removeAttribute" | "setAttribute"> &
      Partial<Pick<HTMLElement, "dispatchEvent">>)
  | null;

export function setWorkspaceSidebarResizeActive({
  active,
  panelElement,
  shellElement,
}: {
  active: boolean;
  panelElement?: WorkspaceResizeStateElement;
  shellElement: WorkspaceResizeStateElement;
}) {
  for (const element of [shellElement, panelElement]) {
    if (!element) {
      continue;
    }

    if (active) {
      element.setAttribute(WORKSPACE_SIDEBAR_RESIZING_ATTR, WORKSPACE_SIDEBAR_RESIZING_VALUE);
    } else {
      element.removeAttribute(WORKSPACE_SIDEBAR_RESIZING_ATTR);
    }
  }

  if (!active && shellElement?.dispatchEvent && typeof Event !== "undefined") {
    shellElement.dispatchEvent(new Event(WORKSPACE_SIDEBAR_RESIZE_END_EVENT));
  }
}
