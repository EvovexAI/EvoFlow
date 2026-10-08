import { useEffect, useRef, useState } from "react";
import {
  hasWorkspaceFileDragPayload,
  isWorkspaceFileDragStateEvent,
  WORKSPACE_FILE_DRAG_STATE_EVENT,
} from "@/lib/workspaceFileDrag.js";

function hasExternalFileDrag(dataTransfer: DataTransfer): boolean {
  return (
    Array.from(dataTransfer.types).includes("Files") ||
    Array.from(dataTransfer.items ?? []).some((item) => item.kind === "file")
  );
}

export function usePromptEditorDragState({
  enableWorkspaceFileDrop,
  enableExternalFileDrop,
}: {
  enableWorkspaceFileDrop: boolean;
  enableExternalFileDrop: boolean;
}) {
  const [internalDragging, setInternalDragging] = useState(false);
  const [workspaceFileDragging, setWorkspaceFileDragging] = useState(false);
  const [externalFileDragging, setExternalFileDragging] = useState(false);
  const resetDragFeedbackTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if ((!enableWorkspaceFileDrop && !enableExternalFileDrop) || typeof window === "undefined") {
      setWorkspaceFileDragging(false);
      setExternalFileDragging(false);
      return;
    }

    const clearResetDragFeedbackTimer = () => {
      if (resetDragFeedbackTimerRef.current === null) {
        return;
      }

      window.clearTimeout(resetDragFeedbackTimerRef.current);
      resetDragFeedbackTimerRef.current = null;
    };
    const resetDragFeedback = () => {
      clearResetDragFeedbackTimer();
      setWorkspaceFileDragging(false);
      setExternalFileDragging(false);
      setInternalDragging(false);
    };
    const scheduleDragFeedbackReset = () => {
      clearResetDragFeedbackTimer();
      // 取消 OS 文件拖拽或把 file tree 拖拽拖出窗口时，Electron/浏览器不一定派发 drop/dragend。
      // dragover 在拖拽仍停留窗口内时会持续触发；一旦心跳停止，就主动撤销输入框高亮，避免视觉反馈卡住。
      resetDragFeedbackTimerRef.current = window.setTimeout(resetDragFeedback, 300);
    };
    const handleWorkspaceFileDragState = (event: Event) => {
      if (isWorkspaceFileDragStateEvent(event)) {
        setWorkspaceFileDragging(event.detail.dragging);
        if (event.detail.dragging) {
          scheduleDragFeedbackReset();
        } else {
          resetDragFeedback();
        }
      }
    };
    const handleGlobalDragOver = (event: DragEvent) => {
      if (!event.dataTransfer) {
        return;
      }
      // 有些拖拽路径不会先触发目标输入框的 dragover。
      // 监听窗口级 dragover 后，只要拖拽数据可识别，就提前亮出所有可投放输入框。
      if (enableWorkspaceFileDrop && hasWorkspaceFileDragPayload(event.dataTransfer)) {
        setWorkspaceFileDragging(true);
        scheduleDragFeedbackReset();
      } else if (enableExternalFileDrop && hasExternalFileDrag(event.dataTransfer)) {
        setExternalFileDragging(true);
        scheduleDragFeedbackReset();
      }
    };
    const handleDocumentDragLeave = (event: DragEvent) => {
      if (event.relatedTarget !== null) {
        return;
      }

      resetDragFeedback();
    };

    window.addEventListener(WORKSPACE_FILE_DRAG_STATE_EVENT, handleWorkspaceFileDragState);
    window.addEventListener("dragover", handleGlobalDragOver);
    window.addEventListener("dragend", resetDragFeedback);
    window.addEventListener("drop", resetDragFeedback);
    window.addEventListener("blur", resetDragFeedback);
    if (typeof document !== "undefined") {
      document.addEventListener("dragleave", handleDocumentDragLeave);
    }
    return () => {
      clearResetDragFeedbackTimer();
      window.removeEventListener(WORKSPACE_FILE_DRAG_STATE_EVENT, handleWorkspaceFileDragState);
      window.removeEventListener("dragover", handleGlobalDragOver);
      window.removeEventListener("dragend", resetDragFeedback);
      window.removeEventListener("drop", resetDragFeedback);
      window.removeEventListener("blur", resetDragFeedback);
      if (typeof document !== "undefined") {
        document.removeEventListener("dragleave", handleDocumentDragLeave);
      }
    };
  }, [enableExternalFileDrop, enableWorkspaceFileDrop]);

  return {
    externalFileDragging,
    internalDragging,
    setExternalFileDragging,
    setInternalDragging,
    setWorkspaceFileDragging,
    workspaceFileDragging,
  };
}
