import { useState } from "react";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { AssistantCodeCommentCard } from "@/lib/assistantCodeComment.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import { getPathLeaf } from "@/lib/path.js";

let navigationRequestSequence = 0;

function displayTitle(card: AssistantCodeCommentCard): string {
  if (card.priority === undefined) return card.title;
  const prefix = `[P${card.priority}]`;
  return card.title.startsWith(prefix) ? card.title.slice(prefix.length).trimStart() : card.title;
}

function priorityClassName(priority: AssistantCodeCommentCard["priority"]): string {
  if (priority === 0) {
    return "border-destructive/40 bg-destructive/10 text-destructive";
  }
  return "border-border bg-background text-foreground-subtle";
}

function hasTextSelectionInCard(card: HTMLElement): boolean {
  if (typeof window === "undefined") return false;
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return false;

  try {
    return selection.getRangeAt(0).intersectsNode(card);
  } catch {
    return false;
  }
}

export function AssistantCodeCommentCards({
  cards,
  onOpenCodeViewer,
  workspaceIdentity,
  workspacePath,
  workspaceRemoteSessionId,
}: {
  cards: readonly AssistantCodeCommentCard[];
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
  workspaceIdentity?: string;
  workspacePath: string;
  workspaceRemoteSessionId?: string;
}) {
  const { intl } = useZCodeIntl();
  const [isOpen, setIsOpen] = useState(false);
  const visibleCards = cards;

  if (cards.length === 0) return null;

  return (
    <section
      data-testid="assistant-code-comment-cards"
      className="overflow-hidden rounded-xl border border-border bg-card shadow-none"
    >
      <div
        data-testid="assistant-code-comment-header"
        className="flex h-10 items-center gap-2 px-3 transition-colors hover:bg-hover"
      >
        <button
          type="button"
          className="flex h-full min-w-0 flex-1 items-center gap-2 px-1 text-left"
          aria-expanded={isOpen}
          aria-label={intl.formatMessage(
            {
              id: isOpen ? "chat.codeCommentCards.collapseAll" : "chat.codeCommentCards.expandAll",
            },
            { count: cards.length },
          )}
          onClick={() => setIsOpen((value) => !value)}
        >
          <span
            data-testid="assistant-code-comment-toggle-icon"
            aria-hidden="true"
            className={cn(
              "inline-block size-1.5 shrink-0 -rotate-45 border-r border-b border-foreground-subtlest transition-transform",
              isOpen && "rotate-45",
            )}
          />
          <h3 className="min-w-0 truncate text-ui-base font-medium text-foreground">
            {intl.formatMessage(
              {
                id: cards.length === 1 ? "chat.codeComments.one" : "chat.codeComments.many",
              },
              { count: cards.length },
            )}
          </h3>
        </button>
      </div>
      <div
        data-testid="assistant-code-comment-list"
        className={cn("flex flex-col", isOpen && "border-t border-border")}
      >
        {isOpen
          ? visibleCards.map((card) => {
              const locationLabel = card.startLine
                ? `${card.displayPath}:${
                    card.endLine && card.endLine !== card.startLine
                      ? `${card.startLine}–${card.endLine}`
                      : card.startLine
                  }`
                : card.displayPath;
              const title = displayTitle(card);
              const openReview = () => {
                navigationRequestSequence += 1;
                const requestId = `${card.id}:${navigationRequestSequence}`;
                // 设计原因：模型评论描述的是 workspace 文件，不是 Git diff。直接打开独立的
                // code-review source，既保留远程 workspace 路由，也避免未提交状态成为前置条件。
                onOpenCodeViewer?.({
                  type: "code-review",
                  title: getPathLeaf(card.path),
                  path: card.path,
                  workspacePath,
                  ...(workspaceIdentity ? { workspaceIdentity } : {}),
                  ...(workspaceRemoteSessionId ? { workspaceRemoteSessionId } : {}),
                  review: {
                    requestId,
                    title,
                    body: card.body,
                    ...(card.priority !== undefined ? { priority: card.priority } : {}),
                    ...(card.startLine
                      ? {
                          startLine: card.startLine,
                          endLine: card.endLine ?? card.startLine,
                        }
                      : {}),
                  },
                });
              };

              return (
                <div key={card.id} className="bg-background/50">
                  <div
                    role="button"
                    tabIndex={0}
                    data-code-comment-path={card.displayPath}
                    // Git 文件行把半透明基础面放在父层，hover 放在内层；若把
                    // 两个背景放到同一元素，hover 会替换基础背景而不是在其上叠加，
                    // 浅色主题下对比度几乎不可见。因此这里保持与 Git 文件行相同的分层。
                    className="flex min-h-10 w-full min-w-0 cursor-pointer select-text items-center gap-3 px-6 py-2 text-left whitespace-nowrap transition-colors hover:bg-hover/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
                    aria-label={intl.formatMessage(
                      { id: "chat.codeCommentCards.openReview" },
                      { title },
                    )}
                    onClick={(event) => {
                      if (hasTextSelectionInCard(event.currentTarget)) return;
                      openReview();
                    }}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" && event.key !== " ") return;
                      event.preventDefault();
                      openReview();
                    }}
                  >
                    <div className="flex min-w-0 flex-1 items-center gap-3 overflow-hidden">
                      {card.priority !== undefined ? (
                        <span
                          className={cn(
                            "shrink-0 rounded border px-1.5 py-0.5 text-ui-xs font-medium",
                            priorityClassName(card.priority),
                          )}
                        >
                          P{card.priority}
                        </span>
                      ) : null}
                      <span className="min-w-0 shrink truncate text-ui-base font-medium text-foreground">
                        {title}
                      </span>
                      <span className="min-w-0 shrink truncate text-ui-base text-foreground-subtle">
                        {locationLabel}
                      </span>
                    </div>
                  </div>
                </div>
              );
            })
          : null}
      </div>
    </section>
  );
}
