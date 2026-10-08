import type { LaunchMarks } from "@zcode/shared";

export function shouldReportLaunchToInput(state: {
  isStartupRenderBlocked: boolean;
  welcomeScreenOpen: boolean;
  alreadyReported: boolean;
}): boolean {
  // 门禁清除 = RootStartupLoading 退场、输入框挂载;welcome 时虽门禁清除但显示登录页、无输入框,不算"能输入"。
  return !state.alreadyReported && !state.isStartupRenderBlocked && !state.welcomeScreenOpen;
}

export function readRendererLaunchTimings(): {
  marks: LaunchMarks | null;
  rendererStart: number;
  reactCommit: number;
} | null {
  const w = window as Window & {
    __ZCODE_LAUNCH_MARKS__?: LaunchMarks | null;
    __ZCODE_RENDERER_START__?: number;
    __ZCODE_REACT_COMMIT_AT__?: number;
  };
  const rendererStart = w.__ZCODE_RENDERER_START__;
  const reactCommit = w.__ZCODE_REACT_COMMIT_AT__;
  if (typeof rendererStart !== "number" || typeof reactCommit !== "number") {
    return null;
  }
  return { marks: w.__ZCODE_LAUNCH_MARKS__ ?? null, rendererStart, reactCommit };
}
