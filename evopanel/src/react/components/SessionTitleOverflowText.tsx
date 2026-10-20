import {
  useEffect,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type ElementType,
} from 'react'
import { cn } from '../lib/utils.js'

const marqueeGapPx = 24
const marqueePixelsPerSecond = 40
const minimumMarqueeDurationSeconds = 6
const marqueePauseSeconds = 2
const marqueeHoverDelayMs = 1_000
const marqueeMaskFadeInSeconds = 0.15
const rightFadeMask =
  'linear-gradient(to right, black 0, black calc(100% - 1.5rem), transparent 100%)'
const bothEdgesFadeMask =
  'linear-gradient(to right, transparent 0, black 1.5rem, black calc(100% - 1.5rem), transparent 100%)'

function createMaskKeyframe(maskImage: string, offset: number): Keyframe {
  return { maskImage, offset, webkitMaskImage: maskImage }
}

type SessionTitleOverflowTextProps = ComponentPropsWithoutRef<'span'> & {
  as?: 'span' | 'p'
}

/**
 * 侧栏会话标题：溢出时右侧渐隐；悬停满 1s 后走马灯滚动（对齐 zcode TaskTitleOverflowText）。
 */
export function SessionTitleOverflowText({
  as = 'span',
  children,
  className,
  // 原生 title 提示框会在 hover 走马灯时遮挡正在滚动的标题。
  title: _nativeTitle,
  ...props
}: SessionTitleOverflowTextProps) {
  const Component = as as ElementType
  const textRef = useRef<HTMLElement | null>(null)
  const originalTextRef = useRef<HTMLSpanElement | null>(null)
  const marqueeTrackRef = useRef<HTMLSpanElement | null>(null)
  const [overflowState, setOverflowState] = useState({
    distance: 0,
    duration: minimumMarqueeDurationSeconds,
    isOverflowing: false,
  })
  const { distance, duration, isOverflowing } = overflowState

  useEffect(() => {
    const textElement = textRef.current
    const originalTextElement = originalTextRef.current
    if (!textElement || !originalTextElement) return

    const updateOverflow = () => {
      // 以单份标题的真实排版宽度为准，避免走马灯副本撑大 scrollWidth 后无法退出溢出状态。
      const contentWidth = originalTextElement.scrollWidth
      const nextIsOverflowing = contentWidth > textElement.clientWidth
      const nextDistance = nextIsOverflowing ? contentWidth + marqueeGapPx : 0
      const nextDuration = nextIsOverflowing
        ? Math.max(minimumMarqueeDurationSeconds, nextDistance / marqueePixelsPerSecond)
        : minimumMarqueeDurationSeconds
      setOverflowState((current) =>
        current.isOverflowing === nextIsOverflowing &&
        current.distance === nextDistance &&
        current.duration === nextDuration
          ? current
          : {
              distance: nextDistance,
              duration: nextDuration,
              isOverflowing: nextIsOverflowing,
            },
      )
    }

    updateOverflow()

    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', updateOverflow)
      return () => window.removeEventListener('resize', updateOverflow)
    }

    const resizeObserver = new ResizeObserver(updateOverflow)
    resizeObserver.observe(textElement)
    resizeObserver.observe(originalTextElement)
    return () => resizeObserver.disconnect()
  }, [children])

  useEffect(() => {
    const textElement = textRef.current
    const marqueeTrack = marqueeTrackRef.current
    if (
      !isOverflowing ||
      !textElement ||
      !marqueeTrack ||
      typeof marqueeTrack.animate !== 'function'
    ) {
      return
    }

    const reducedMotionQuery =
      typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-reduced-motion: reduce)')
        : null
    // 绑到整行会话项，鼠标在时间/更多操作区时也能触发滚动。
    const hoverTarget =
      textElement.closest<HTMLElement>('[data-shell-session]') ?? textElement
    let animations: Animation[] = []
    let startTimer: number | null = null

    const stopMarquee = () => {
      if (startTimer !== null) {
        window.clearTimeout(startTimer)
        startTimer = null
      }
      animations.forEach((animation) => animation.cancel())
      animations = []
    }
    const startMarquee = () => {
      if (reducedMotionQuery?.matches) return

      stopMarquee()
      const totalDuration = duration + marqueePauseSeconds
      const movementEndOffset = duration / totalDuration
      const maskFadeInEndOffset = marqueeMaskFadeInSeconds / totalDuration
      const originalTailArrivalTime = duration * ((distance - marqueeGapPx) / distance)
      const originalTailArrivalOffset = originalTailArrivalTime / totalDuration
      const animationOptions: KeyframeAnimationOptions = {
        duration: totalDuration * 1_000,
        easing: 'linear',
        iterations: Infinity,
      }
      const trackAnimation = marqueeTrack.animate(
        [
          { offset: 0, transform: 'translate3d(0, 0, 0)' },
          {
            offset: movementEndOffset,
            transform: `translate3d(-${distance}px, 0, 0)`,
          },
          {
            offset: 1,
            transform: `translate3d(-${distance}px, 0, 0)`,
          },
        ],
        animationOptions,
      )
      const maskAnimation = textElement.animate(
        [
          createMaskKeyframe(rightFadeMask, 0),
          createMaskKeyframe(bothEdgesFadeMask, maskFadeInEndOffset),
          createMaskKeyframe(bothEdgesFadeMask, originalTailArrivalOffset),
          createMaskKeyframe(rightFadeMask, originalTailArrivalOffset),
          createMaskKeyframe(rightFadeMask, 1),
        ],
        animationOptions,
      )
      animations = [trackAnimation, maskAnimation]
    }
    const scheduleMarquee = () => {
      if (reducedMotionQuery?.matches) return
      stopMarquee()
      // 短暂划过不应立即触发；停留满 1 秒才开始。
      startTimer = window.setTimeout(() => {
        startTimer = null
        startMarquee()
      }, marqueeHoverDelayMs)
    }
    const handleMotionPreferenceChange = (event: MediaQueryListEvent) => {
      if (event.matches) stopMarquee()
    }

    hoverTarget.addEventListener('mouseenter', scheduleMarquee)
    hoverTarget.addEventListener('mouseleave', stopMarquee)
    reducedMotionQuery?.addEventListener('change', handleMotionPreferenceChange)

    return () => {
      hoverTarget.removeEventListener('mouseenter', scheduleMarquee)
      hoverTarget.removeEventListener('mouseleave', stopMarquee)
      reducedMotionQuery?.removeEventListener('change', handleMotionPreferenceChange)
      stopMarquee()
    }
  }, [distance, duration, isOverflowing])

  return (
    <Component
      ref={textRef}
      className={cn(
        'react-chat-history-item-title',
        isOverflowing && 'react-chat-history-item-title--overflow',
        isOverflowing && 'react-chat-session-title-marquee',
        className,
      )}
      {...props}
    >
      <span
        ref={marqueeTrackRef}
        data-session-title-marquee-track="true"
        className="react-chat-session-title-marquee-track"
      >
        <span ref={originalTextRef} data-session-title-copy="original" className="react-chat-session-title-marquee-copy">
          {children}
        </span>
        {isOverflowing ? (
          <span
            aria-hidden="true"
            data-session-title-copy="duplicate"
            className="react-chat-session-title-marquee-copy"
          >
            {children}
          </span>
        ) : null}
      </span>
    </Component>
  )
}
