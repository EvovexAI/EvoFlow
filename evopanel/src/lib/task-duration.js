/**
 * 任务耗时展示：把 started_at / completed_at 折成「4 分 20 秒」这种短标签。
 *
 * 背景：员工页原先只渲染一个时间点（`fmtTime`），执行中的任务看不出跑了多久，
 * 完成的任务也看不出花了多久 —— 用户体感就是「卡住了 / 不知道在不在跑」。
 */

/** 秒差 → 人类可读短标签（秒 / 分秒 / 时分）。`nowMs` 仅测试注入用。 */
export function fmtDuration(fromIso, toIso = '', nowMs = null) {
  const start = new Date(fromIso || '').getTime()
  if (!Number.isFinite(start)) return ''
  const end = toIso ? new Date(toIso).getTime() : Number.isFinite(nowMs) ? nowMs : Date.now()
  if (!Number.isFinite(end)) return ''
  const sec = Math.max(0, Math.round((end - start) / 1000))
  if (sec < 60) return `${sec} 秒`
  const mins = Math.floor(sec / 60)
  if (mins < 60) return `${mins} 分${sec % 60 ? ` ${sec % 60} 秒` : ''}`
  const hours = Math.floor(mins / 60)
  return `${hours} 小时${mins % 60 ? ` ${mins % 60} 分` : ''}`
}

export function isExecutingStatus(status) {
  const st = String(status || '').trim().toLowerCase()
  return st === 'executing' || st === 'running' || st === 'in_progress'
}

/**
 * 卡片/列表行的耗时文案：
 * - 执行中 → `已运行 3 分 12 秒`（持续增长）
 * - 已结束 → `耗时 4 分 20 秒`
 */
export function durationLabel(task, nowMs = null) {
  const started = String(task?.started_at || task?.created_at || '').trim()
  if (!started) return ''
  const running = isExecutingStatus(task?.status)
  const end = running ? '' : String(task?.completed_at || task?.updated_at || '').trim()
  const spent = fmtDuration(started, end, nowMs)
  if (!spent) return ''
  return running ? `已运行 ${spent}` : `耗时 ${spent}`
}
