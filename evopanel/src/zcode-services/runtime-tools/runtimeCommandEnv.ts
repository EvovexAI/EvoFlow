import { existsSync } from "node:fs";
import { delimiter } from "node:path";
import { buildZCodeToolEnvPassthroughEnv, sanitizeZCodeRuntimeEnvInPlace } from "@zcode/shared";
import { appendPathEntries, buildRuntimeToolEnvPatch } from "./runtimeToolResolver.js";
import {
  buildShellBootstrapPath,
  captureLoginShellEnvSnapshot,
  captureLoginShellEnvSnapshotSync,
} from "./runtimeLoginShellEnvCapture.js";
export {
  captureLoginShellEnvSnapshot,
  type LoginShellExecutor,
} from "./runtimeLoginShellEnvCapture.js";

const DEFAULT_WINDOWS_NODE_PATHS = [
  "%APPDATA%\\npm",
  "%ProgramFiles%\\nodejs",
  "%ProgramFiles(x86)%\\nodejs",
  "%LOCALAPPDATA%\\Programs\\nodejs",
];
const PYTHON_UTF8_ENV_PATCH = {
  PYTHONIOENCODING: "utf-8",
  PYTHONUTF8: "1",
} as const;

let hasInitializedRuntimeCommandEnv = false;

function readWindowsEnvValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const matchingKey = Object.keys(env).find((key) => key.toUpperCase() === name.toUpperCase());
  return matchingKey ? env[matchingKey] : undefined;
}

function expandWindowsEnvVars(path: string, env: NodeJS.ProcessEnv): string {
  return path.replace(/%([^%]+)%/g, (_, varName) => readWindowsEnvValue(env, varName) || "");
}

function resolveWindowsNodePaths(env: NodeJS.ProcessEnv): string[] {
  const paths: string[] = [];
  for (const template of DEFAULT_WINDOWS_NODE_PATHS) {
    const expanded = expandWindowsEnvVars(template, env);
    if (expanded && existsSync(expanded)) {
      paths.push(expanded);
    }
  }
  return paths;
}

const INHERITED_LOGIN_SHELL_ENV_KEY_PATTERNS = [
  /^KUBECONFIG$/i,
  /^KUBE_CONFIG_PATH$/i,
  /^KUBECTL_KUBECONFIG$/i,
  /^SSH_AUTH_SOCK$/i,
  /^AWS_PROFILE$/i,
  /^AWS_REGION$/i,
  /^AWS_DEFAULT_REGION$/i,
  /^AWS_SDK_LOAD_CONFIG$/i,
  /^GOOGLE_APPLICATION_CREDENTIALS$/i,
  /^LANG$/i,
  /^LC_[A-Z0-9_]+$/i,
  /^XDG_CONFIG_HOME$/i,
  /^XDG_DATA_HOME$/i,
  /^XDG_CACHE_HOME$/i,
  /^TERM$/i,
  /^COLORTERM$/i,
  /^TERM_PROGRAM$/i,
  /^TERM_PROGRAM_VERSION$/i,
  /^NPM_CONFIG_USERCONFIG$/i,
  /^NPM_CONFIG_PREFIX$/i,
  /^PNPM_HOME$/i,
  /^NVM_DIR$/i,
  /^NVM_CD_FLAGS$/i,
  /^FNM_[A-Z0-9_]+$/i,
  /^VOLTA_HOME$/i,
  /^CARGO_HOME$/i,
  /^RUSTUP_HOME$/i,
  /^GOPATH$/i,
  /^GOROOT$/i,
  /^GOENV_ROOT$/i,
  /^GVM_ROOT$/i,
  /^gvm_[A-Za-z0-9_]+$/i,
  /^JAVA_HOME$/i,
  /^JENV_ROOT$/i,
  /^SDKMAN_DIR$/i,
  /^SDKMAN_CANDIDATES_DIR$/i,
  /^SDKMAN_PLATFORM$/i,
  /^VIRTUAL_ENV$/i,
  /^CONDA_PREFIX$/i,
  /^PYENV_ROOT$/i,
  /^PYENV_VERSION$/i,
  /^PYENV_VIRTUALENV_[A-Z0-9_]+$/i,
  /^PIP_CONFIG_FILE$/i,
  // shell init snapshot 会保存 cd/chpwd/precmd hook 函数；
  // 这些 hook 常依赖版本管理器的 root/state env。
  // 这里只补已知 hook 必需变量，避免恢复宽继承把 NODE_OPTIONS 等带进 host/agent runtime。
  /^DIRENV_[A-Z0-9_]+$/i,
  /^MISE_[A-Z0-9_]+$/i,
  /^rvm_[A-Za-z0-9_]+$/i,
  /^MY_RUBY_HOME$/i,
  /^GEM_HOME$/i,
  /^GEM_PATH$/i,
  /^RUBIES$/i,
  /^CHRUBY_ROOT$/i,
  /^RBENV_ROOT$/i,
  /^NODENV_ROOT$/i,
  /^AUTOENV_[A-Z0-9_]+$/i,
] as const;

