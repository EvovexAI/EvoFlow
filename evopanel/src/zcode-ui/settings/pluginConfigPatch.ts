import type { ZCodePluginInfo, ZCodePluginUserConfigOption } from "@zcode/shared";

export type PluginOptionDraftValue = string | number | boolean | null;

interface PluginConfigPatch {
  options: Record<string, string | number | boolean>;
  clearOptionKeys: string[];
}

/**
 * 构造 Plugin 配置写入 patch。
 *
 * `configuredOptions` 是当前 scope 的 effective 值，不能在保存时当作整份 draft
 * 写回；否则 Workspace 页面只修改一个字段，也会把 User/default 的其它字段固化成
 * Workspace override。只有明确产生 draft 的字段才属于本次写入。
 */
export function buildPluginConfigPatch(
  plugin: Pick<ZCodePluginInfo, "userConfig">,
  drafts: Record<string, PluginOptionDraftValue | undefined>,
): PluginConfigPatch {
  const options: Record<string, string | number | boolean> = {};
  const clearOptionKeys: string[] = [];

  for (const [key, option] of Object.entries(plugin.userConfig ?? {}) as [
    string,
    ZCodePluginUserConfigOption,
  ][]) {
    const draft = drafts[key];
    if (draft === undefined) continue;
    if (draft === null) {
      clearOptionKeys.push(key);
      continue;
    }

    // Sensitive 的空字符串仍表示“不修改已有值”，只有 null 才是显式清除。
    if (option.sensitive && draft === "") continue;

    if (option.type === "number") {
      const numeric = typeof draft === "number" ? draft : Number(draft);
      if (Number.isFinite(numeric)) options[key] = numeric;
      continue;
    }
    options[key] = draft;
  }

  return { options, clearOptionKeys };
}
