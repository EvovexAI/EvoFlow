import { ClipboardCheckIcon } from "lucide-react";
import { useCallback, useMemo } from "react";
import { CodeBlock } from "@/components/ai-elements/code-block.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ToolSnapshotFieldNotice } from "@/ToolCallBlocks/ToolSnapshotFieldNotice.js";
import { ToolLayout } from "@/ToolCallBlocks/ToolLayout.js";
import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/shared.js";

const SUBMIT_RESULT_TOOL_ICON = (
  <ClipboardCheckIcon className="size-4 shrink-0 text-foreground-subtle" />
);

/** 折叠头部的单行概要上限：概要只是「大概提交了什么」，整段内容在展开后的 body 里。 */
const INLINE_PREVIEW_MAX_LENGTH = 160;

function toRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }

  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function readText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/**
 * 提交内容的读时归一化：字符串先试**一次**宽容 `JSON.parse`，解析出对象/数组才用解析值。
 *
 * 这是引擎侧实盘结论的读侧镜像——`engine/scheduler.ts` 记档「真实模型常把 result 序列化成
 * JSON 字符串」并做同款单次宽容 parse。不做多层递归 parse（引擎也只做一次），解析失败就按
 * 字符串对待，绝不抛错毁卡，也绝不改写任何数据。
 */
function normalizeSubmittedResult(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  if (value.trim().length === 0) {
    return value;
  }

  try {
    const parsed: unknown = JSON.parse(value);
    // 数字 / 布尔 / null 的字面量字符串保持原样：那是模型写的那句话，不是结构化载荷。
    return typeof parsed === "object" && parsed !== null ? parsed : value;
  } catch {
    return value;
  }
}

/** JSON 分支的缩进文本。循环引用之类的病态载荷退回 `String(...)`，卡片不能因载荷而崩。 */
function stringifyResult(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/** 折叠头部的单行概要：换行折叠成空格，超长截断。 */
function toInlinePreview(value: unknown): string | undefined {
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else {
    try {
      text = JSON.stringify(value) ?? String(value);
    } catch {
      text = String(value);
    }
  }

  const collapsed = text.replace(/\s+/gu, " ").trim();
  if (collapsed.length === 0) {
    return undefined;
  }

  return collapsed.length > INLINE_PREVIEW_MAX_LENGTH
    ? `${collapsed.slice(0, INLINE_PREVIEW_MAX_LENGTH)}…`
    : collapsed;
}

export function SubmitResultToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl } = useZCodeIntl();
  const { toolCall } = context.toolCallNode;
  const input = toRecord(toolCall.input);
  // 修复原因照 send-message：streaming 首帧的 input 可能还是 `{}`，不能为一个空面板提供
  // 展开入口。门是「result 键在场」而不是「result 有值」——提交 null 也是一次真实提交。
  const hasResult = input !== undefined && "result" in input;
  const normalizedResult = useMemo(
    () => (hasResult ? normalizeSubmittedResult(input?.result) : undefined),
    [hasResult, input?.result],
  );
  const isProse = typeof normalizedResult === "string";

  const isRejected = toolCall.status === "failed";
  // 拒绝与停止在卡面上是同一句话：提交没走完。spec 只定义四相，不为 denied 造第五个词条。
  const isStopped = toolCall.status === "stopped" || toolCall.status === "denied";
  const isSubmitting =
    !isRejected &&
    !isStopped &&
    (context.isRunning || toolCall.status === "pending" || toolCall.status === "in_progress");
  const kindLabelId = isRejected
    ? "chat.toolCall.submitResult.rejected"
    : isStopped
      ? "chat.toolCall.submitResult.stopped"
      : isSubmitting
        ? "chat.toolCall.submitResult.submitting"
        : "chat.toolCall.submitResult.submitted";

  // 驳回原文：错误通道优先，其次工具自己的错误字段与纯文本输出。接受态的输出恒为
  // 「The result was accepted.」，没有信息量，从不读。
  const rejectionText = isRejected
    ? (context.errorText ?? readText(toolCall.error) ?? readText(toolCall.output))
    : undefined;
  // 驳回态是扁平行，不给展开入口；驳回原文走失败态 tooltip（可悬停复制），不再有逐字段
  // 违规面板。rejectionText 只在驳回态存在，故非驳回态的展开门只看 result 键是否在场。
  const hasDetails = !isRejected && hasResult;

  const resultLabel = intl.formatMessage({ id: "chat.toolCall.submitResult.resultHeading" });
  const inlinePreview = useMemo(
    () => (hasResult ? toInlinePreview(normalizedResult) : undefined),
    [hasResult, normalizedResult],
  );
  const primaryText = useMemo(
    () => (
      <span className="min-w-0 truncate">{inlinePreview ?? toolCall.title ?? "submit_result"}</span>
    ),
    [inlinePreview, toolCall.title],
  );

  const theme = context.theme;
  const renderContent = useCallback(
    () => (
      <div className="space-y-3">
        {hasResult ? (
          <section className="space-y-1.5">
            <h4 className="text-ui-sm font-medium text-foreground-subtlest">{resultLabel}</h4>
            {isProse ? (
              // 人话是 prose：DESIGN.md 把 mono 留给路径/命令/代码/标识符/终端数据。
              // 刻意不做 markdown 渲染——result 字符串没有 markdown 契约。
              <p className="whitespace-pre-wrap break-words rounded-lg border border-border bg-panel px-4 py-3 text-ui-base leading-5 text-foreground">
                {normalizedResult as string}
              </p>
            ) : (
              // 结构化载荷走 CodeBlock（尊重用户的代码字号设置），容器逐字照 mcp.tsx。
              <div className="max-h-72 overflow-auto rounded-xl border border-border bg-card">
                <CodeBlock
                  appTheme={theme}
                  code={stringifyResult(normalizedResult)}
                  language="json"
                />
              </div>
            )}
          </section>
        ) : null}
      </div>
    ),
    [hasResult, isProse, normalizedResult, resultLabel, theme],
  );

  return (
    <>
      <ToolLayout
        toolId={toolCall.toolId}
        icon={SUBMIT_RESULT_TOOL_ICON}
        showIcon={context.showIcon !== false}
        canToggle={hasDetails && (context.canToggle ?? true)}
        forceOpen={hasDetails && (context.forceOpen ?? false)}
        hideSecondaryTextWhenOpen
        kindLabel={intl.formatMessage({ id: kindLabelId })}
        sourceLabel={context.sourceLabel}
        primaryText={primaryText}
        statusLabel={
          isRejected ? intl.formatMessage({ id: "chat.toolCall.status.failed" }) : undefined
        }
        statusTooltip={isRejected ? rejectionText : undefined}
        showFailureStatus={isRejected}
        isRunning={context.isRunning}
        title={toolCall.title}
        renderContent={hasDetails ? renderContent : undefined}
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
