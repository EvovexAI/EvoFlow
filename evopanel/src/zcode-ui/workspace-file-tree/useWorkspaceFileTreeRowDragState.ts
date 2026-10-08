import { useEffect, useState } from "react";

export function useWorkspaceFileTreeRowDragState() {
  const [isDragging, setIsDragging] = useState(false);

  useEffect(() => {
    if (!isDragging) {
      return;
    }

    // Electron/浏览器在拖拽离开窗口时不一定向源行派发 dragend。
    // 同时监听全局结束信号，避免竖线在一次异常拖拽后永久隐藏。
    const resetDragging = () => setIsDragging(false);
    window.addEventListener("dragend", resetDragging);
    window.addEventListener("drop", resetDragging);
    window.addEventListener("blur", resetDragging);
    return () => {
      window.removeEventListener("dragend", resetDragging);
      window.removeEventListener("drop", resetDragging);
      window.removeEventListener("blur", resetDragging);
    };
  }, [isDragging]);

  return { isDragging, setIsDragging };
}
