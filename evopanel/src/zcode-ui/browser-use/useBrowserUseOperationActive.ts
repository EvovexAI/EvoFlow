import { useEffect, useState } from "react";

/**
 * 复用 browser-use tab 鼠标图标的 5 秒 operation deadline。
 * 图标和浏览器内提示必须共用这一个判断，避免出现一边认为工具仍在执行、另一边已经结束。
 */
export function useBrowserUseOperationActive(operationUntil = 0): boolean {
  const [expiredOperationUntil, setExpiredOperationUntil] = useState(0);
  const isActive = operationUntil > Date.now() && expiredOperationUntil !== operationUntil;

  useEffect(() => {
    const remainingMs = operationUntil - Date.now();
    if (remainingMs <= 0) return;
    const timer = window.setTimeout(() => setExpiredOperationUntil(operationUntil), remainingMs);
    return () => window.clearTimeout(timer);
  }, [operationUntil]);

  return isActive;
}
