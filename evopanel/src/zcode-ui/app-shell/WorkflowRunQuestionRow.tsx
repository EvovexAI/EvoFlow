import { MessageCircleQuestionIcon } from "lucide-react";
import type { WorkflowRunPendingQuestion } from "@zcode/shared/zcode-protocol-v4";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { workflowRunQuestionWaitedLabel } from "@/app-shell/workflowRunQuestions.js";

/**
 * 一条升级问题：挂在提问者那一行下面。
 *
 * **只读，v1 没有应答框**：应答者是主代理，不是用户——它拿不准时本就可经 AskUserQuestion
 * 转询用户。qid 是主代理作答时要用的那个 token；用户自己答不了，但把它显示出来，就能指着
 * 某一个问题让主代理去答——这是只读面里唯一可被转达的抓手。
 */
export function WorkflowRunQuestionRow({
  className,
  now,
  question,
  showAsker = false,
}: {
  /** 落位由调用方给（脊线里挂在提问者下面再退 26px；末尾的孤儿块自己有内缩）。 */
  className?: string;
  /** 由清单的定时器喂进来的"现在"，好让等待时长在没有事件流的时候也照走。 */
  now: number;
  question: WorkflowRunPendingQuestion;
  /** 匹配不上提问者的问题（挂在阶段末尾）要自己报名字；挂在行下的不必重复。 */
  showAsker?: boolean;
}) {
  const { intl } = useZCodeIntl();
  const waited = workflowRunQuestionWaitedLabel(question.askedAt, now, (descriptor, values) =>
    intl.formatMessage(descriptor, values),
  );

  return (
    <div
      className={cn(
        "mt-1 flex min-w-0 items-start gap-2 rounded-lg bg-[var(--color-interaction-confirmation-surface)] px-2 py-1.5 text-ui-sm text-[var(--color-interaction-confirmation-foreground)]",
        className,
      )}
      data-qid={question.qid}
      data-testid="workflow-run-question"
    >
      <MessageCircleQuestionIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
      <div className="min-w-0 flex-1">
        {showAsker ? (
          <span className="mr-2 font-mono text-ui-xs font-medium">
            {question.actorName ??
              (question.actorSiteId === undefined
                ? intl.formatMessage({ id: "chat.toolCall.workflow.graph.lane.anonymous" })
                : `${question.actorSiteId}@${question.actorOrdinal}`)}
          </span>
        ) : null}
        {/* 问题正文是人话，不是技术值，所以按正文排版；pre-wrap 保住模型可能带的换行。 */}
        <span className="whitespace-pre-wrap break-words">{question.question}</span>
        {question.context === undefined ? null : (
          <p
            className="mt-0.5 whitespace-pre-wrap break-words text-ui-xs opacity-80"
            data-testid="workflow-run-question-context"
          >
            {question.context}
          </p>
        )}
      </div>
      <span className="flex shrink-0 items-baseline gap-2 font-mono text-ui-xs">
        {/* 等了多久。刻意**不**用 warning 着色：长等待是设计内的正常状态，不是告警。askedAt
            缺席（老 journal 重放）时整段不渲染，绝不编一个"刚刚"出来。 */}
        {waited === undefined ? null : (
          <span data-testid="workflow-run-question-waited">{waited}</span>
        )}
        <span className="opacity-70">{question.qid}</span>
      </span>
    </div>
  );
}
