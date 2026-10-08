export type SkillScope = "workspace" | "user" | "plugin";

export interface SkillMetadata {
  slug?: string;
  version?: string;
  ownerId?: string;
  publishedAt?: number;
}

export interface SkillSummary {
  id: string;
  name: string;
  description: string;
  body: string;
  path: string;
  /**
   * 发现阶段命中的原始 SKILL.md 路径（未经 realpath 解析）。
   * 软链导入的技能里 `path` 是 realpath 后的目标文件，`sourcePath` 才指向 `~/.zcode/skills/<name>` 下的链接本体，
   * 删除时必须用它才能只删链接、不动目标。普通技能与 `path` 相同。
   */
  sourcePath?: string;
  scope: SkillScope;
  enabled: boolean;
  /** plugin scope 时为来源插件名；其它 scope 留空。 */
  pluginName?: string;
  /** plugin scope 时为来源插件完整 ID（name@marketplace）；旧 payload 可缺省。 */
  pluginId?: string;
  metadata?: SkillMetadata;
}

export interface SkillsCapability {
  userScopeAvailable: boolean;
  userScopeReason?: "desktop_only";
}

export type SkillDiagnosticSeverity = "warning" | "error";

/** 与 zcode-cli `SkillDiagnosticCode` 同步。变动时一并改 apps/zcode-cli/packages/contracts/src/skills/index.ts。 */
export type SkillDiagnosticCode =
  | "skill_root_not_found"
  | "skill_scan_failed"
  | "skill_read_failed"
  | "skill_missing_frontmatter"
  | "skill_invalid_frontmatter"
  | "skill_missing_name"
  | "skill_invalid_name"
  | "skill_missing_description"
  | "skill_description_too_long"
  | "skill_unknown_frontmatter"
  | "skill_duplicate_name"
  | "skill_too_large"
  | "skill_not_found";

export interface SkillDiagnostic {
  code: SkillDiagnosticCode;
  severity: SkillDiagnosticSeverity;
  message: string;
  path?: string;
  skillName?: string;
}

export interface SkillsListResult {
  skills: SkillSummary[];
  capability: SkillsCapability;
  diagnostics: SkillDiagnostic[];
}

export interface SkillsPromptContext {
  prompt: string;
  activatedSkillNames: string[];
}
