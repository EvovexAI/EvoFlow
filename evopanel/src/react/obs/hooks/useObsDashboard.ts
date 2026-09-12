import { useCallback, useEffect, useState } from 'react'
import type { ObsDashboardBundle, ObsStatusFilter, ObsTimeRangeKey } from '../lib/obs-types'
import {
  fetchAgents,
  fetchObsDashboard,
  fetchObsStatus,
  getObsTimeRange,
  setObsTimeRange,
} from '../lib/obs-api'
import { obsFetchCached, obsFetchCacheInvalidate, obsFetchCacheKey, obsFetchCachePeek } from './obs-fetch-cache'

function formatObsFetchError(err: unknown): string {
  const msg = String((err as Error)?.message || err || '未知错误')
  if (/timeout|timed out|aborted|abort/i.test(msg)) {
    return 'Gateway 请求超时，请确认 Gateway 已启动后重试'
  }
  if (/failed to fetch|network|ECONNREFUSED|fetch/i.test(msg)) {
    return 'Gateway 不可达，请确认后端已启动后重试'
  }
  return msg
}

export function useObsDashboard() {
  const [timeRange, setTimeRangeState] = useState<ObsTimeRangeKey>(getObsTimeRange())
  const [agentFilter, setAgentFilter] = useState('all')
  const [modelFilter, setModelFilter] = useState('all')
  const [providerFilter, setProviderFilter] = useState('all')
  const [statusFilter, setStatusFilter] = useState<ObsStatusFilter>('all')
  const [data, setData] = useState<ObsDashboardBundle | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [agents, setAgents] = useState<{ id?: string; name?: string; display_name?: string }[]>([])

  const setTimeRange = useCallback((key: ObsTimeRangeKey) => {
    setObsTimeRange(key)
    setTimeRangeState(key)
  }, [])

  const reload = useCallback(async (force = false) => {
    const cacheKey = obsFetchCacheKey('dashboard', {
      timeRange,
      agentFilter,
      modelFilter,
      providerFilter,
      statusFilter,
    })
    const cached = obsFetchCachePeek<ObsDashboardBundle>(cacheKey)
    if (!cached) setLoading(true)
    setError(null)
    try {
      const status = (await fetchObsStatus()) as { enabled?: boolean; error?: string }
      if (status?.enabled !== true) {
        setData((prev) => (prev?.enabled ? prev : { enabled: false }))
        setError(status?.error || '观测数据未启用，请检查观测配置')
        return
      }

      if (force) obsFetchCacheInvalidate('dashboard')

      const bundle = await obsFetchCached(
        cacheKey,
        () =>
          fetchObsDashboard({
            timeRange,
            agentFilter,
            modelFilter,
            providerFilter,
            statusFilter,
          }),
        { force },
      )
      setData(bundle)
      if (!bundle.enabled) {
        setError('观测数据不可用（SQLite 未启用或无数据）')
      }
    } catch (err) {
      setError(formatObsFetchError(err))
    } finally {
      setLoading(false)
    }
  }, [timeRange, agentFilter, modelFilter, providerFilter, statusFilter])

  useEffect(() => {
    queueMicrotask(() => void reload())
  }, [reload])

  useEffect(() => {
    void fetchAgents().then(setAgents).catch(() => setAgents([]))
  }, [])

  return {
    timeRange,
    setTimeRange,
    agentFilter,
    setAgentFilter,
    modelFilter,
    setModelFilter,
    providerFilter,
    setProviderFilter,
    statusFilter,
    setStatusFilter,
    data,
    loading,
    error,
    agents,
    reload,
  }
}
