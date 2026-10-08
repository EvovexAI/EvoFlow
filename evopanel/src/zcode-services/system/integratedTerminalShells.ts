import { accessSync, constants as fsConstants } from "node:fs";
import { win32 } from "node:path";
import type { IntegratedTerminalShellOption } from "@zcode/shared";

type ExecutableCheck = (path: string) => boolean;

const WINDOWS_GIT_BASH_PATHS = [
  "C:\\Program Files\\Git\\bin\\bash.exe",
  "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
] as const;

export function listIntegratedTerminalShellOptions(options: {
  env: NodeJS.ProcessEnv;
  isExecutable?: ExecutableCheck;
  platform: NodeJS.Platform;
}): IntegratedTerminalShellOption[] {
  if (options.platform !== "win32") {
    return [];
  }

  const shellOptions: IntegratedTerminalShellOption[] = [createCommandPromptOption(options.env)];
  const gitBash = resolveWindowsGitBash(options.env, options.isExecutable);
  if (gitBash) {
    shellOptions.push({
      dialect: "git-bash",
      id: `git-bash:${gitBash.path}`,
      label: "Git Bash",
      path: gitBash.path,
      source: gitBash.source,
    });
  }

  return shellOptions;
}

function createCommandPromptOption(env: NodeJS.ProcessEnv): IntegratedTerminalShellOption {
  const path = getWindowsEnvValue(env, "ComSpec")?.trim() || "cmd.exe";
  return {
    dialect: "cmd",
    id: `cmd:${path}`,
    label: "CMD",
    path,
    source: "system",
  };
}

function resolveWindowsGitBash(
  env: NodeJS.ProcessEnv,
  isExecutable?: ExecutableCheck,
): { path: string; source: "system" | "path" } | undefined {
  for (const candidate of WINDOWS_GIT_BASH_PATHS) {
    if (isExecutableCandidate(candidate, isExecutable)) {
      return { path: candidate, source: "system" };
    }
  }

  const gitExe = windowsExecutableCandidates("git", env).find((candidate) =>
    isExecutableCandidate(candidate, isExecutable),
  );
  if (!gitExe) {
    return undefined;
  }

  const inferred = inferWindowsGitBashPathsFromGitExe(gitExe).find((candidate) =>
    isExecutableCandidate(candidate, isExecutable),
  );
  return inferred ? { path: inferred, source: "path" } : undefined;
}

function inferWindowsGitBashPathsFromGitExe(gitExe: string): string[] {
  const gitDir = win32.dirname(gitExe);
  return [
    win32.normalize(win32.join(gitDir, "..", "bin", "bash.exe")),
    win32.normalize(win32.join(gitDir, "..", "..", "bin", "bash.exe")),
  ];
}

function windowsExecutableCandidates(command: string, env: NodeJS.ProcessEnv): string[] {
  if (/[\\/]/.test(command)) {
    return [command];
  }

  const pathValue = getWindowsEnvValue(env, "PATH");
  if (!pathValue) {
    return [command];
  }

  const extensions = windowsExecutableExtensions(env);
  return pathValue
    .split(win32.delimiter)
    .filter((entry) => entry.trim().length > 0)
    .flatMap((entry) => extensions.map((extension) => win32.join(entry, `${command}${extension}`)));
}

function windowsExecutableExtensions(env: NodeJS.ProcessEnv): string[] {
  const rawExtensions = getWindowsEnvValue(env, "PATHEXT")?.split(win32.delimiter) ?? [
    ".COM",
    ".EXE",
    ".BAT",
    ".CMD",
  ];
  const normalized = rawExtensions
    .map((extension) => extension.trim().toLowerCase())
    .filter((extension) => extension.length > 0);
  return normalized.includes(".exe") ? normalized : [".exe", ...normalized];
}

function getWindowsEnvValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const lowerKey = key.toLowerCase();
  const match = Object.keys(env).find((envKey) => envKey.toLowerCase() === lowerKey);
  return match ? env[match] : undefined;
}

function isExecutableCandidate(path: string, isExecutable?: ExecutableCheck): boolean {
  if (isExecutable) {
    return isExecutable(path);
  }

  try {
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}
