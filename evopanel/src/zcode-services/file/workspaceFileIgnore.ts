import { open, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import ignoreFactory from "ignore";
import type { Ignore } from "ignore";
import type { ServiceLogger } from "../logger/serviceLogger.js";

/**
 * workspace 文件搜索忽略的单一真相源。
 *
 * `.zcodeignore`（workspace root，gitignore 语法）是搜索索引的唯一规则文件：
 * 首次需要规则而文件不存在时自动创建，内容为 root `.gitignore` 的拷贝（无则默认模板）；
 * 之后 `.gitignore` 的变化不再影响搜索，用户通过设置页编辑或「从 .gitignore 重新同步」。
 *
 * 规则解析交给 `ignore` npm 包（gitignore spec 2.22 参考实现，ESLint 同款）：
 * 后声明覆盖、`!` 反选（含父目录排除后子文件无法恢复的 git 原生约束）、anchored/basename、
 * `**` 跨层、目录后缀 `/`、字符类与转义。禁止在本仓库手写 gitignore 解析。
 */

export const WORKSPACE_FILE_SEARCH_IGNORE_FILE_NAME = ".zcodeignore";
const GITIGNORE_FILE_NAME = ".gitignore";

type WorkspaceFileIgnoreLogger = Pick<ServiceLogger, "info" | "warn">;

type WorkspaceFileSearchIgnoreRulesSource =
  | "file"
  | "created-from-gitignore"
  | "created-from-template"
  | "fallback-gitignore"
  | "fallback-builtin";

interface WorkspaceFileSearchIgnoreRules {
  matcher: Ignore;
  source: WorkspaceFileSearchIgnoreRulesSource;
}

interface WorkspaceFileSearchIgnoreContent {
  content: string;
  /** file：.zcodeignore 已存在；template：尚未创建，content 是保存后将落盘的初始内容预览。 */
  source: "file" | "template";
}

/**
 * 默认模板的内置排除规则：承接旧 defaultWorkspaceFileSearchFilter 目录黑名单的退役部分，
 * 保证"从零创建"的 workspace 行为与旧默认一致（node_modules/.git 等仍被剪枝）。
 * 前缀通配按 gitignore 语法表达（cmake-build-* 等），与旧 SKIPPED_DIRECTORY_PREFIXES 等价。
 */
const BUILTIN_IGNORE_LINES = [
  ".git/",
  ".hg/",
  ".svn/",
  "node_modules/",
  "bower_components/",
  "jspm_packages/",
  "__pycache__/",
  "site-packages/",
  "venv/",
  "coverage/",
  "htmlcov/",
  "lcov-report/",
  "cmakefiles/",
  "cmake-build-*/",
  "bazel-*/",
  "pods/",
  "deriveddata/",
  "storybook-static/",
  "playwright-report/",
  "test-results/",
  "allure-results/",
  "allure-report/",
  "cdk.out/",
  "*.egg-info/",
  "*.dist-info/",
  "eggs/",
  "pip-wheel-metadata/",
  "wheels/",
];

const TEMPLATE_HEADER = [
  "# ZCode 工作区文件搜索忽略规则（.zcodeignore）",
  "# 语法与 .gitignore 一致，只影响 ZCode 的 @ 文件候选 / Command Center / 文件树搜索，",
  "# 不影响文件树浏览、上传或 Agent 文件访问。",
  "# 修改 .gitignore 不会自动同步到本文件；可在设置页「从 .gitignore 同步」。",
  "",
];

/**
 * 分区标记（按行精确匹配，删除标记会让对应按钮退化为整体重建）：
 * 「从 .gitignore 同步」只重写 SYNC 标记之上的内容；
 * 「恢复默认规则」只重写两个标记之间的默认排除段；
 * DEFAULTS 标记之下的自定义规则区，任何按钮都不会改动。
 */
const WORKSPACE_FILE_SEARCH_IGNORE_SYNC_MARKER =
  "# ===== ↑ 以上同步自 .gitignore（「从 .gitignore 同步」只重写以上部分）=====";
const WORKSPACE_FILE_SEARCH_IGNORE_DEFAULTS_MARKER =
  "# ----- ↑ 以上为 ZCode 默认排除规则（自定义规则请写在本行下方，不会被同步/恢复改动）-----";

const CUSTOM_SECTION_HINT = "# 自定义规则写在下方（本行提示可删除）";

function buildBuiltinDefaultsSection(gitignoreContent: string | null): string {
  // 创建/恢复默认时的去重：gitignore 区已声明的规则不重复写入默认段，
  // 保证文件中每条规则最多一份——用户删除一处即完全放开，不会出现
  // "删了默认段的 node_modules/ 但 gitignore 拷贝区还藏着一条"的困惑。
  // 判重保守：行 trim 后相等，或忽略单个尾 '/' 差异（node_modules 覆盖 node_modules/）；
  // anchored（/node_modules/）等写法差异不视为重复，宁可重复不可漏规则。
  if (gitignoreContent === null) {
    return BUILTIN_IGNORE_LINES.join("\n");
  }
  const declared = new Set<string>();
  for (const rawLine of gitignoreContent.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("!")) {
      continue;
    }
    declared.add(line);
    declared.add(line.replace(/\/$/, ""));
  }
  const deduped = BUILTIN_IGNORE_LINES.filter((line) => {
    const bare = line.replace(/\/$/, "");
    return !declared.has(line) && !declared.has(bare);
  });
  return deduped.join("\n");
}

