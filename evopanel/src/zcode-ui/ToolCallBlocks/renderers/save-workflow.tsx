import { Save } from "lucide-react";
import { useMemo } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ToolSnapshotFieldNotice } from "@/ToolCallBlocks/ToolSnapshotFieldNotice.js";
import { ToolLayout } from "../ToolLayout.js";
import type { ToolCallBlockRenderContext } from "../shared.js";

const SAVE_WORKFLOW_TOOL_ICON = <Save className="size-4 shrink-0 text-foreground-subtle" />;

/**
 * 覆盖徽标的样式：与 CreateWorkflow 结果卡的 compiled 小签同族（镌刻小签——rounded-xs +
 * 大写等宽微标签），只把语义色换成 warning。用 warning 而不是 destructive 是刻意的：
 * 文件是被**替换**，不是被删除，destructive 会过度表达；而覆盖是真实的语义状态，
 * 不属于 DESIGN.md 禁止的「借语义色让区块更响」。
 */
const OVERWRITE_BADGE_CLASSNAME =
  "shrink-0 rounded-xs border border-warning/40 px-1.5 py-0.5 font-mono text-ui-xs uppercase tracking-wf-label leading-none text-warning";

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** SaveWorkflow 归一化入参里的一条 args 声明。 */
export interface WorkflowArgDeclaration {
  name: string;
  type: string | undefined;
  description: string | undefined;
  required: boolean;
  /** `default` 是否在场——`default: false` 与「没有默认值」必须可分辨。 */
  hasDefault: boolean;
  defaultValue: unknown;
}

/**
 * SaveWorkflow 的归一化入参（可复用工作流 spec 的「SaveWorkflow 的归一化形状」）：
 * `{name, description, whenToUse?, args?, script, path, overwrite, scope}`。
 *
 * `path` / `overwrite` / `scope` 是解析阶段算出来的事实，不是模型说的——确认窗展示的是
 * 「将要发生的事实」。这个 gate 没有 display 载荷，入参就是全部内容。
 */
interface SaveWorkflowInput {
  name: string | undefined;
  description: string | undefined;
  whenToUse: string | undefined;
  path: string | undefined;
  scope: string | undefined;
  /** 另一档已有同名时的遮蔽事实（解析阶段算出，走入参通道，理由同 path / overwrite）。 */
  shadowing: "hides_global" | "hidden_by_project" | undefined;
  overwrite: boolean;
  script: string | undefined;
  args: WorkflowArgDeclaration[];
}

function readArgDeclarations(value: unknown): WorkflowArgDeclaration[] {
  if (!isPlainRecord(value)) {
    return [];
  }

  const declarations: WorkflowArgDeclaration[] = [];
  for (const [name, declaration] of Object.entries(value)) {
    if (!isPlainRecord(declaration)) {
      continue;
    }
    declarations.push({
      name,
      type: readTrimmedString(declaration.type),
      description: readTrimmedString(declaration.description),
      required: declaration.required === true,
      hasDefault: "default" in declaration,
      defaultValue: declaration.default,
    });
  }
  return declarations;
}

export function readSaveWorkflowInput(input: unknown): SaveWorkflowInput {
  const record = isPlainRecord(input) ? input : {};

  return {
    name: readTrimmedString(record.name),
    description: readTrimmedString(record.description),
    whenToUse: readTrimmedString(record.whenToUse),
    path: readTrimmedString(record.path),
    scope: readTrimmedString(record.scope),
    shadowing:
      record.shadowing === "hides_global" || record.shadowing === "hidden_by_project"
        ? record.shadowing
        : undefined,
    // 只有显式 true 才是覆盖：字段缺席时说不出「已经有一个文件在那儿」，
    // 就不能让确认窗替用户断言这件事。
    overwrite: record.overwrite === true,
    script:
      typeof record.script === "string" && record.script.length > 0 ? record.script : undefined,
    args: readArgDeclarations(record.args),
  };
}

export function SaveWorkflowOverwriteBadge({ label }: { label: string }) {
  return (
    <span className={OVERWRITE_BADGE_CLASSNAME} data-workflow-overwrite-badge="true">
      {label}
    </span>
  );
}

/**
 * 全局作用域折叠行小标：与 overwrite 徽标同一族（镌刻小签），语义色改为 foreground-subtle——
 * 它只是一个作用域说明，不是警示状态，不借 warning / destructive。
 */
const SCOPE_BADGE_CLASSNAME =
  "shrink-0 rounded-xs border border-border px-1.5 py-0.5 font-mono text-ui-xs uppercase tracking-wf-label leading-none text-foreground-subtle";

function SaveWorkflowScopeBadge({ label }: { label: string }) {
  return (
    <span className={SCOPE_BADGE_CLASSNAME} data-workflow-scope-badge="global">
      {label}
    </span>
  );
}

/**
 * SaveWorkflow 的聊天卡：刻意紧凑——名字、覆盖标记、说明。
 *
 * 完整内容（落点、args 声明表、脚本）归确认窗：那才是用户做决定的地方，而这张卡是决定
 * 之后的一行记录。
 */
