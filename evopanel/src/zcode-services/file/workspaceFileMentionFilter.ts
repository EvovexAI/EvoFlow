import { extname } from "node:path";

const SKIPPED_DIRECTORY_NAMES = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "bower_components",
  "jspm_packages",
  "__pycache__",
  "site-packages",
  "venv",
  "coverage",
  "htmlcov",
  "lcov-report",
  "cmakefiles",
  "pods",
  "deriveddata",
  "storybook-static",
  "playwright-report",
  "test-results",
  "allure-results",
  "allure-report",
  "cdk.out",
  "eggs",
  "pip-wheel-metadata",
  "wheels",
]);
const SKIPPED_DIRECTORY_PREFIXES = ["cmake-build-", "bazel-"];
const SKIPPED_DIRECTORY_SUFFIXES = [".egg-info", ".dist-info"];
const SKIPPED_FILE_NAMES = new Set(["coverage.out", "lcov.info"]);
const SKIPPED_FILE_EXTENSIONS = new Set([
  ".a",
  ".aar",
  ".beam",
  ".class",
  ".dll",
  ".dylib",
  ".ear",
  ".exe",
  ".gcda",
  ".gcno",
  ".gem",
  ".hi",
  ".idb",
  ".ilk",
  ".jar",
  ".lib",
  ".node",
  ".nupkg",
  ".o",
  ".obj",
  ".pdb",
  ".profdata",
  ".profraw",
  ".pyc",
  ".pyo",
  ".rlib",
  ".so",
  ".tsbuildinfo",
  ".war",
]);

export interface WorkspaceFileSearchEntry {
  name: string;
  path: string;
  relativePath: string;
  type: "file" | "directory";
}

export interface WorkspaceFileSearchDecision {
  include: boolean;
  traverse: boolean;
}

export interface WorkspaceFileSearchFilterContext {
  /**
   * `.zcodeignore` 规则加载成功时为 true：目录排除的单一真相源是规则文件，
   * 内置目录黑名单退役（用户从文件里删掉 node_modules/ 就应恢复搜索），
   * 仅文件级规则（.env/二进制后缀）与隐藏目录语义继续叠加。
   * fail-open（规则文件完全不可用）时为 false/缺省，黑名单照旧兜底。
   */
  ignoreRulesActive: boolean;
}

/**
 * Workspace 文件索引只依赖这个最终过滤器，不关心规则来自内置列表、配置文件还是设置页面。
 * 后续自定义规则应注入另一份完整实现来替换默认实现，而不是与默认黑名单强制求并集。
 */
export interface WorkspaceFileSearchFilter {
  evaluate(
    entry: WorkspaceFileSearchEntry,
    context?: WorkspaceFileSearchFilterContext,
  ): WorkspaceFileSearchDecision;
}

function shouldSkipDirectory(name: string): boolean {
  const normalizedName = name.toLowerCase();
  return (
    SKIPPED_DIRECTORY_NAMES.has(normalizedName) ||
    SKIPPED_DIRECTORY_PREFIXES.some((prefix) => normalizedName.startsWith(prefix)) ||
    SKIPPED_DIRECTORY_SUFFIXES.some((suffix) => normalizedName.endsWith(suffix))
  );
}

function shouldSkipFile(name: string): boolean {
  const normalizedName = name.toLowerCase();
  return (
    normalizedName === ".env" ||
    normalizedName.startsWith(".env.") ||
    SKIPPED_FILE_NAMES.has(normalizedName) ||
    SKIPPED_FILE_EXTENSIONS.has(extname(normalizedName))
  );
}

function isInsideHiddenDirectory(relativePath: string): boolean {
  const segments = relativePath.split("/");
  const directorySegments = segments.slice(0, -1);
  return directorySegments.some((segment) => segment.startsWith("."));
}

export const defaultWorkspaceFileSearchFilter: WorkspaceFileSearchFilter = {
  evaluate(entry, context) {
    if (entry.type === "directory") {
      // ignoreRulesActive 时目录黑名单退役：目录排除的唯一来源是 .zcodeignore 规则文件。
      if (!context?.ignoreRulesActive && shouldSkipDirectory(entry.name)) {
        return { include: false, traverse: false };
      }
      // 遇到任意隐藏目录就整棵剪枝会让 .github 等目录里的有效文件无法通过名称搜索。
      // 隐藏目录及其下级目录不占候选列表，但保留遍历，让其中的普通文件进入索引。
      const hiddenDirectory =
        entry.name.startsWith(".") || isInsideHiddenDirectory(entry.relativePath);
      return { include: !hiddenDirectory, traverse: true };
    }

    return { include: !shouldSkipFile(entry.name), traverse: false };
  },
};
