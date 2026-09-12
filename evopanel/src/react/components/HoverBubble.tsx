import * as React from 'react'
import * as TooltipPrimitive from '@radix-ui/react-tooltip'
import { cn } from '@/lib/utils'

export type HoverBubbleSide = 'top' | 'bottom' | 'left' | 'right'
export type HoverBubbleAlign = 'start' | 'center' | 'end'
export type HoverBubbleVariant = 'simple' | 'rich'

export type HoverBubbleProviderProps = React.ComponentProps<typeof TooltipPrimitive.Provider>

/** Mount once near the app root (e.g. ChatApp). */
export function HoverBubbleProvider({
  delayDuration = 280,
  skipDelayDuration = 0,
  ...props
}: HoverBubbleProviderProps) {
  return (
    <TooltipPrimitive.Provider
      delayDuration={delayDuration}
      skipDelayDuration={skipDelayDuration}
      {...props}
    />
  )
}

export type HoverBubbleProps = {
  children: React.ReactElement
  /** Plain string; newlines are preserved (``white-space: pre-wrap``). */
  text?: string
  /** Custom bubble body (simple variant). */
  content?: React.ReactNode
  /** Rich variant: muted section label. */
  title?: string
  /** Rich variant: main body (string or node). Falls back to ``text``. */
  body?: React.ReactNode
  variant?: HoverBubbleVariant
  side?: HoverBubbleSide
  align?: HoverBubbleAlign
  sideOffset?: number
  maxWidth?: number | string
  maxHeight?: number | string
  disabled?: boolean
  bubbleClassName?: string
  delayDuration?: number
  asChild?: boolean
}

function hasBubbleContent(props: Pick<HoverBubbleProps, 'text' | 'content' | 'title' | 'body' | 'variant'>) {
  const { text, content, title, body, variant = 'simple' } = props
  if (variant === 'rich') {
    return Boolean(String(title || '').trim() || body != null || String(text || '').trim() || content)
  }
  return Boolean(String(text || '').trim() || content)
}

function HoverBubbleBody({
  variant,
  text,
  content,
  title,
  body,
}: Pick<HoverBubbleProps, 'variant' | 'text' | 'content' | 'title' | 'body'>) {
  const effectiveVariant =
    variant === 'simple' && String(title || '').trim() && (body != null || String(text || '').trim())
      ? 'rich'
      : variant

  if (effectiveVariant === 'rich') {
    const main = body ?? content ?? text
    if (!String(title || '').trim() && (main == null || main === '')) return null
    return (
      <div className="ev-hover-bubble ev-hover-bubble--rich">
        {String(title || '').trim() ? (
          <div className="ev-hover-bubble__title">{title}</div>
        ) : null}
        {main != null && main !== '' ? (
          <div className="ev-hover-bubble__body">{main}</div>
        ) : null}
      </div>
    )
  }

  const inner = content ?? text
  if (inner == null || inner === '') return null
  return (
    <div className="ev-hover-bubble ev-hover-bubble--simple">
      <div className="ev-hover-bubble__body">{inner}</div>
    </div>
  )
}

/**
 * Reusable hover bubble for truncated labels, context stats, subtask previews, pills, etc.
 * Uses Radix Tooltip (portal + collision) with shared ``ev-hover-bubble`` styling.
 */
export function HoverBubble({
  children,
  text,
  content,
  title,
  body,
  variant = 'simple',
  side = 'top',
  align = 'center',
  sideOffset = 6,
  maxWidth = 320,
  maxHeight,
  disabled = false,
  bubbleClassName,
  delayDuration,
  asChild = true,
}: HoverBubbleProps) {
  if (disabled || !hasBubbleContent({ text, content, title, body, variant })) {
    return children
  }

  const style: React.CSSProperties = {
    maxWidth: typeof maxWidth === 'number' ? `${maxWidth}px` : maxWidth,
  }
  if (maxHeight != null) {
    style.maxHeight = typeof maxHeight === 'number' ? `${maxHeight}px` : maxHeight
    style.overflow = 'auto'
  }

  return (
    <TooltipPrimitive.Root delayDuration={delayDuration}>
      <TooltipPrimitive.Trigger asChild={asChild}>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          align={align}
          sideOffset={sideOffset}
          collisionPadding={10}
          className={cn('ev-hover-bubble-content', bubbleClassName)}
          style={style}
        >
          <HoverBubbleBody variant={variant} text={text} content={content} title={title} body={body} />
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  )
}
