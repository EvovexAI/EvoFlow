/** main 进程采集的四个启动时刻（epoch 毫秒）。renderer 据此计算分阶段耗时。 */
export interface LaunchMarks {
  /** process.getCreationTime()：进程创建（锚点 T0） */
  createdAt: number;
  /** main/index.ts 模块顶部 Date.now()（T1） */
  mainStart: number;
  /** app.whenReady 回调入口 Date.now()（T2） */
  appReady: number;
  /** 主窗口 loadWindow 内 loadURL 前 Date.now()（T3） */
  loadUrl: number;
}

/** 主窗口 loadURL query string 中携带 launch marks 的参数名 */
export const LAUNCH_MARKS_QUERY_KEY = "zcodeLaunchMarks";

export function serializeLaunchMarks(marks: LaunchMarks): string {
  return JSON.stringify(marks);
}

export function parseLaunchMarks(raw: string | null | undefined): LaunchMarks | null {
  if (raw == null || raw === "") {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed == null || typeof parsed !== "object") {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const keys: (keyof LaunchMarks)[] = ["createdAt", "mainStart", "appReady", "loadUrl"];
  const result = {} as LaunchMarks;
  for (const key of keys) {
    const value = record[key];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return null;
    }
    result[key] = value;
  }
  return result;
}
