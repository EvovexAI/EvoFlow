/* oxlint-disable eslint(max-lines) -- summary 与同源 detail 投影暂集中维护，本次 review fix 不扩大重构范围。 */
import { type ReactNode, useCallback, useMemo } from "react";
import type { ApplicationIconRequest } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { isZCodeCuaToolName } from "@/lib/cuaPermissionAction.js";
import { ToolLayout } from "@/ToolCallBlocks/ToolLayout.js";
import { readCuaActionDetail } from "@/ToolCallBlocks/renderers/cuaActionDetail.js";
import { buildCuaAccessDetails } from "@/ToolCallBlocks/renderers/cuaAccessDetails.js";
import { CuaToolCallDetails } from "@/ToolCallBlocks/renderers/cuaDetails.js";
import { readCuaErrorDetails } from "@/ToolCallBlocks/renderers/cuaErrorDetails.js";
import { CUA_FALLBACK_ICON } from "@/ToolCallBlocks/renderers/cuaIcon.js";
import { CuaAppSummaryIcon } from "@/ToolCallBlocks/renderers/cuaAppSummaryIcon.js";
import {
  readCuaActionTargetName,
  readCuaAppName,
  readCuaResultBundleId,
  readCuaResultListCount,
  readCuaResultState,
} from "@/ToolCallBlocks/renderers/cuaResultState.js";
import {
  buildCuaDetailList,
  type CuaDetailList,
} from "@/ToolCallBlocks/renderers/cuaListDetails.js";
import {
  buildCuaScreenshotDetails,
  type CuaScreenshotDetails,
} from "@/ToolCallBlocks/renderers/cuaScreenshotDetails.js";
import { CUA_TOOL_SUMMARY_IDS } from "@/ToolCallBlocks/renderers/cuaSummaryMessages.js";
import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/shared.js";
import { readToolResultDisplay } from "@/ToolCallBlocks/toolResultDisplay.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readText(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readNumber(record: Record<string, unknown> | null, key: string): number | null {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeCuaToolName(value: string | null | undefined): string {
  return value?.trim().toLowerCase().replace(/-/g, "_") ?? "";
}

function readCuaToolName(value: string | null | undefined): string | null {
  const normalized = normalizeCuaToolName(value);
  // cua server key 段为 computer_use（feat）或 plugin namespace 里的 computer_use（main v3.5.3）。
  if (!normalized.includes("computer_use")) return null;
  // action = 最后一个 "__" 之后的段。兼容两种命名：
  //   feat:        mcp__computer_use__<action>
  //   main namesp: mcp__plugin_zcode_cua_computer_use__<action>
  // 都取尾部 <action>（get_app_state / left_click / type ...）。
  const lastSep = normalized.lastIndexOf("__");
  const shortName = lastSep >= 0 ? normalized.slice(lastSep + 2) : normalized;
  return /^[a-z0-9_]+$/u.test(shortName) ? shortName : null;
}

function readRawToolName(raw: unknown): string | null {
  const record = asRecord(raw);
  for (const key of ["toolName", "tool_name", "name"] as const) {
    const value = readText(record, key);
    if (value) return value;
  }
  return null;
}

function readCuaUserTitle(
  toolCall: ToolCallBlockRenderContext["toolCallNode"]["toolCall"],
): string | null {
  const raw = asRecord(toolCall.raw);
  for (const input of [asRecord(toolCall.input), asRecord(raw?.rawInput), asRecord(raw?.input)]) {
    const title = readText(input, "title");
    if (title) return title;
  }
  return null;
}

function collectToolNames(
  toolCall: ToolCallBlockRenderContext["toolCallNode"]["toolCall"],
): Array<string | null | undefined> {
  return [toolCall.toolName, toolCall.kind, toolCall.title, readRawToolName(toolCall.raw)];
}

function readBundleId(input: unknown): string | null {
  const record = asRecord(input);
  for (const container of [asRecord(record?.app), asRecord(record?.app_ref), record]) {
    const bundleId = readText(container, "bundle_id") ?? readText(container, "bundleId");
    if (bundleId) return bundleId;
  }
  return null;
}

function readCuaApplicationIconRequest(
  toolCall: ToolCallBlockRenderContext["toolCallNode"]["toolCall"],
): ApplicationIconRequest | string | null {
  const display = readToolResultDisplay(toolCall.raw);
  if (display?.kind === "cua" && display.targetApp) {
    return display.targetApp.iconLocators.length > 0
      ? { locators: display.targetApp.iconLocators }
      : null;
  }
  // 历史记录没有 authority metadata 时继续兼容旧 bundle_id；新记录即使 locator
  // 为空也不回退模型 input，避免身份冲突后重新显示未经 Helper 校验的图标。
  return readBundleId(toolCall.input) ?? readCuaResultBundleId(toolCall);
}

