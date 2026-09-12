import { useEffect } from 'react'
import { useThreadTitles } from '../hooks/useThreadTitles'

type ThreadLabelProps = {
  threadId: string | null | undefined
  /** Show truncated thread id under the title */
  showId?: boolean
  className?: string
}

export function ThreadLabel({ threadId, showId = false, className }: ThreadLabelProps) {
  const { version, displayLabel, getTitle, registerThreadIds } = useThreadTitles()
  const tid = String(threadId || '').trim()

  useEffect(() => {
    if (tid && tid !== '—') registerThreadIds([tid])
  }, [registerThreadIds, tid])

  if (!tid || tid === '—') return <span className={className}>—</span>

  const title = getTitle(tid)
  const label = displayLabel(tid)
  void version

  return (
    <span className={className ? `obs-thread-label ${className}` : 'obs-thread-label'} title={tid}>
      <span className="obs-thread-label__title">{label}</span>
      {showId && title ? <span className="obs-thread-label__id">{tid}</span> : null}
    </span>
  )
}

/** Register many thread ids when a list/table loads. */
export function useRegisterThreadIds(threadIds: Iterable<string | null | undefined>) {
  const { registerThreadIds } = useThreadTitles()
  const key = [...threadIds]
    .map((id) => String(id || '').trim())
    .filter((id) => id && id !== '—')
    .sort()
    .join('|')

  useEffect(() => {
    if (!key) return
    registerThreadIds(key.split('|'))
  }, [key, registerThreadIds])
}
