// ============================================================
// 设置轮的两处文字
// ============================================================
// 一次「配置」在两个面上留下记录：转写里 run 卡上方的一行「已调整设置 · 子代理改用 X · 最多 N 个
// 同时运行」，与详情页的来龙去脉块「由你调整设置」下的 from → to 两行。两处读同一块 `amend` 元数据，
// 措辞规则只在这里写一次。纯函数 + 注入的 formatMessage / providerName，与 subagent-model-label 同规。

import type { WorkflowSettingsAmendMeta } from "@zcode/shared/zcode-protocol-v4";
import {
  describeWorkflowSubagentModel,
  type WorkflowSubagentModelDeps,
} from "./subagent-model-label.js";

/** 模型的屏幕名：只要名字（档位留给 tooltip），与 run 卡上的模型段同一个词。 */
function modelName(canonical: string, deps: WorkflowSubagentModelDeps): string {
  return describeWorkflowSubagentModel(canonical, deps).name;
}

/**
 * 转写行的各段（不含开头的「已调整设置」与末尾时刻）：只有改过的设置在场，模型在前、上限在后。
 * 上限的 `to` 缺席或不低于天花板，都读作「上限恢复为本机默认」。
 */
export function workflowSettingsChangeSegments(
  amend: WorkflowSettingsAmendMeta,
  deps: WorkflowSubagentModelDeps,
): string[] {
  const { formatMessage } = deps;
  const segments: string[] = [];
  if (amend.subagentModel !== undefined) {
    const to = amend.subagentModel.to;
    segments.push(
      to === undefined
        ? formatMessage({ id: "chat.toolCall.workflow.settingsChange.modelSession" })
        : formatMessage(
            { id: "chat.toolCall.workflow.settingsChange.model" },
            { model: modelName(to, deps) },
          ),
    );
  }
  if (amend.maxConcurrency !== undefined) {
    const to = amend.maxConcurrency.to;
    const atCeiling = to === undefined || (amend.ceiling !== undefined && to >= amend.ceiling);
    segments.push(
      atCeiling
        ? formatMessage({ id: "chat.toolCall.workflow.settingsChange.limitCeiling" })
        : formatMessage({ id: "chat.toolCall.workflow.settingsChange.limit" }, { n: to }),
    );
  }
  return segments;
}

export interface WorkflowSettingsProvenanceRow {
  key: "model" | "limit";
  label: string;
  /** 「{from} → {to}」。 */
  value: string;
}

/**
 * 详情页来龙去脉块的 from → to 行。缺席的一端写默认：模型写「会话模型」，上限写本机上限（知道
 * 天花板时带上数字，「13（本机上限）→ 4」）。
 */
export function workflowSettingsProvenanceRows(
  amend: WorkflowSettingsAmendMeta,
  deps: WorkflowSubagentModelDeps,
): WorkflowSettingsProvenanceRow[] {
  const { formatMessage } = deps;
  const rows: WorkflowSettingsProvenanceRow[] = [];
  if (amend.subagentModel !== undefined) {
    const end = (canonical: string | undefined) =>
      canonical === undefined
        ? formatMessage({ id: "chat.workflowLaunch.settings.sessionModel" })
        : modelName(canonical, deps);
    rows.push({
      key: "model",
      label: formatMessage({ id: "chat.workflowLaunch.settings.model" }),
      value: `${end(amend.subagentModel.from)} → ${end(amend.subagentModel.to)}`,
    });
  }
  if (amend.maxConcurrency !== undefined) {
    const ceiling = amend.ceiling;
    const end = (bound: number | undefined) =>
      bound !== undefined && (ceiling === undefined || bound < ceiling)
        ? String(bound)
        : ceiling === undefined
          ? formatMessage({ id: "chat.workflowLaunch.settings.machineLimit" })
          : formatMessage({ id: "chat.workflowLaunch.settings.machineLimitValue" }, { n: ceiling });
    rows.push({
      key: "limit",
      label: formatMessage({ id: "chat.workflowLaunch.settings.limit" }),
      value: `${end(amend.maxConcurrency.from)} → ${end(amend.maxConcurrency.to)}`,
    });
  }
  return rows;
}
