/**
 * useTerminalService —— 终端服务 hooks
 */
import { useState, useEffect, useCallback, useRef } from "react";
import type { IDisposable } from "@zcode/rpc";
import { logger } from "@/logger.js";
import { useServices } from "./useServices.js";

/**
 * 终端生命周期管理 hook
 *
 * 封装 create/write/resize/dispose 和 onDynamicData/onDynamicExit 事件订阅。
 * 组件卸载时自动清理终端和事件订阅。
 */
export function useTerminal(opts: {
  cols: number;
  rows: number;
  cwd?: string;
  onData?: (data: string) => void;
  onExit?: (code: number) => void;
}) {
  const { terminalService } = useServices();
  const [terminalId, setTerminalId] = useState<string | null>(null);
  const disposablesRef = useRef<IDisposable[]>([]);

  // 保存回调的 ref，避免 effect 重跑
  const onDataRef = useRef(opts.onData);
  onDataRef.current = opts.onData;
  const onExitRef = useRef(opts.onExit);
  onExitRef.current = opts.onExit;

  useEffect(() => {
    let cancelled = false;
    let id: string | null = null;

    terminalService
      .create({ cols: opts.cols, rows: opts.rows, cwd: opts.cwd })
      .then(({ id: newId }) => {
        if (cancelled) {
          terminalService.dispose({ id: newId });
          return;
        }
        id = newId;
        setTerminalId(newId);

        // 订阅终端输出
        const dataSub = terminalService.onDynamicData(newId)((data) => {
          onDataRef.current?.(data);
        });
        disposablesRef.current.push(dataSub);

        // 订阅终端退出
        const exitSub = terminalService.onDynamicExit(newId)((code) => {
          onExitRef.current?.(code);
        });
        disposablesRef.current.push(exitSub);
      })
      .catch((error) => {
        // hook 层之前同样没有处理 create() 失败，任何使用方都会收到未处理 Promise。
        // 这里统一吞掉拒绝态并记录日志，避免调用方在没订阅错误的情况下被全局报错打断。
        if (cancelled) return;
        logger.error("[terminal] failed to create terminal", error);
      });

    return () => {
      cancelled = true;
      for (const d of disposablesRef.current) d.dispose();
      disposablesRef.current = [];
      if (id) terminalService.dispose({ id });
    };
  }, [terminalService, opts.cols, opts.rows, opts.cwd]);

  const write = useCallback(
    (data: string) => {
      if (terminalId) terminalService.write({ id: terminalId, data });
    },
    [terminalService, terminalId],
  );

  const resize = useCallback(
    (cols: number, rows: number) => {
      if (terminalId) terminalService.resize({ id: terminalId, cols, rows });
    },
    [terminalService, terminalId],
  );

  return { terminalId, write, resize };
}