/**
 * 构建 `.zcodeignore` 初始内容：.gitignore 规则拷贝 + 双标记分区（默认排除段 / 自定义区）。
 * 附加默认段是行为兼容要求：.gitignore 未声明 node_modules 等目录的仓库若仅严格拷贝，
 * 依赖目录会被整棵放开扫描（再次出现全仓扫描的性能问题）；默认段随文件
 * 交给用户编辑，删除即放开，维持"单一真相源、无代码级并集"的承诺。
 * 默认段写入前先对 gitignore 区做规则去重（见 buildBuiltinDefaultsSection）。
 */
function buildWorkspaceFileSearchIgnoreTemplate(gitignoreContent: string | null): string {
  const gitignoreSection =
    gitignoreContent !== null && gitignoreContent.trim().length > 0
      ? gitignoreContent.endsWith("\n")
        ? gitignoreContent
        : `${gitignoreContent}\n`
      : `${TEMPLATE_HEADER.join("\n")}\n`;
  return [
    gitignoreSection,
    WORKSPACE_FILE_SEARCH_IGNORE_SYNC_MARKER,
    buildBuiltinDefaultsSection(gitignoreContent),
    WORKSPACE_FILE_SEARCH_IGNORE_DEFAULTS_MARKER,
    CUSTOM_SECTION_HINT,
    "",
  ].join("\n");
}

interface SplitWorkspaceFileSearchIgnoreSections {
  gitignoreSection: string;
  defaultsSection: string;
  customSection: string;
}

/** 按双标记切分文件；任一标记缺失（旧格式/用户删除）返回 null，调用方退化为整体重建。 */
function splitWorkspaceFileSearchIgnoreSections(
  content: string,
): SplitWorkspaceFileSearchIgnoreSections | null {
  const lines = content.split(/\r?\n/);
  const syncIndex = lines.findIndex(
    (line) => line.trim() === WORKSPACE_FILE_SEARCH_IGNORE_SYNC_MARKER,
  );
  const defaultsIndex = lines.findIndex(
    (line) => line.trim() === WORKSPACE_FILE_SEARCH_IGNORE_DEFAULTS_MARKER,
  );
  if (syncIndex === -1 || defaultsIndex === -1 || defaultsIndex <= syncIndex) {
    return null;
  }
  return {
    gitignoreSection: lines.slice(0, syncIndex).join("\n"),
    defaultsSection: lines
      .slice(syncIndex + 1, defaultsIndex)
      .join("\n")
      .trim(),
    customSection: lines
      .slice(defaultsIndex + 1)
      .join("\n")
      .replace(/^\n+/, ""),
  };
}

/**
 * 「从 .gitignore 同步」：只重写 SYNC 标记之上的内容为当前 .gitignore，
 * 默认排除段与自定义区原样保留（用户对默认段的删改不受影响）。
 * 标记缺失时退化为整体初始内容重建（无法结构化定位分区）。
 */
function syncWorkspaceFileSearchIgnoreFromGitignore(
  currentContent: string,
  gitignoreContent: string | null,
): string {
  const sections = splitWorkspaceFileSearchIgnoreSections(currentContent);
  if (!sections) {
    return buildWorkspaceFileSearchIgnoreTemplate(gitignoreContent);
  }
  const gitignoreSection =
    gitignoreContent !== null && gitignoreContent.trim().length > 0
      ? gitignoreContent.endsWith("\n")
        ? gitignoreContent
        : `${gitignoreContent}\n`
      : `${TEMPLATE_HEADER.join("\n")}\n`;
  return [
    gitignoreSection,
    WORKSPACE_FILE_SEARCH_IGNORE_SYNC_MARKER,
    sections.defaultsSection,
    WORKSPACE_FILE_SEARCH_IGNORE_DEFAULTS_MARKER,
    sections.customSection,
  ]
    .join("\n")
    .replace(/\n+$/, "\n");
}

