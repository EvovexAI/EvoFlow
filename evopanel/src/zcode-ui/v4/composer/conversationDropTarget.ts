import type { DragEventHandler } from "react";

/**
 * ConversationComposer 暴露给外层对话表面的文件 drop 接口。
 *
 * controller 只在 renderer 内路由到既有 composer；不创建第二个上传状态机，
 * 也不改变 desktop continuous / web-remote-replayable 的传输边界。
 */
export interface ConversationDropTargetController {
  active: boolean;
  kind: "attachment" | "workspace" | null;
  onDragOver: DragEventHandler<HTMLElement>;
  onDragLeave: DragEventHandler<HTMLElement>;
  onDrop: DragEventHandler<HTMLElement>;
}
