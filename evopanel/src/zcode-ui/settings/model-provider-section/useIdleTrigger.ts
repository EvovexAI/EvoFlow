import { useCallback, useEffect, useRef, useState } from "react";

const MODEL_PROVIDER_TEXT_IDLE_TRIGGER_MS = 1_200;

/**
 * Provider 文本保存与 Model Config Resolution 共用的“停止输入后执行”调度器。
 * 新输入只替换尚未执行的计时器；blur/Enter/save 通过 flush 立即执行同一动作。
 */
export function useIdleTrigger<TResult>(
  action: () => TResult | Promise<TResult>,
  delayMs = MODEL_PROVIDER_TEXT_IDLE_TRIGGER_MS,
) {
  const actionRef = useRef(action);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [scheduled, setScheduled] = useState(false);
  actionRef.current = action;

  const cancel = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    setScheduled(false);
  }, []);

  const flush = useCallback(async (): Promise<TResult> => {
    cancel();
    return actionRef.current();
  }, [cancel]);

  const schedule = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setScheduled(true);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      setScheduled(false);
      // Idle 动作的失败由所属表单在下一次 blur/save 时显式呈现；定时器本身不能制造
      // unhandled rejection，否则一次解析失败会污染整个 Renderer 调试链路。
      try {
        void Promise.resolve(actionRef.current()).catch(() => undefined);
      } catch {
        // 同步失败也留给所属表单在显式 flush 时呈现。
      }
    }, delayMs);
  }, [delayMs]);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = null;
    },
    [],
  );

  return { cancel, flush, schedule, scheduled } as const;
}