interface CuaDetailRow {
  labelId: string;
  value: string;
  code?: boolean;
  status?: boolean;
}

export interface CuaDetailsModel {
  actionRows: CuaDetailRow[];
  resultId: string;
  resultValues?: Record<string, string>;
  stateRows: CuaDetailRow[];
  success: boolean;
  list?: CuaDetailList;
  permissionRows?: CuaDetailRow[];
  environmentRows?: CuaDetailRow[];
  screenshot?: CuaScreenshotDetails;
  failureReasonId?: string;
  failureReason?: string;
  suggestedActionId?: string;
  suggestedAction?: string;
}

function readTargetDescription(
  input: unknown,
): { id: string; values: Record<string, string> } | null {
  const target = asRecord(asRecord(input)?.target);
  if (target?.type === "element" && typeof target.index === "number") {
    return {
      id: "chat.toolCall.cua.details.elementTarget",
      values: { index: String(target.index) },
    };
  }
  if (
    target?.type === "coordinate" &&
    typeof target.x === "number" &&
    typeof target.y === "number"
  ) {
    return {
      id: "chat.toolCall.cua.details.coordinateTarget",
      values: { x: String(target.x), y: String(target.y) },
    };
  }
  return null;
}

function buildCuaDetailsModel(
  toolName: string,
  toolCall: ToolCallBlockRenderContext["toolCallNode"]["toolCall"],
  formatTarget: (id: string, values: Record<string, string>) => string,
): CuaDetailsModel {
  const input = asRecord(toolCall.input);
  const result = readCuaResultState(toolCall);
  const appName = readCuaAppName(input, result);
  const stateRows: CuaDetailRow[] = [];
  const actionRows: CuaDetailRow[] = [];
  const actionDetail = readCuaActionDetail(toolName, input);
  const typedText = toolName === "type" ? readText(input, "text") : null;
  const openUrl = readText(asRecord(input?.app), "url");
  const target = readTargetDescription(input);
  const list = buildCuaDetailList(toolName, toolCall);
  const access =
    toolName === "request_access"
      ? buildCuaAccessDetails(toolCall, (id) => formatTarget(id, {}))
      : null;
  const screenshotCandidate =
    toolName === "screenshot" || toolName === "zoom"
      ? buildCuaScreenshotDetails(toolCall)
      : undefined;
  const error = readCuaErrorDetails(toolCall);
  const display = readToolResultDisplay(toolCall.raw);
  const cuaDisplay = display?.kind === "cua" ? display : undefined;
  const waitDuration = toolName === "wait" ? readNumber(input, "duration") : null;

  if (!appName && error?.targetAppName)
    actionRows.push({
      labelId: "chat.toolCall.cua.details.app",
      value: error.targetAppName,
    });

  if (!access && appName)
    actionRows.push({
      labelId: "chat.toolCall.cua.details.app",
      value: appName,
    });
  if (!access && toolName !== "list_apps" && toolName !== "screenshot") {
    actionRows.push({
      labelId: "chat.toolCall.cua.details.operation",
      value: formatTarget(CUA_TOOL_SUMMARY_IDS[toolName] ?? "chat.toolCall.cua.default", {}),
    });
  }
  if (actionDetail || typedText || openUrl) {
    actionRows.push({
      labelId: "chat.toolCall.cua.details.value",
      value: actionDetail ?? typedText ?? openUrl ?? "",
      code: true,
    });
  }
  if (waitDuration !== null)
    actionRows.push({
      labelId: "chat.toolCall.cua.details.duration",
      value: formatTarget("chat.toolCall.cua.seconds", {
        duration: String(waitDuration),
      }),
    });
  if (target) {
    actionRows.push({
      labelId: "chat.toolCall.cua.details.target",
      value: formatTarget(target.id, target.values),
    });
  }

  const stateId = readText(result, "state_id");
  const windowTitle = readText(asRecord(result?.window), "title");
  const focusedElement = result?.focused_element;
  const changes = asRecord(result?.changes);
  if (!stateId && error?.stateId)
    stateRows.push({
      labelId: "chat.toolCall.cua.details.stateId",
      value: error.stateId,
      code: true,
    });
  if (stateId)
    stateRows.push({
      labelId: "chat.toolCall.cua.details.stateId",
      value: stateId,
      code: true,
    });
  if (windowTitle)
    stateRows.push({
      labelId: "chat.toolCall.cua.details.window",
      value: windowTitle,
    });
  if (typeof focusedElement === "number") {
    stateRows.push({
      labelId: "chat.toolCall.cua.details.focus",
      value: formatTarget("chat.toolCall.cua.details.elementTarget", {
        index: String(focusedElement),
      }),
    });
  }
  if (typeof changes?.added_count === "number" || typeof changes?.removed_count === "number") {
    stateRows.push({
      labelId: "chat.toolCall.cua.details.changes",
      value: formatTarget("chat.toolCall.cua.details.changeCounts", {
        added: String(typeof changes?.added_count === "number" ? changes.added_count : 0),
        removed: String(typeof changes?.removed_count === "number" ? changes.removed_count : 0),
      }),
    });
  }

  // MCP transport completed 不代表 CUA 动作成功；新 session 优先采用 display 状态。
  const errorCode = cuaDisplay?.errorCode ?? error?.code;
  const success =
    cuaDisplay?.status !== "failed" &&
    toolCall.status !== "failed" &&
    !error &&
    (access?.ready ?? true);
  // 失败截图也创建详情模型时会渲染无效截图占位；失败原因区已足够。
  const screenshot = success ? screenshotCandidate : undefined;
  const resultValues: Record<string, string> | undefined = list
    ? { count: String(list.items.length) }
    : waitDuration !== null
      ? { duration: String(waitDuration) }
      : undefined;
  const resultId = !success
    ? access
      ? "chat.toolCall.cua.details.accessIncomplete"
      : errorCode === "element_stale"
        ? "chat.toolCall.cua.details.elementStale"
        : "chat.toolCall.cua.details.failed"
    : access
      ? "chat.toolCall.cua.details.accessReady"
      : toolName === "type" && typedText
        ? "chat.toolCall.cua.details.typed"
        : toolName === "key"
          ? "chat.toolCall.cua.details.keyPressed"
          : toolName === "open_application"
            ? "chat.toolCall.cua.details.opened"
            : toolName === "get_app_state"
              ? "chat.toolCall.cua.details.observed"
              : toolName === "screenshot"
                ? "chat.toolCall.cua.details.screenshotCaptured"
                : toolName === "wait" && waitDuration !== null
                  ? "chat.toolCall.cua.details.waited"
                  : toolName === "zoom"
                    ? "chat.toolCall.cua.details.zoomed"
                    : toolName === "list_apps"
                      ? list?.items.length
                        ? "chat.toolCall.cua.details.appsFound"
                        : "chat.toolCall.cua.details.noApps"
                      : toolName === "list_windows"
                        ? list?.items.length
                          ? "chat.toolCall.cua.details.windowsFound"
                          : "chat.toolCall.cua.details.noWindows"
                        : "chat.toolCall.cua.details.completed";
  return {
    actionRows,
    resultId,
    resultValues,
    stateRows,
    success,
    list,
    permissionRows: access?.permissionRows,
    environmentRows: access?.environmentRows,
    screenshot,
    failureReasonId:
      errorCode === "element_stale" ? "chat.toolCall.cua.details.elementStaleReason" : undefined,
    failureReason:
      errorCode !== "element_stale" && cuaDisplay?.status === "failed"
        ? (cuaDisplay.text ?? cuaDisplay.errorCode)
        : undefined,
    suggestedActionId:
      errorCode === "element_stale" ? "chat.toolCall.cua.details.elementStaleAction" : undefined,
    suggestedAction: errorCode !== "element_stale" ? cuaDisplay?.suggestedAction : undefined,
  };
}

