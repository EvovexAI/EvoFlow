import type { DatabaseSync } from "node:sqlite";
import type { ModelSelection } from "@zcode/shared";

// 冻结 0002 的发布前已裁决编码；不能调用将来可能修改的运行时 parser/身份表。
// 保持与旧 decodeCustomModelValue / parseModelPickerValue 的转义和分隔优先级一致。
const providerNames: Readonly<Record<string, string>> = {
  "builtin:bigmodel": "bigmodel-api",
  "builtin:zai": "zai-api",
  "builtin:bigmodel-start-plan": "account:bigmodel-start-plan",
  "builtin:zai-start-plan": "account:zai-start-plan",
  "builtin:bigmodel-coding-plan": "account:bigmodel-individual-coding-plan",
  "builtin:zai-coding-plan": "account:zai-individual-coding-plan",
};
function decodeComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

interface LegacySelectionRow {
  automation_id: string;
  model: string | null;
  provider: string | null;
  thought_level: string | null;
}

function decodeLegacySelection(row: LegacySelectionRow): ModelSelection | undefined {
  const value = row.model?.trim();
  if (!value) return undefined;
  let provider = row.provider?.trim() ?? "";
  let model = value;
  let reasoningLevel = row.thought_level?.trim();
  if (value.startsWith("custom:")) {
    const body = value.slice(7);
    const separator = body.indexOf(":");
    if (separator < 0) return undefined;
    const parts = body.split(":");
    if (parts.length >= 3 && parts[0] === "builtin") {
      provider = `builtin:${parts[1]}`;
      model = decodeComponent(parts.slice(2).join(":"));
    } else {
      provider = decodeComponent(body.slice(0, separator));
      model = decodeComponent(body.slice(separator + 1));
    }
  } else if (value.includes("/")) {
    const separator = value.indexOf("/");
    provider = value.slice(0, separator);
    model = value.slice(separator + 1);
    const levelSeparator = model.indexOf("$");
    if (levelSeparator > 0 && levelSeparator < model.length - 1) {
      reasoningLevel = model.slice(levelSeparator + 1).trim();
      if (!reasoningLevel) return undefined;
      model = model.slice(0, levelSeparator);
    }
  } else if (["glm", "zcode"].includes(provider)) {
    // 旧 provider=glm/zcode 是执行后端，不是供应商身份。
    return undefined;
  }
  provider = provider.trim();
  model = model.trim();
  if (!provider || !model) return undefined;
  const providerId = provider.startsWith("builtin:") ? providerNames[provider] : provider;
  if (!providerId) return undefined;
  return { providerId, modelId: model, ...(reasoningLevel ? { options: { reasoningLevel } } : {}) };
}

/**
 * 冻结 0002 的一次转换：运行 Reader 只看新列，旧三列原样保留。
 * 有旧来源允许重建未发布目标值；无法确定身份留 SQL NULL，默认语义写 JSON null。
 * 必须在库级 migration 事务内调用，不得恢复逐次读取导入。
 */
export function importLegacyAutomationSelections(db: DatabaseSync): void {
  const rows = db
    .prepare(
      "SELECT automation_id, model, provider, thought_level FROM automations WHERE model IS NOT NULL",
    )
    .all() as unknown as LegacySelectionRow[];
  for (const row of rows) {
    const decoded = decodeLegacySelection(row);
    if (!decoded) {
      // 有旧显式意图但无法确定身份，不保留未发布中间态的“默认”，避免静默换模型。
      if (row.model?.trim())
        db.prepare("UPDATE automations SET model_selection=NULL WHERE automation_id=?").run(
          row.automation_id,
        );
      continue;
    }
    // 外层 IMMEDIATE 事务保证旧来源和写入同一快照；旧列/时间戳都不修改。
    db.prepare(
      `UPDATE automations SET model_selection = ?
       WHERE automation_id = ?
         AND model IS ? AND provider IS ? AND thought_level IS ?`,
    ).run(JSON.stringify(decoded), row.automation_id, row.model, row.provider, row.thought_level);
  }
  db.exec(`UPDATE automations SET model_selection='null'
    WHERE model_selection IS NULL AND (model IS NULL OR trim(model)='')`);
}
