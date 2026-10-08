// ============================================================
// Skill scan policy (pure, no I/O)
// ============================================================
//
// 技能目录扫描的共享策略，被 @zcode/services（桌面端递归扫描）与
// apps/zcode-cli 的 @zcode/adapters（agent 端单层扫描）共同消费，
// 避免两端对“什么目录该进入”产生分歧。
//
// 必须保持纯逻辑、不引入 node:* 依赖，否则会破坏 web bundle。

/** 技能定义文件名。 */
export const SKILL_FILE_NAME = "SKILL.md";

/**
 * 递归扫描技能目录时直接跳过的子目录名。
 *
 * 只跳过 `.` 开头目录是不够的：
 * `node_modules` 等内容目录会被整棵递归吃进去，在 Windows 上把单次
 * `skills.list` 放大到 69–256s。这些目录里不会存放用户技能，统一排除。
 */
export const SKILL_SCAN_EXCLUDED_DIRECTORY_NAMES: ReadonlySet<string> = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "target",
  "vendor",
  "coverage",
  ".cache",
  ".next",
  ".turbo",
  ".venv",
  "__pycache__",
]);

/**
 * 递归扫描的最大深度（相对扫描根，根自身为 0）。
 *
 * 真实技能布局很浅：`root/<name>/SKILL.md`，分组场景至多
 * `root/<group>/<name>/SKILL.md`。给到 8 层留足冗余，同时作为
 * symlink/junction 形成的超深目录链的兜底刹车。
 */
export const MAX_SKILL_SCAN_DEPTH = 8;

/**
 * 技能目录（含 ~/.zcode/skills 等）下默认不进入以 . 开头的子目录，
 * 避免 .agents/.cursor 等 vendored 副本与软链镜像重复列出；
 * 同时跳过 node_modules 等内容目录。
 */
const SKILL_DISCOVERY_DOT_DIR_ALLOWLIST = new Set([".system"]);

/** 判断递归扫描是否应进入某个子目录项。 */
export function shouldWalkSkillDirectoryEntry(entryName: string): boolean {
  if (SKILL_SCAN_EXCLUDED_DIRECTORY_NAMES.has(entryName)) {
    return false;
  }
  if (!entryName.startsWith(".")) {
    return true;
  }
  return SKILL_DISCOVERY_DOT_DIR_ALLOWLIST.has(entryName);
}
