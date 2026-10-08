import { useEffect, useState } from "react";

export function useRunningBackgroundTaskElapsedClock(runningTaskCount: number) {
  const [now, setNow] = useState(() => Date.now());
  const hasRunningTasks = runningTaskCount > 0;

  useEffect(() => {
    if (!hasRunningTasks) {
      return;
    }

    // 单个任务完成不应重启整组计时器，否则剩余任务的秒数会短暂停顿后跳变。
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);

    return () => {
      clearInterval(timer);
    };
  }, [hasRunningTasks]);

  return now;
}
