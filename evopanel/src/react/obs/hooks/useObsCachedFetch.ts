import { useCallback, useEffect, useRef, useState } from 'react'
import { useObsQuery } from './ObsContext'
import { obsFetchCached, obsFetchCacheKey, obsFetchCachePeek } from './obs-fetch-cache'

type UseObsCachedFetchOptions<T> = {
  scope: string
  params?: Record<string, unknown>
  fetcher: (query: ReturnType<typeof useObsQuery>) => Promise<T>
  enabled?: boolean
}

/**
 * 带内存缓存的页面数据加载 — 配合 ObsKeepAlive 使用：
 * - 菜单来回切换：组件不卸载，不再重复请求
 * - 筛选条件变化：新 cache key，只拉一次
 * - 90s 内同参数：直接读缓存
 */
export function useObsCachedFetch<T>({
  scope,
  params = {},
  fetcher,
  enabled = true,
}: UseObsCachedFetchOptions<T>) {
  const query = useObsQuery()
  const cacheKey = obsFetchCacheKey(scope, { ...query, ...params })
  const cached = obsFetchCachePeek<T>(cacheKey)

  const [data, setData] = useState<T | null>(cached ?? null)
  const [loading, setLoading] = useState(enabled && cached == null)
  const [error, setError] = useState<string | null>(null)
  const fetcherRef = useRef(fetcher)
  const queryRef = useRef(query)

  useEffect(() => {
    fetcherRef.current = fetcher
    queryRef.current = query
  })

  const load = useCallback(
    async (force = false) => {
      const peek = obsFetchCachePeek<T>(cacheKey)
      if (!peek) setLoading(true)
      setError(null)
      try {
        const result = await obsFetchCached(cacheKey, () => fetcherRef.current(queryRef.current), { force })
        setData(result)
      } catch (err) {
        setError(err instanceof Error ? err.message : '加载失败')
        if (!peek) setData(null)
      } finally {
        setLoading(false)
      }
    },
    [cacheKey],
  )

  useEffect(() => {
    if (!enabled) return
    const peek = obsFetchCachePeek<T>(cacheKey)
    if (peek != null) {
      queueMicrotask(() => {
        setData(peek)
        setLoading(false)
      })
    }
    queueMicrotask(() => queueMicrotask(() => void load(false)))
  }, [cacheKey, enabled, load])

  return { data, loading, error, reload: () => load(true) }
}
