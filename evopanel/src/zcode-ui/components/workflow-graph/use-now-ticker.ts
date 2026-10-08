import { useEffect, useState } from "react";

/** 倒计时的自然粒度：秒级文案再快一格文字也不会变。 */
export const NOW_TICKER_INTERVAL_MS = 1_000;

/**
 * 一个只在 `active` 时走的"现在"。
 *
 * 为什么不靠投影更新顺手重算：一个在退避等待 provider 的 ask **恰恰不发事件**，靠事件驱动的
 * 读数会一直停在收到那一刻的秒数。定时器只在有倒计时可显示时存在；`active` 一变真先重取一次
 * "现在"，不带着上一段的偏差起步。与 WorkflowRunPendingQuestionsSection 的等待时长同一取向，
 * 只是粒度从 30 秒收到 1 秒——这里显示的是秒。
 */
export function useNowTicker(active: boolean, intervalMs: number = NOW_TICKER_INTERVAL_MS): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [active, intervalMs]);
  return now;
}
