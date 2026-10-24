/** 任务中心详情页专用右栏归属，与对话 sessionKey 隔离，避免串台 / 误跳会话。 */
export function taskCenterStageSessionKey(taskId: string): string {
  const tid = String(taskId || '').trim()
  return tid ? `task-center:${tid}` : 'task-center'
}

export function isTaskCenterStageSessionKey(sessionKey: string | null | undefined): boolean {
  return String(sessionKey || '').trim().startsWith('task-center:')
}
