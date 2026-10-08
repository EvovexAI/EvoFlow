import { execFile } from "node:child_process";
import type { WindowsTaskkillRunner } from "#src/process/processTreeTypes.js";

export const defaultWindowsTaskkillRunner: WindowsTaskkillRunner = ({ force, pid, timeoutMs }) =>
  new Promise((resolve) => {
    // 多个 workspace 退出时，同步 taskkill 会按 Agent 数量串行阻塞 Host。
    // 异步 runner 让进程树并发收口，并把命令完成结果交给等待式状态机观察。
    execFile(
      "taskkill",
      ["/PID", String(pid), "/T", ...(force ? ["/F"] : [])],
      { encoding: "utf8", timeout: timeoutMs, windowsHide: true },
      (error, _stdout, stderr) => {
        resolve({ ...(error ? { error } : {}), ...(stderr ? { stderr } : {}) });
      },
    );
  });
