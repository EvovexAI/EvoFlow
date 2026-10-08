import { MessageCircleQuestion } from "lucide-react";
import { useCallback, useMemo } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ToolSnapshotFieldNotice } from "@/ToolCallBlocks/ToolSnapshotFieldNotice.js";
import { ToolLayout } from "@/ToolCallBlocks/ToolLayout.js";
import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/shared.js";

const ESCALATE_TOOL_ICON = (
  <MessageCircleQuestion className="size-4 shrink-0 text-foreground-subtle" />
);

/** 折叠头部的单行概要上限：概要只是「大概问了什么」，整段问题在展开后的 body 里。 */
const INLINE_PREVIEW_MAX_LENGTH = 160;

/** 读时把 input 归一成对象：字符串先试**一次**宽容 `JSON.parse`（照 submit-result 的读侧惯例）。 */
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

/** 折叠头部的单行概要：换行折叠成空格，超长截断。 */
function toInlinePreview(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const collapsed = value.replace(/\s+/gu, " ").trim();
  if (collapsed.length === 0) return undefined;
  return collapsed.length > INLINE_PREVIEW_MAX_LENGTH
    ? `${collapsed.slice(0, INLINE_PREVIEW_MAX_LENGTH)}…`
    : collapsed;
}

/**
 * escalate 工具卡。子代理把一个**真阻塞**问题升级给
 * 主代理，并停驻在这次调用里等答案；主代理侧板挂的嵌套只读 SessionPane 走同一条 ToolCallBlocks
 * 管线，所以这张卡两个面共用。
 *
 * 折叠行：kindLabel（asking/asked）+ 问题单行概要。展开：问题（+ context 若在场）+ 答案区。
 *
 * 关键：预算已尽的驳回**是一次普通工具结果**（不是 error tool_result，见 handler 注释），所以
 * 卡片绝不因 output 文本内容把它渲染成失败——只有 `status==="failed"`（接线故障之类）才走失败
 * 样式。停驻（running）时答案还没到，in-progress 标签就是全部信息；这张卡可能停很久，running
 * 态要显得平静、不像坏了。
 */
export function EscalateToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl } = useZCodeIntl();
  const { toolCall } = context.toolCallNode;
  const input = toRecord(toolCall.input);
  const question = readText(input?.question);
  const questionContext = readText(input?.context);

  const isFailed = toolCall.status === "failed";
  // 停驻中：still running / pending / in_progress 且未失败——答案尚未回来。
  const isAsking =
    !isFailed &&
    (context.isRunning || toolCall.status === "pending" || toolCall.status === "in_progress");

  // 答案文本 = 模型面内容：answered 时是主代理的答案原文，refused 时是端口写好的文案。
  // 两支都是普通结果（handler 的 formatModelContent 只返回 message），只按 output 读。
  const answerText = isAsking ? undefined : readText(toolCall.output);

  const kindLabel = intl.formatMessage({
    id: isAsking
      ? "chat.toolCall.workflow.escalate.asking"
      : "chat.toolCall.workflow.escalate.asked",
  });
  const questionHeading = intl.formatMessage({ id: "chat.toolCall.workflow.escalate.question" });
  const contextHeading = intl.formatMessage({ id: "chat.toolCall.workflow.escalate.context" });
  const answerHeading = intl.formatMessage({ id: "chat.toolCall.workflow.escalate.answer" });
  const fallbackName = intl.formatMessage({ id: "chat.toolCall.workflow.escalate.fallbackName" });

  const inlinePreview = useMemo(() => toInlinePreview(question), [question]);
  const primaryText = useMemo(
    () => (
      <span className="min-w-0 truncate">{inlinePreview ?? toolCall.title ?? fallbackName}</span>
    ),
    [inlinePreview, toolCall.title, fallbackName],
  );

  // 展开门：只要有问题、context 或答案任一段可展开的内容。首帧 input 可能还是 `{}`，那时
  // 不给空面板一个展开入口（照 submit-result 的流式门）。
  const hasDetails =
    question !== undefined || questionContext !== undefined || answerText !== undefined;

  const renderContent = useCallback(
    () => (
      <div className="space-y-3">
        {question !== undefined ? (
          <section className="space-y-1.5">
            <h4 className="text-ui-sm font-medium text-foreground-subtlest">{questionHeading}</h4>
            <p className="whitespace-pre-wrap break-words rounded-lg border border-border bg-panel px-4 py-3 text-ui-base leading-5 text-foreground">
              {question}
            </p>
          </section>
        ) : null}
        {questionContext !== undefined ? (
          <section className="space-y-1.5">
            <h4 className="text-ui-sm font-medium text-foreground-subtlest">{contextHeading}</h4>
            <p className="whitespace-pre-wrap break-words rounded-lg border border-border bg-panel px-4 py-3 text-ui-base leading-5 text-foreground-subtle">
              {questionContext}
            </p>
          </section>
        ) : null}
        {answerText !== undefined ? (
          <section className="space-y-1.5">
            <h4 className="text-ui-sm font-medium text-foreground-subtlest">{answerHeading}</h4>
            <p className="whitespace-pre-wrap break-words rounded-lg border border-border bg-panel px-4 py-3 text-ui-base leading-5 text-foreground">
              {answerText}
            </p>
          </section>
        ) : null}
      </div>
    ),
    [question, questionContext, answerText, questionHeading, contextHeading, answerHeading],
  );

  return (
    <>
      <ToolLayout
        toolId={toolCall.toolId}
        icon={ESCALATE_TOOL_ICON}
        showIcon={context.showIcon !== false}
        canToggle={hasDetails && (context.canToggle ?? true)}
        forceOpen={hasDetails && (context.forceOpen ?? false)}
        hideSecondaryTextWhenOpen
        kindLabel={kindLabel}
        sourceLabel={context.sourceLabel}
        primaryText={primaryText}
        statusLabel={
          isFailed ? intl.formatMessage({ id: "chat.toolCall.status.failed" }) : undefined
        }
        statusTooltip={isFailed ? context.errorText : undefined}
        showFailureStatus={isFailed}
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
