import { memo, useEffect, useState } from 'react'
import { pickRunProgressTip } from '../lib/run-progress-tips.js'
import { normalizeStreamStatusLabel } from '../lib/stream-status-label.js'
import { stripTurnDurationSuffix } from '../lib/turn-timing.js'
import { ReasoningInlineBlock, ReasoningStreamDots } from './ReasoningInlineBlock.js'

type Props = {
  /** 后端/本地状态文案，如 生成中 / 思考中 / 调用：read（可带 dock 耗时后缀，会被剥掉） */
  label?: string
  durationLabel?: string
  toolCount?: number
  /** 运行中轮播小提示 */
  showTip?: boolean
}

/** 流式状态唯一出口：状态文案 · 耗时 · tools · tip（耗时只出现一次） */
function StreamRunStatusLineInner({
  label,
  durationLabel,
  toolCount = 0,
  showTip = true,
}: Props) {
  // dockLabel 常已带 `` · 12s``；这里剥掉，统一用 durationLabel 再拼一次
  const status =
    normalizeStreamStatusLabel(stripTurnDurationSuffix(label)) ||
    normalizeStreamStatusLabel(String(label || '').trim()) ||
    '生成中'
  const duration = String(durationLabel || '').trim()
  const tools =
    toolCount > 0 ? `${toolCount} ${toolCount === 1 ? 'tool' : 'tools'}` : ''
  const meta = [duration, tools].filter(Boolean).join(' · ')

  const [tip, setTip] = useState(() => (showTip ? pickRunProgressTip() : ''))
  useEffect(() => {
    if (!showTip) {
      setTip('')
      return
    }
    setTip(pickRunProgressTip())
    const timer = window.setInterval(() => setTip(pickRunProgressTip()), 9000)
    return () => window.clearInterval(timer)
  }, [showTip])

  if (!meta && !tip) {
    return (
      <ReasoningInlineBlock text="" label={status} isStreamingActive hideChevron />
    )
  }

  return (
    <div className="msg-stream-run-status" aria-live="polite">
      <span className="msg-stream-run-status-dot" aria-hidden />
      <span className="msg-stream-run-status-core">
        <span className="msg-stream-run-status-label">{status}</span>
        {meta ? <span className="msg-stream-run-status-meta"> · {meta}</span> : null}
        <ReasoningStreamDots />
      </span>
      {tip ? (
        <span className="msg-stream-run-status-tip" key={tip} title={tip}>
          {tip}
        </span>
      ) : null}
    </div>
  )
}

export const StreamRunStatusLine = memo(StreamRunStatusLineInner)