export function isCuaToolCall(
  toolCall: ToolCallBlockRenderContext["toolCallNode"]["toolCall"],
): boolean {
  return collectToolNames(toolCall).some(isZCodeCuaToolName);
}

interface CuaSummaryPresentation {
  toolName: string | null;
  icon: ReactNode;
  appName: string;
  primaryText: ReactNode;
  description: string;
  title: string;
  isFailed: boolean;
  failureText?: string;
}

type CuaIntl = ReturnType<typeof useZCodeIntl>["intl"];

export function buildCuaSummaryPresentation(
  toolCall: ToolCallBlockRenderContext["toolCallNode"]["toolCall"],
  intl: CuaIntl,
  options?: { fallbackErrorText?: string; appIconClassName?: "size-4" | "size-5" },
): CuaSummaryPresentation {
  const toolName = collectToolNames(toolCall).map(readCuaToolName).find(Boolean) ?? null;
  const display = readToolResultDisplay(toolCall.raw);
  const cuaDisplay = display?.kind === "cua" ? display : null;
  const isFailed = cuaDisplay ? cuaDisplay.status === "failed" : toolCall.status === "failed";
  const failureText =
    cuaDisplay?.status === "failed"
      ? (cuaDisplay.text ?? options?.fallbackErrorText)
      : options?.fallbackErrorText;
  const rawCuaApp = asRecord(asRecord(toolCall.raw)?.cuaApp);
  const result = readCuaResultState(toolCall);
  const resultApp = asRecord(result?.app);
  const genericAppName = intl.formatMessage({ id: "chat.toolCall.cua.appName" });
  const appName =
    cuaDisplay?.targetApp?.displayName ??
    readText(resultApp, "name") ??
    readText(rawCuaApp, "name") ??
    genericAppName;
  const bundleId =
    readText(resultApp, "bundle_id") ??
    readText(resultApp, "bundleId") ??
    readText(rawCuaApp, "bundleId") ??
    undefined;
  const rawActionTarget =
    toolName === "left_click" || toolName === "right_click" || toolName === "type"
      ? readCuaActionTargetName(toolCall)
      : null;
  // CUA 无法解析元素可读名称时会返回纯数字 index；直接把 `57` 放进 tag
  // 看起来像无上下文的值，因此明确标注为本地化的元素编号。
  const actionTarget =
    rawActionTarget && /^\d+$/u.test(rawActionTarget)
      ? intl.formatMessage({ id: "chat.toolCall.cua.elementTarget" }, { index: rawActionTarget })
      : rawActionTarget;
  const keyName =
    toolName === "key" || toolName === "hold_key"
      ? readCuaActionDetail(toolName, toolCall.input)
      : null;
  const authoredDescription = toolName === "get_app_state" ? readCuaUserTitle(toolCall) : null;
  const listCount = toolName === "list_windows" ? readCuaResultListCount(toolCall) : null;
  const actionId =
    toolName === "type"
      ? "chat.toolCall.cua.type"
      : toolName === "right_click"
        ? "chat.toolCall.cua.rightClick"
        : "chat.toolCall.cua.leftClick";
  const description =
    authoredDescription ??
    (actionTarget
      ? intl.formatMessage({ id: actionId })
      : keyName
        ? intl.formatMessage({
            id:
              toolName === "hold_key"
                ? "chat.toolCall.cua.holdKey"
                : "chat.toolCall.cua.pressKeyAction",
          })
        : listCount !== null
          ? intl.formatMessage({ id: "chat.toolCall.cua.listWindowsCount" }, { count: listCount })
          : intl.formatMessage({
              id: CUA_TOOL_SUMMARY_IDS[toolName ?? ""] ?? "chat.toolCall.cua.default",
            }));
  const taggedTarget = actionTarget ?? keyName;
  const primaryText =
    taggedTarget && !authoredDescription ? (
      <span className="inline-flex min-w-0 items-center gap-1">
        <span className="shrink-0">{description}</span>
        <span className="cua-action-target min-w-0 truncate rounded-full border border-border px-1.5 text-ui-sm text-foreground-subtlest">
          {taggedTarget}
        </span>
      </span>
    ) : (
      description
    );

  return {
    toolName,
    icon:
      appName === genericAppName ? (
        CUA_FALLBACK_ICON
      ) : (
        <CuaAppSummaryIcon
          bundleId={bundleId}
          iconRequest={readCuaApplicationIconRequest(toolCall)}
          name={appName}
          className={options?.appIconClassName}
        />
      ),
    appName,
    primaryText,
    description,
    title: `${appName} ${description}`,
    isFailed,
    ...(failureText ? { failureText } : {}),
  };
}