export function SaveWorkflowToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl } = useZCodeIntl();
  const { toolCall } = context.toolCallNode;

  const saved = useMemo(() => readSaveWorkflowInput(toolCall.input), [toolCall.input]);

  const kindLabel = intl.formatMessage({
    id: context.isRunning
      ? "chat.toolCall.workflow.save.saving"
      : "chat.toolCall.workflow.save.saved",
  });
  const fallbackName = intl.formatMessage({ id: "chat.toolCall.workflow.fallbackName" });
  const overwriteLabel = intl.formatMessage({ id: "chat.toolCall.workflow.save.overwrite" });
  const pathLabel = intl.formatMessage({ id: "chat.permission.workflow.save.path" });
  const whenToUseLabel = intl.formatMessage({ id: "chat.permission.workflow.save.whenToUse" });
  const isGlobalScope = saved.scope === "global";
  const isProjectScope = saved.scope === "project";
  const scopeLabel = intl.formatMessage({ id: "chat.toolCall.workflow.save.scope.label" });
  const globalBadgeLabel = intl.formatMessage({ id: "chat.toolCall.workflow.scope.global" });
  const scopeValue = isGlobalScope
    ? intl.formatMessage({ id: "chat.toolCall.workflow.save.scope.global" })
    : isProjectScope
      ? intl.formatMessage({ id: "chat.toolCall.workflow.save.scope.project" })
      : null;
  const shadowingLabel =
    saved.shadowing === "hides_global"
      ? intl.formatMessage({ id: "chat.toolCall.workflow.save.scope.hidesGlobal" })
      : saved.shadowing === "hidden_by_project"
        ? intl.formatMessage({ id: "chat.toolCall.workflow.save.scope.hiddenByProject" })
        : null;

  const primaryText = useMemo(
    () => (
      <span className="truncate font-mono text-foreground-subtlest">
        {saved.name ?? fallbackName}
      </span>
    ),
    [fallbackName, saved.name],
  );

  const kindDetail = useMemo(
    () =>
      // 折叠行：全局档加一个「全局」小标，与 overwrite 徽标同排（未知/项目档不加）。
      saved.overwrite || isGlobalScope ? (
        <span className="flex items-center gap-1">
          {saved.overwrite ? <SaveWorkflowOverwriteBadge label={overwriteLabel} /> : null}
          {isGlobalScope ? <SaveWorkflowScopeBadge label={globalBadgeLabel} /> : null}
        </span>
      ) : null,
    [globalBadgeLabel, isGlobalScope, overwriteLabel, saved.overwrite],
  );

  const renderContent = useMemo(
    () => () => (
      <div className="mb-2 space-y-1.5">
        {saved.description === undefined ? null : (
          // 折叠行只留名字 + overwrite 徽标。
          <p className="min-w-0 whitespace-pre-wrap break-words text-ui-base leading-5 text-foreground-subtle">
            {saved.description}
          </p>
        )}
        {scopeValue === null ? null : (
          // 作用域行在落点之上。
          <p className="flex min-w-0 items-baseline gap-2 text-ui-sm">
            <span className="shrink-0 text-foreground-subtlest">{scopeLabel}</span>
            <span className="min-w-0 text-foreground-subtle">{scopeValue}</span>
          </p>
        )}
        {shadowingLabel === null ? null : (
          <p className="min-w-0 whitespace-pre-wrap break-words text-ui-sm text-foreground-subtle">
            {shadowingLabel}
          </p>
        )}
        {saved.path === undefined ? null : (
          <p className="flex min-w-0 items-baseline gap-2 text-ui-sm">
            <span className="shrink-0 text-foreground-subtlest">{pathLabel}</span>
            <span className="min-w-0 truncate font-mono text-foreground-subtle" title={saved.path}>
              {saved.path}
            </span>
          </p>
        )}
        {saved.whenToUse === undefined ? null : (
          <p className="flex min-w-0 items-baseline gap-2 text-ui-sm">
            <span className="shrink-0 text-foreground-subtlest">{whenToUseLabel}</span>
            <span className="min-w-0 whitespace-pre-wrap break-words text-foreground-subtle">
              {saved.whenToUse}
            </span>
          </p>
        )}
      </div>
    ),
    [
      pathLabel,
      saved.description,
      saved.path,
      saved.whenToUse,
      scopeLabel,
      scopeValue,
      shadowingLabel,
      whenToUseLabel,
    ],
  );

  return (
    <>
      <ToolLayout
        toolId={toolCall.toolId}
        icon={SAVE_WORKFLOW_TOOL_ICON}
        showIcon={context.showIcon !== false}
        canToggle={context.canToggle ?? true}
        forceOpen={context.forceOpen ?? false}
        kindLabel={context.kindLabelOverride ?? kindLabel}
        kindDetail={kindDetail}
        sourceLabel={context.sourceLabel}
        primaryText={primaryText}
        // 刻意不传 secondaryText：折叠行只有名字（+ overwrite 徽标），说明/落点/whenToUse
        // 全部移入展开卡体——「决定之后的一行记录」越短越好读。
        statusLabel={context.statusLabel}
        statusTooltip={context.errorText}
        showFailureStatus={toolCall.status === "failed"}
        isRunning={context.isRunning}
        title={saved.description ?? toolCall.title}
        renderContent={renderContent}
      />
      <ToolSnapshotFieldNotice
        refs={toolCall.snapshotRefs ?? []}
        onLoadFullToolCallFields={
          context.onLoadFullToolCallFields
            ? () => context.onLoadFullToolCallFields?.(toolCall.toolId)
            : undefined
        }
      />
    </>
  );
}
