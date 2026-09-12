import React from 'react'

/** 主星：臂更细、横向略收 */
const STAR =
  'M50 14 C51.2 34 55 41 78 45 C55 49 51.2 56 50 76 C48.8 56 45 49 22 45 C45 41 48.8 34 50 14Z'

/** 右上小星 */
const SMALL_TR =
  'M76 18 C77.5 24 80 27 86 29 C80 31 77.5 34 76 40 C74.5 34 72 31 66 29 C72 27 74.5 24 76 18Z'

/** 左下小星 */
const SMALL_BL =
  'M24 72 C25.2 77 27.5 79.5 32.5 81 C27.5 82.5 25.2 85 24 90 C22.8 85 20.5 82.5 15.5 81 C20.5 79.5 22.8 77 24 72Z'

type Props = {
  className?: string
  /** 默认品牌标尺寸；控制台等可传更小 */
  size?: number
  breathe?: boolean
}

/** SVG 四角星 Logo：圆角底 + blur 辉光 + 小光点（禁止 PNG） */
export default function RoundtableAiLogo({
  className = '',
  size = 44,
  breathe = true,
}: Props) {
  return (
    <div
      className={`ai-rt-logo${breathe ? ' is-breathe' : ''}${className ? ` ${className}` : ''}`}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <svg viewBox="0 0 100 100" overflow="visible">
        <circle className="ai-rt-logo__dot" cx="50" cy="7" r="1.3" />
        <circle className="ai-rt-logo__dot" cx="50" cy="93" r="1.1" />
        <circle className="ai-rt-logo__dot ai-rt-logo__dot--soft" cx="12" cy="48" r="0.9" />
        <circle className="ai-rt-logo__dot ai-rt-logo__dot--soft" cx="88" cy="48" r="0.9" />

        <path className="ai-rt-logo__glow" d={STAR} />
        <path className="ai-rt-logo__glow ai-rt-logo__glow--sm" d={SMALL_TR} />
        <path className="ai-rt-logo__glow ai-rt-logo__glow--sm" d={SMALL_BL} />

        <path className="ai-rt-logo__star" d={STAR} />
        <path className="ai-rt-logo__star ai-rt-logo__star--sm" d={SMALL_TR} />
        <path className="ai-rt-logo__star ai-rt-logo__star--sm ai-rt-logo__star--bl" d={SMALL_BL} />
      </svg>
    </div>
  )
}