export function CuaToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl } = useZCodeIntl();
  const { toolCall } = context.toolCallNode;
  const summary = buildCuaSummaryPresentation(toolCall, intl, {
    fallbackErrorText: context.errorText,
    appIconClassName: context.cuaAppIconClassName,
  });
  const { toolName } = summary;
  const isActive =
    context.isRunning || toolCall.status === "pending" || toolCall.status === "in_progress";
  const detailsModel = useMemo(
    () =>
      toolName
        ? buildCuaDetailsModel(toolName, toolCall, (id, values) =>
            intl.formatMessage({ id }, values),
          )
        : null,
    [intl, toolCall, toolName],
  );
  const renderContent = useCallback(
    () => (detailsModel ? <CuaToolCallDetails model={detailsModel} toolCall={toolCall} /> : null),
    [detailsModel, toolCall],
  );

  return (
    <ToolLayout
      toolId={toolCall.toolId}
      icon={
        context.cuaAppIconClassName === "size-5" ? (
          <span className="shrink-0 size-4 flex items-center justify-center">{summary.icon}</span>
        ) : (
          summary.icon
        )
      }
      showIcon={context.showIcon !== false}
      canToggle={!isActive && (context.canToggle ?? true)}
      forceOpen={
        !isActive &&
        !(summary.isFailed && toolName === "screenshot") &&
        (context.forceOpen ?? false)
      }
      kindLabel={summary.appName}
      primaryText={summary.primaryText}
      statusLabel={
        summary.isFailed ? intl.formatMessage({ id: "chat.toolCall.status.failed" }) : undefined
      }
      statusTooltip={summary.isFailed ? summary.failureText : undefined}
      showFailureStatus={summary.isFailed}
      isRunning={context.isRunning}
      title={summary.title}
      renderContent={renderContent}
    />
  );
}