function shouldInheritLoginShellEnvKey(key: string): boolean {
  return INHERITED_LOGIN_SHELL_ENV_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

function buildLoginShellEnvPatch(
  snapshot: Record<string, string | undefined>,
): Record<string, string> {
  const patch: Record<string, string> = {};
  for (const [key, value] of Object.entries(snapshot)) {
    if (value !== undefined && shouldInheritLoginShellEnvKey(key)) {
      patch[key] = value;
    }
  }

  return {
    ...patch,
    ...buildZCodeToolEnvPassthroughEnv(snapshot),
  };
}

export function normalizeRuntimeProcessEnv(
  baseEnv: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const normalized = { ...baseEnv };
  if (platform !== "win32") {
    return normalized;
  }

  let pathValue: string | undefined;
  for (const [key, value] of Object.entries(baseEnv)) {
    if (key.toUpperCase() === "PATH" && value !== undefined) {
      // 后出现的值优先，使 {...dotenv, ...process.env} 保持真实进程环境优先语义。
      pathValue = value;
    }
  }
  for (const key of Object.keys(normalized)) {
    if (key.toUpperCase() === "PATH") {
      delete normalized[key];
    }
  }
  if (pathValue !== undefined) {
    normalized.PATH = pathValue;
  }
  return normalized;
}

export function buildRuntimeProcessEnvPatch(
  baseEnv: NodeJS.ProcessEnv = process.env,
  loginShellSnapshot: Record<string, string> | null = captureLoginShellEnvSnapshotSync(baseEnv),
  options: {
    platform?: NodeJS.Platform;
    windowsNodePaths?: readonly string[];
  } = {},
): Record<string, string> {
  const platform = options.platform ?? process.platform;
  const normalizedBaseEnv = normalizeRuntimeProcessEnv(baseEnv, platform);
  const loginShellPath = loginShellSnapshot?.PATH?.trim() || null;
  const loginShellEnvPatch = loginShellSnapshot ? buildLoginShellEnvPatch(loginShellSnapshot) : {};
  const toolEnvPassthroughPatch = buildZCodeToolEnvPassthroughEnv({
    ...normalizedBaseEnv,
    ...loginShellEnvPatch,
  });
  const runtimeToolEnvPatch = buildRuntimeToolEnvPatch(["bfs", "ripgrep", "ugrep"], {
    ...normalizedBaseEnv,
    PATH: undefined,
  });

  const runtimeToolPathEntries = runtimeToolEnvPatch.PATH?.split(delimiter).filter(Boolean) ?? [];
  // 远端 server 可能由非交互 SSH /bin/sh 启动，原始 PATH 只有系统目录；
  // login shell 探测失败时如果继续沿用该 PATH，后续 mcp/list 的 app-server 直接 spawn("npx")
  // 会找不到 Homebrew/NVM 里的 npx。POSIX 下把 bootstrap PATH 也作为最终兜底，而不是只用于探测。
  const fallbackPathBase =
    platform === "win32" ? normalizedBaseEnv.PATH : buildShellBootstrapPath(normalizedBaseEnv.PATH);
  const pathBase = loginShellPath ?? fallbackPathBase;
  const envPatch: Record<string, string> = {
    ...loginShellEnvPatch,
    ...toolEnvPassthroughPatch,
    ...runtimeToolEnvPatch,
    // Python on Windows inherits the active code page (often GBK/936) when no explicit
    // encoding is set. ZCode/Bash tool output is consumed as UTF-8, so force Python
    // subprocesses spawned by agents to emit UTF-8.
    ...PYTHON_UTF8_ENV_PATCH,
  };

  if (platform === "win32") {
    const windowsNodePaths = options.windowsNodePaths ?? resolveWindowsNodePaths(normalizedBaseEnv);
    runtimeToolPathEntries.push(...windowsNodePaths);
  }

  const shouldSetPath =
    Boolean(loginShellPath) ||
    runtimeToolPathEntries.length > 0 ||
    (platform === "win32" && Boolean(normalizedBaseEnv.PATH)) ||
    (platform !== "win32" && pathBase !== normalizedBaseEnv.PATH);
  if (shouldSetPath) {
    const nextPath = appendPathEntries(pathBase, runtimeToolPathEntries);
    if (nextPath) {
      envPatch.PATH = nextPath;
    }
  }

  return envPatch;
}

export async function prepareRuntimeProcessEnvPatch(
  baseEnv: NodeJS.ProcessEnv = process.env,
  options: {
    captureSnapshot?: () => Promise<Record<string, string> | null>;
    platform?: NodeJS.Platform;
    captureTimeoutMs?: number;
  } = {},
): Promise<Record<string, string>> {
  const platform = options.platform ?? process.platform;
  const normalizedBaseEnv = normalizeRuntimeProcessEnv(baseEnv, platform);
  let snapshot: Record<string, string> | null = null;
  try {
    snapshot = await (
      options.captureSnapshot ??
      (() =>
        captureLoginShellEnvSnapshot({
          baseEnv: normalizedBaseEnv,
          platform,
          timeoutMs: options.captureTimeoutMs,
        }))
    )();
  } catch {
    snapshot = null;
  }
  return buildRuntimeProcessEnvPatch(normalizedBaseEnv, snapshot, { platform });
}

export function initializeRuntimeProcessEnv(
  preparedRuntimeProcessEnvPatch?: Record<string, string>,
): void {
  if (hasInitializedRuntimeCommandEnv) {
    return;
  }
  hasInitializedRuntimeCommandEnv = true;

  const normalizedProcessEnv = normalizeRuntimeProcessEnv(process.env);
  if (process.platform === "win32") {
    // Host 同时持有继承的 Path 与 Main patch 的 PATH 时，Windows 子进程只会保留其中一项。
    // 在任何 Git/terminal/Agent spawn 前统一成一个键，避免用户 PATH 被短 patch 覆盖。
    for (const key of Object.keys(process.env)) {
      if (key.toUpperCase() === "PATH") {
        delete process.env[key];
      }
    }
    if (normalizedProcessEnv.PATH !== undefined) {
      process.env.PATH = normalizedProcessEnv.PATH;
    }
  }
  const runtimeProcessEnvPatch =
    preparedRuntimeProcessEnvPatch ?? buildRuntimeProcessEnvPatch(normalizedProcessEnv);
  // host/agent 运行时不能直接继承用户 shell 里的 NODE_ENV、http_proxy 或证书变量。
  // 网络变量会先封存为 ZCODE_TOOL_ENV_PASSTHROUGH_JSON，只有 Bash/tool 子进程边界才恢复原名。
  sanitizeZCodeRuntimeEnvInPlace(process.env);
  Object.assign(process.env, runtimeProcessEnvPatch);
}
