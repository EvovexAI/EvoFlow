import { Profiler, type ReactNode } from 'react'
import { streamPerfEnabled, streamPerfOnProfilerRender } from '../lib/stream-perf-trace.js'

/**
 * 关闭 streamperf 时直接透传 children（零 Profiler 开销）；
 * 开启时把 actualDuration 写入 stream-perf-trace 的 top offenders。
 */
export function StreamPerfProfiler({
  id,
  children,
}: {
  id: string
  children: ReactNode
}) {
  if (!streamPerfEnabled()) return children
  return (
    <Profiler id={id} onRender={streamPerfOnProfilerRender}>
      {children}
    </Profiler>
  )
}
