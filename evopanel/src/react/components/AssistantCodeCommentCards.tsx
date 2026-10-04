import { memo, useState } from 'react'
import type { AssistantCodeCommentCard } from '../../lib/assistant-code-comment.js'

function displayTitle(card: AssistantCodeCommentCard): string {
  if (card.priority === undefined) return card.title
  const prefix = `[P${card.priority}]`
  return card.title.startsWith(prefix) ? card.title.slice(prefix.length).trimStart() : card.title
}

function locationLabel(card: AssistantCodeCommentCard): string {
  if (!card.startLine) return card.displayPath
  if (card.endLine && card.endLine !== card.startLine) {
    return `${card.displayPath}:${card.startLine}-${card.endLine}`
  }
  return `${card.displayPath}:${card.startLine}`
}

/** 助手正文里 `::code-comment{...}` 渲染出的行内评论卡片（默认折叠）。 */
function AssistantCodeCommentCardsInner({
  cards,
  onOpenWorkspaceFile,
}: {
  cards: readonly AssistantCodeCommentCard[]
  onOpenWorkspaceFile?: (
    rawPath: string,
    displayName?: string,
    opts?: {
      line?: number
      endLine?: number
      /** 评审批注内容：预览定位后渲染在目标行下方 */
      annotation?: { title?: string; body?: string; priority?: number }
    },
  ) => void
}) {
  const [isOpen, setIsOpen] = useState(false)
  if (cards.length === 0) return null

  const openCard = (card: AssistantCodeCommentCard) => {
    onOpenWorkspaceFile?.(card.path, card.title || undefined, {
      line: card.startLine,
      endLine: card.endLine,
      annotation: { title: card.title, body: card.body, priority: card.priority },
    })
  }

  return (
    <section className="evf-code-comments" data-testid="assistant-code-comment-cards">
      <button
        type="button"
        className="evf-code-comments-header"
        aria-expanded={isOpen}
        onClick={() => setIsOpen((value) => !value)}
      >
        <span
          className={`evf-code-comments-arrow${isOpen ? ' is-open' : ''}`}
          aria-hidden="true"
        />
        <span className="evf-code-comments-count">
          {cards.length === 1 ? '1 条代码评论' : `${cards.length} 条代码评论`}
        </span>
      </button>
      {isOpen ? (
        <div className="evf-code-comments-list">
          {cards.map((card) => {
            const title = displayTitle(card)
            return (
              <div key={card.id} className="evf-code-comment-row-wrap">
                <div
                  role="button"
                  tabIndex={0}
                  className="evf-code-comment-row"
                  data-code-comment-path={card.displayPath}
                  title={card.body}
                  onClick={(event) => {
                    // 用户在卡片里选中文本时不要误触打开文件
                    const selection = window.getSelection()
                    if (selection && !selection.isCollapsed && selection.rangeCount > 0) {
                      try {
                        if (selection.getRangeAt(0).intersectsNode(event.currentTarget)) return
                      } catch {
                        /* ignore */
                      }
                    }
                    openCard(card)
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter' && event.key !== ' ') return
                    event.preventDefault()
                    openCard(card)
                  }}
                >
                  {card.priority !== undefined ? (
                    <span className={`evf-code-comment-badge evf-code-comment-badge--p${card.priority}`}>
                      P{card.priority}
                    </span>
                  ) : null}
                  <span className="evf-code-comment-title">{title}</span>
                  <span className="evf-code-comment-location">{locationLabel(card)}</span>
                </div>
              </div>
            )
          })}
        </div>
      ) : null}
    </section>
  )
}

export const AssistantCodeCommentCards = memo(AssistantCodeCommentCardsInner)