/**
 * 「恢复默认规则」：只重置默认排除段为内置清单，gitignore 区与自定义区原样保留。
 * 标记缺失时退化为整体初始内容重建。
 */
function resetWorkspaceFileSearchIgnoreDefaults(
  currentContent: string,
  gitignoreContent: string | null,
): string {
  const sections = splitWorkspaceFileSearchIgnoreSections(currentContent);
  if (!sections) {
    return buildWorkspaceFileSearchIgnoreTemplate(gitignoreContent);
  }
  // 恢复默认按当前 gitignore 区规则去重重算：gitignore 已声明的行不重复写回默认段；
  // 若用户曾从 .gitignore 删掉 node_modules 等，恢复时默认段会把它补回（兜底回归）。
  return [
    sections.gitignoreSection,
    WORKSPACE_FILE_SEARCH_IGNORE_SYNC_MARKER,
    buildBuiltinDefaultsSection(sections.gitignoreSection),
    WORKSPACE_FILE_SEARCH_IGNORE_DEFAULTS_MARKER,
    sections.customSection,
  ]
    .join("\n")
    .replace(/\n+$/, "\n");
}

// ignore 包的 index.d.ts 在 nodenext 下把 default import 解析为模块命名空间（无调用签名），
// 而运行时 default 恰是工厂函数本身（Node ESM interop 实测）。这里显式收窄回工厂签名。
const createIgnoreMatcher: () => Ignore = ignoreFactory as unknown as () => Ignore;

function buildIgnoreMatcher(content: string): Ignore {
  return createIgnoreMatcher().add(content);
}

function isNotFoundError(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "ENOENT";
}

async function readOptionalFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isNotFoundError(error)) {
      return null;
    }
    throw error;
  }
}

/**
 * 原子写：目标目录内写临时文件（flush + close）后 rename 替换，参照
 * workspace-hook-mutation.ts 的模式，保证 Runtime/设置页不会观察到半截规则文件。
 */
