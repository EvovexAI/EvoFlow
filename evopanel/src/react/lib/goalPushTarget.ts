export type PushTargetOption = {
  id: string
  channel: string
  targetId: string
  label: string
  source?: string
  sessionKey?: string
  agentCode?: string
}

export function parsePushTargetKey(key: string): { channel: string; targetId: string } {
  const raw = String(key || '').trim()
  const idx = raw.indexOf(':')
  if (idx <= 0) return { channel: '', targetId: '' }
  return { channel: raw.slice(0, idx), targetId: raw.slice(idx + 1) }
}

export function pushTargetKey(channel: string, targetId: string): string {
  const ch = String(channel || '').trim()
  const tid = String(targetId || '').trim()
  if (!ch || !tid) return ''
  return `${ch}:${tid}`
}

export function pickDefaultPushTargetKey(targets: PushTargetOption[]): string {
  if (!Array.isArray(targets) || !targets.length) return ''
  const feishuDefault = targets.find((t) => t.source === 'feishu_default')
  return String((feishuDefault || targets[0])?.id || '')
}
