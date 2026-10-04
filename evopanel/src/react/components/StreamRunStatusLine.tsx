import { memo } from 'react'
import { Loader } from 'lucide-react'
import { normalizeStreamStatusLabel } from '../lib/stream-status-label.js'
import { stripTurnDurationSuffix } from '../lib/turn-timing.js'

type Props = {
  /** 后端/本地状态文案，如 生成中 / 思考中 / 调用：read（可带 dock 耗时后缀，会被剥掉） */
  label?: string
  durationLabel?: string
  toolCount?: number
  /** 兼容保留：运行中轮播小提示（ZCode 对齐后不再展示） */
  showTip?: boolean
}

/**
 * 流式状态唯一出口：ZCode 对齐 —— 一枚旋转圆环。
 * 旧形态（文案 + 耗时 + 点点 + 轮播 tip）已移除；状态文案保留在 aria-label。
 */
function StreamRunStatusLineInner({ label }: Props) {
  const status =
    normalizeStreamStatusLabel(stripTurnDurationSuffix(label)) ||
    normalizeStreamStatusLabel(String(label || '').trim()) ||
    '生成中'
  return (
    <div className="msg-stream-run-status" aria-live="polite" role="status" aria-label={status}>
      <Loader size={14} strokeWidth={1.5} className="msg-stream-run-spinner animate-spin" aria-hidden />
    </div>
  )
}

export const StreamRunStatusLine = memo(StreamRunStatusLineInner)
