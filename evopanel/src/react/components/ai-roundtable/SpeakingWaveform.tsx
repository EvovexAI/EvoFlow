import React, { useMemo } from 'react'

/** 座位旁声波：菱形轮廓 + 错峰动画（对齐发言态参考图） */
const NODE_HEIGHTS = [8, 14, 22, 28, 24, 16, 11, 7]
const NODE_DELAYS = [0, 0.08, 0.16, 0.24, 0.12, 0.2, 0.05, 0.14]

const FULL_HEIGHTS = [10, 16, 24, 18, 32, 22, 28, 14, 26, 20, 12, 18]
/** 右侧发言卡片：矮一点，别压住标题行 */
const COMPACT_HEIGHTS = [5, 8, 11, 7, 12, 9, 10, 6]
const FULL_DELAYS = [0, 80, 130, 40, 180, 60, 150, 20, 110, 90, 170, 50]

type Props = {
  compact?: boolean
  /** 座位旁说话波形 */
  variant?: 'default' | 'node'
  bars?: number
  /** 仅 speaking 时开启动画（listening/thinking 可静置） */
  active?: boolean
}

/** speaking 波形条：座位旁 8 柱霓虹线；卡片内用常规 bars */
export default function SpeakingWaveform({
  compact = false,
  variant = 'default',
  bars = 12,
  active = true,
}: Props) {
  const isNode = variant === 'node'

  const heights = useMemo(() => {
    if (isNode) return NODE_HEIGHTS
    if (compact) return COMPACT_HEIGHTS.slice(0, Math.min(8, bars))
    return FULL_HEIGHTS.slice(0, bars)
  }, [bars, compact, isNode])

  if (isNode) {
    return (
      <div
        className={`ai-rt__wave is-node${active ? ' is-active' : ''}`}
        aria-hidden="true"
      >
        {heights.map((h, i) => (
          <span
            key={i}
            style={{
              height: h,
              animationDelay: `${NODE_DELAYS[i % NODE_DELAYS.length]}s`,
            }}
          />
        ))}
      </div>
    )
  }

  return (
    <div
      className={`ai-rt__wave${compact ? ' is-compact' : ''}${active ? ' is-active' : ''}`}
      aria-hidden="true"
    >
      {heights.map((h, i) => (
        <i
          key={i}
          style={{
            ['--ai-rt-bar-h' as string]: `${h}px`,
            height: h,
            animationDelay: `${FULL_DELAYS[i % FULL_DELAYS.length]}ms`,
          }}
        />
      ))}
    </div>
  )
}
