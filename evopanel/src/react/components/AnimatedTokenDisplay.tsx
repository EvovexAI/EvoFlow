import { useAnimatedCount } from '../hooks/useAnimatedCount.js'
import { parseTokenDisplayString } from '../lib/token-display.js'

type TokenNums = {
  input: number
  output: number
  total: number
  cacheRead?: number
}

function AnimatedTokenNums({
  input,
  output,
  total,
  cacheRead = 0,
  animate,
}: TokenNums & { animate: boolean }) {
  const animIn = useAnimatedCount(input, { enabled: animate })
  const animOut = useAnimatedCount(output, { enabled: animate })
  const animTotal = useAnimatedCount(total, { enabled: animate })
  const animCache = useAnimatedCount(cacheRead, { enabled: animate })

  if (input > 0 || output > 0) {
    return (
      <>
        ↑{animIn} ↓{animOut}
        {cacheRead > 0 ? (
          <>
            {' '}
            · ⚡{animCache}
          </>
        ) : null}
      </>
    )
  }
  return <>{animTotal} tokens</>
}

export function AnimatedTokenDisplay({
  input,
  output,
  total,
  cacheRead = 0,
  className,
  title,
  animate = true,
}: TokenNums & {
  className?: string
  title?: string
  animate?: boolean
}) {
  if (total <= 0) return null
  return (
    <span className={className} title={title}>
      <AnimatedTokenNums
        input={input}
        output={output}
        total={total}
        cacheRead={cacheRead}
        animate={animate}
      />
    </span>
  )
}

/** 气泡 meta：流式时数字递增，落库后静态展示。 */
export function AnimatedTokenInline({
  tokenStr,
  animate = false,
  className = 'msg-tokens',
}: {
  tokenStr: string
  animate?: boolean
  className?: string
}) {
  const parsed = parseTokenDisplayString(tokenStr)
  if (!parsed || parsed.total <= 0) return null
  return (
    <span className={className}>
      <AnimatedTokenNums
        input={parsed.input}
        output={parsed.output}
        total={parsed.total}
        cacheRead={parsed.cacheRead}
        animate={animate}
      />
    </span>
  )
}
