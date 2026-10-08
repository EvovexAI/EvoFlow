import type { ElectronReleaseChannel, Locale } from "./protocol.js";

export interface PostUpdateReleaseNotesPayload {
  version: string;
  title: string;
  markdown: string;
  releaseDate?: string;
  releaseNotesByLocale?: Partial<Record<Locale, { title: string; markdown: string }>>;
}

/**
 * 用户从菜单手动点击"检查更新"后，main 进程回传给 renderer 的结果。
 * Renderer 根据 kind 展示对应的 toast；不要与启动时的自动 check 混用。
 */
export type UpdateCheckResultPayload =
  | { kind: "up-to-date"; currentVersion: string }
  | {
      kind: "available";
      version: string;
      channel?: ElectronReleaseChannel;
      releaseNotes?: PostUpdateReleaseNotesPayload;
    }
  | { kind: "downloading"; version: string }
  | { kind: "already-downloading"; version: string; progress: string }
  | { kind: "ready"; version: string }
  | { kind: "dev-skipped" }
  | { kind: "error"; message: string };

/**
 * 桌面自动更新器的持续状态，用于同步原生菜单和 Windows 自绘标题栏菜单。
 */
export type UpdateStatePayload =
  | { kind: "idle"; enabled: boolean }
  | { kind: "checking"; enabled: boolean }
  | {
      kind: "update-available";
      enabled: boolean;
      version: string;
      channel?: ElectronReleaseChannel;
      releaseNotes?: PostUpdateReleaseNotesPayload;
    }
  | {
      kind: "download-progress";
      enabled: boolean;
      progress: string;
      transferredBytes?: number;
      totalBytes?: number;
      version?: string;
      channel?: ElectronReleaseChannel;
      releaseNotes?: PostUpdateReleaseNotesPayload;
    }
  | {
      kind: "update-downloaded";
      enabled: boolean;
      version: string;
      channel?: ElectronReleaseChannel;
      releaseNotes?: PostUpdateReleaseNotesPayload;
    };
