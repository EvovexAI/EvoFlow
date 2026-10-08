import { MessageCircleReply } from "lucide-react";
import { useCallback, useMemo } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ToolSnapshotFieldNotice } from "@/ToolCallBlocks/ToolSnapshotFieldNotice.js";
import { ToolLayout } from "@/ToolCallBlocks/ToolLayout.js";
import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/shared.js";

const RESOLVE_QUESTION_TOOL_ICON = (
  <MessageCircleReply className="size-4 shrink-0 text-foreground-subtle" />
);

/** 折叠头部的单行概要上限：概要只是「大概答了什么」，整段答案在展开后的 body 里。 */
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
 * ResolveWorkflowQuestion 工具卡。主代理按 qid 回答一个
 * 子代理从**正在跑的** workflow 里升级上来的阻塞问题；答案会成为那次 escalate 调用的结果原文。
 *
 * 折叠行：kindLabel（answering/answered）+ 答案单行概要。展开：question_id（mono qid 行）+ 完整
 * 答案 + 工具输出文本（成功确认，或三种结构化拒绝之一）。
 *
 * 关键：拒绝（未知 qid / 已作答 / run 不在飞 / 本会话无应答能力）走的是结构化失败，会带上
 * `status==="failed"`，此时才走失败样式；成功确认是普通结果。
 */
export function ResolveWorkflowQuestionToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl } = useZCodeIntl();
  const { toolCall } = context.toolCallNode;
  const input = toRecord(toolCall.input);
  const questionId = readText(input?.question_id);
  const answer = readText(input?.answer);

  const isFailed = toolCall.status === "failed";
  const isAnswering =
    !isFailed &&
    (context.isRunning || toolCall.status === "pending" || toolCall.status === "in_progress");

  const kindLabel = intl.formatMessage({
    id: isAnswering
      ? "chat.toolCall.workflow.resolveQuestion.answering"
      : "chat.toolCall.workflow.resolveQuestion.answered",
  });
  const questionIdHeading = intl.formatMessage({
    id: "chat.toolCall.workflow.resolveQuestion.questionId",
  });
  const answerHeading = intl.formatMessage({ id: "chat.toolCall.workflow.resolveQuestion.answer" });
  const outcomeHeading = intl.formatMessage({
    id: "chat.toolCall.workflow.resolveQuestion.outcome",
  });
  const fallbackName = intl.formatMessage({
    id: "chat.toolCall.workflow.resolveQuestion.fallbackName",
  });

  // 结果文本：成功的确认文案（普通结果 → output），或结构化拒绝（错误通道优先）。
  const outcomeText = isFailed
    ? (context.errorText ?? readText(toolCall.error) ?? readText(toolCall.output))
    : isAnswering
      ? undefined
      : readText(toolCall.output);

  const inlinePreview = useMemo(() => toInlinePreview(answer), [answer]);
  const primaryText = useMemo(
    () => (
      <span className="min-w-0 truncate">{inlinePreview ?? toolCall.title ?? fallbackName}</span>
    ),
    [inlinePreview, toolCall.title, fallbackName],
  );

  const hasDetails = questionId !== undefined || answer !== undefined || outcomeText !== undefined;

  const renderContent = useCallback(
    () => (
      <div className="space-y-3">
        {questionId !== undefined ? (
          <section className="space-y-1.5">
            <h4 className="text-ui-sm font-medium text-foreground-subtlest">{questionIdHeading}</h4>
            {/* qid 是不透明标识键 → mono。 */}
            <code className="block break-all rounded-lg border border-border bg-panel px-4 py-2 font-mono text-ui-sm text-foreground-subtle">
              {questionId}
            </code>
          </section>
        ) : null}
        {answer !== undefined ? (
          <section className="space-y-1.5">
            <h4 className="text-ui-sm font-medium text-foreground-subtlest">{answerHeading}</h4>
            <p className="whitespace-pre-wrap break-words rounded-lg border border-border bg-panel px-4 py-3 text-ui-base leading-5 text-foreground">
              {answer}
            </p>
          </section>
        ) : null}
        {outcomeText !== undefined ? (
          <section className="space-y-1.5">
            <h4 className="text-ui-sm font-medium text-foreground-subtlest">{outcomeHeading}</h4>
            <p
              className={
                isFailed
                  ? "whitespace-pre-wrap break-words rounded-lg border border-destructive/40 bg-panel px-4 py-3 text-ui-base leading-5 text-foreground"
                  : "whitespace-pre-wrap break-words rounded-lg border border-border bg-panel px-4 py-3 text-ui-base leading-5 text-foreground-subtle"
              }
            >
              {outcomeText}
            </p>
          </section>
        ) : null}
      </div>
    ),
    [questionId, answer, outcomeText, isFailed, questionIdHeading, answerHeading, outcomeHeading],
  );

  return (
    <>
      <ToolLayout
        toolId={toolCall.toolId}
        icon={RESOLVE_QUESTION_TOOL_ICON}
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
        statusTooltip={isFailed ? outcomeText : undefined}
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