async function atomicWriteIgnoreFile(path: string, content: string): Promise<void> {
  const directory = dirname(path);
  const tempPath = resolve(
    directory,
    `.${basename(path)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(tempPath, "wx", 0o644);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(tempPath, path);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * 扫描前加载 `.zcodeignore` 规则；含自动创建与 fail-open 降级链：
 * 文件不存在 → 原子创建（.gitignore 拷贝 / 默认模板）；
 * 创建或读取失败（只读 fs、权限）→ 内存使用 .gitignore 内容 → 再失败用内置默认规则。
 * 任何降级只 warn 一次，绝不让 @ 面板因规则文件不可用而扫描失败。
 */
export async function loadWorkspaceFileSearchIgnoreRules(
  rootPath: string,
  logger?: WorkspaceFileIgnoreLogger,
): Promise<WorkspaceFileSearchIgnoreRules> {
  const ignorePath = resolve(rootPath, WORKSPACE_FILE_SEARCH_IGNORE_FILE_NAME);

  const degradeToInMemory = async (
    reason: string,
    error: unknown,
  ): Promise<WorkspaceFileSearchIgnoreRules> => {
    const gitignoreContent = await readOptionalFile(resolve(rootPath, GITIGNORE_FILE_NAME)).catch(
      () => null,
    );
    if (gitignoreContent !== null) {
      logger?.warn(
        undefined,
        `[workspace-file-ignore] ${reason}，降级为运行时使用 .gitignore 规则`,
        error,
      );
      return {
        matcher: buildIgnoreMatcher(gitignoreContent),
        source: "fallback-gitignore",
      };
    }
    logger?.warn(undefined, `[workspace-file-ignore] ${reason}，降级为内置默认忽略规则`, error);
    const template = buildWorkspaceFileSearchIgnoreTemplate(null);
    return {
      matcher: buildIgnoreMatcher(template),
      source: "fallback-builtin",
    };
  };

  let existing: string | null;
  try {
    existing = await readOptionalFile(ignorePath);
  } catch (error) {
    return degradeToInMemory(`读取 ${WORKSPACE_FILE_SEARCH_IGNORE_FILE_NAME} 失败`, error);
  }
  if (existing !== null) {
    return { matcher: buildIgnoreMatcher(existing), source: "file" };
  }

  const gitignoreContent = await readOptionalFile(resolve(rootPath, GITIGNORE_FILE_NAME)).catch(
    () => null,
  );
  const initialContent = buildWorkspaceFileSearchIgnoreTemplate(gitignoreContent);
  try {
    await atomicWriteIgnoreFile(ignorePath, initialContent);
  } catch (error) {
    // 创建失败不影响扫描：初始内容确定性已知，内存中直接按初始内容执行，
    // 来源标记沿用初始内容来源（.gitignore 拷贝 / 内置模板）表达 fail-open 降级。
    logger?.warn(
      undefined,
      `[workspace-file-ignore] 自动创建 ${WORKSPACE_FILE_SEARCH_IGNORE_FILE_NAME} 失败，降级为运行时使用${
        gitignoreContent !== null ? ".gitignore" : "内置默认"
      }规则`,
      error,
    );
    return {
      matcher: buildIgnoreMatcher(initialContent),
      source: gitignoreContent !== null ? "fallback-gitignore" : "fallback-builtin",
    };
  }
  logger?.info(
    undefined,
    `[workspace-file-ignore] 已自动创建 ${WORKSPACE_FILE_SEARCH_IGNORE_FILE_NAME}（来源：${
      gitignoreContent !== null ? ".gitignore 拷贝" : "默认模板"
    }）`,
  );
  return {
    matcher: buildIgnoreMatcher(initialContent),
    source: gitignoreContent !== null ? "created-from-gitignore" : "created-from-template",
  };
}

/**
 * 判定相对路径是否被忽略。目录必须传带尾斜杠的路径（gitignore dirOnly 规则只匹配目录），
 * relativePath 由调用方保证为 posix 分隔符（fileService 的 normalizeRelativePath 已转换）。
 */
export function isWorkspaceFileSearchPathIgnored(
  rules: WorkspaceFileSearchIgnoreRules,
  relativePath: string,
  type: "file" | "directory",
): boolean {
  return type === "directory"
    ? rules.matcher.ignores(`${relativePath}/`)
    : rules.matcher.ignores(relativePath);
}

/** 设置页读取：文件不存在时返回初始内容预览（source: template），不落盘。 */
export async function readWorkspaceFileSearchIgnore(
  rootPath: string,
): Promise<WorkspaceFileSearchIgnoreContent> {
  const ignorePath = resolve(rootPath, WORKSPACE_FILE_SEARCH_IGNORE_FILE_NAME);
  const existing = await readOptionalFile(ignorePath);
  if (existing !== null) {
    return { content: existing, source: "file" };
  }
  const gitignoreContent = await readOptionalFile(resolve(rootPath, GITIGNORE_FILE_NAME)).catch(
    () => null,
  );
  return {
    content: buildWorkspaceFileSearchIgnoreTemplate(gitignoreContent),
    source: "template",
  };
}

type WorkspaceFileSearchIgnoreTransform = "sync-gitignore" | "reset-defaults";

/**
 * 设置页分区操作（返回新内容填充编辑框，保存才落盘）：
 * sync-gitignore 只重写 gitignore 同步区；reset-defaults 只重置默认排除段；
 * 两者都保留标记之外的用户内容，详见各纯函数的契约。
 */
export async function transformWorkspaceFileSearchIgnore(
  rootPath: string,
  transform: WorkspaceFileSearchIgnoreTransform,
): Promise<{ content: string }> {
  const ignorePath = resolve(rootPath, WORKSPACE_FILE_SEARCH_IGNORE_FILE_NAME);
  const existing = await readOptionalFile(ignorePath).catch(() => null);
  const gitignoreContent = await readOptionalFile(resolve(rootPath, GITIGNORE_FILE_NAME)).catch(
    () => null,
  );
  const currentContent = existing ?? buildWorkspaceFileSearchIgnoreTemplate(gitignoreContent);
  const content =
    transform === "sync-gitignore"
      ? syncWorkspaceFileSearchIgnoreFromGitignore(currentContent, gitignoreContent)
      : resetWorkspaceFileSearchIgnoreDefaults(currentContent, gitignoreContent);
  return { content };
}

/** 设置页保存：原子写整个文件，下次扫描读取即为新内容。 */
export async function writeWorkspaceFileSearchIgnore(
  rootPath: string,
  content: string,
): Promise<void> {
  const ignorePath = resolve(rootPath, WORKSPACE_FILE_SEARCH_IGNORE_FILE_NAME);
  await atomicWriteIgnoreFile(ignorePath, content);
}
