import { useEffect, useState } from 'react'
import { checkObsEnabled } from '../obs/lib/obs-api.js'

/** Whether Gateway SQLite observability is enabled (same gate as 运维 → 会话调试). */
export function useObsEnabled(): { enabled: boolean; loading: boolean } {
  const [enabled, setEnabled] = useState<boolean | null>(null)

  useEffect(() => {
    let cancelled = false
    void checkObsEnabled()
      .then((v) => {
        if (!cancelled) setEnabled(v)
      })
      .catch(() => {
        if (!cancelled) setEnabled(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  return { enabled: enabled === true, loading: enabled === null }
}
