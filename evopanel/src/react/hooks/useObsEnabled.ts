import { useCallback, useEffect, useState } from 'react'
import {
  OBS_ENABLED_CHANGED_EVENT,
  fetchObsEnabledStatus,
  type ObsEnabledStatus,
} from '../obs/lib/obs-api.js'

/** Whether Gateway SQLite observability is enabled (same gate as 运维 → 会话调试). */
export function useObsEnabled(): {
  enabled: boolean
  loading: boolean
  lockedByEnv: boolean
  refresh: () => Promise<void>
} {
  const [status, setStatus] = useState<ObsEnabledStatus | null>(null)

  const refresh = useCallback(async () => {
    const next = await fetchObsEnabledStatus()
    setStatus(next)
  }, [])

  useEffect(() => {
    let cancelled = false
    void fetchObsEnabledStatus()
      .then((next) => {
        if (!cancelled) setStatus(next)
      })
      .catch(() => {
        if (!cancelled) setStatus({ enabled: false, lockedByEnv: false })
      })

    const onChanged = (ev: Event) => {
      const detail = (ev as CustomEvent<{ enabled?: boolean }>).detail
      if (typeof detail?.enabled === 'boolean') {
        setStatus((prev) => ({
          enabled: detail.enabled === true,
          lockedByEnv: prev?.lockedByEnv === true,
        }))
      } else {
        void refresh()
      }
    }
    window.addEventListener(OBS_ENABLED_CHANGED_EVENT, onChanged)
    return () => {
      cancelled = true
      window.removeEventListener(OBS_ENABLED_CHANGED_EVENT, onChanged)
    }
  }, [refresh])

  return {
    enabled: status?.enabled === true,
    loading: status === null,
    lockedByEnv: status?.lockedByEnv === true,
    refresh,
  }
}
