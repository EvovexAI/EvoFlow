import type {
  ProviderFamilyConnectionSelectionSettings,
  ProviderFamilyDomain,
} from "@zcode/shared";
import { readFile } from "node:fs/promises";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export interface LegacyTeamConnection {
  readonly family: ProviderFamilyDomain;
  readonly productId: string;
  readonly projectId: string;
}

/** 仅迁移器解释旧键；组织信息由 Host 的只读 OAuth 查询注入。退役旧版后删除。 */
export function readIncompleteLegacyTeamConnections(value: unknown): LegacyTeamConnection[] {
  if (!needsLegacyAccountConnectionMigration(value)) return [];
  const raw = record(value);
  const modes = record(raw.modelProviderFamilyModes);
  const keys = record(raw.modelProviderFamilySelectedKeys);
  return (["zai", "bigmodel"] as const).flatMap((family) => {
    if (modes[family] === "apiKey") return [];
    const prefix = `team-plan:builtin:${family}-coding-plan:`;
    const key = typeof keys[family] === "string" ? keys[family].trim() : "";
    if (!key.startsWith(prefix)) return [];
    try {
      const parts = key
        .slice(prefix.length)
        .split(":")
        .map((part) => decodeURIComponent(part).trim());
      if (parts.length !== 2 || parts.some((part) => !part)) return [];
      return [{ family, productId: parts[0]!, projectId: parts[1]! }];
    } catch {
      return [];
    }
  });
}

export async function readLegacyAccountConnectionSettingsFile(
  filePath: string,
): Promise<Record<string, unknown>> {
  try {
    return record(JSON.parse(await readFile(filePath, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

export function needsLegacyAccountConnectionMigration(value: unknown): boolean {
  const raw = record(value);
  return (
    !Object.hasOwn(raw, "providerFamilyConnectionSelections") &&
    (Object.hasOwn(raw, "modelProviderFamilySelectedKeys") ||
      Object.hasOwn(raw, "modelProviderFamilyModes"))
  );
}

/** 仅在 settings 文件读取边界导入旧连接；运行时代码不能再解释旧导航 key。 */
export function migrateLegacyAccountConnectionSettings(value: unknown): unknown {
  if (!needsLegacyAccountConnectionMigration(value)) return value;
  const raw = record(value);
  const modes = record(raw.modelProviderFamilyModes);
  const keys = record(raw.modelProviderFamilySelectedKeys);
  const selections: ProviderFamilyConnectionSelectionSettings = {};
  for (const family of ["zai", "bigmodel"] as const) {
    // API 实例由 Provider 配置迁移负责；旧 API 模式不是一个账号套餐。
    if (modes[family] === "apiKey") continue;
    const key = typeof keys[family] === "string" ? keys[family].trim() : "";
    if (key === `coding-plan:builtin:${family}-start-plan`) {
      selections[family] = { kind: "start-plan" };
    } else if (key === `coding-plan:builtin:${family}-coding-plan`) {
      selections[family] = { kind: "individual-coding-plan" };
    } else {
      const prefix = `team-plan:builtin:${family}-coding-plan:`;
      if (!key.startsWith(prefix)) continue;
      try {
        const parts = key
          .slice(prefix.length)
          .split(":")
          .map((part) => decodeURIComponent(part).trim());
        // 旧 project-only key 无法确定组织，保留原字段而非捏造新版 Team 身份。
        if (parts.length !== 3 || parts.some((part) => !part)) continue;
        const [productId, organizationId, projectId] = parts as [string, string, string];
        selections[family] = { kind: "team-coding-plan", productId, organizationId, projectId };
      } catch {
        // 损坏的编码只影响这一项，不能让整个 setting.json 回退成默认值。
      }
    }
  }
  return { ...raw, providerFamilyConnectionSelections: selections };
}

/** 旧字段仅供回滚保留，禁止暴露回 AppSettings 或参与当前运行判断；退役旧版后删除。 */
export function retainLegacyAccountConnectionFields(value: unknown): Record<string, unknown> {
  const raw = record(value);
  return Object.fromEntries(
    ["modelProviderFamilyModes", "modelProviderFamilySelectedKeys"]
      .filter((key) => Object.hasOwn(raw, key))
      .map((key) => [key, raw[key]]),
  );
}
