import { useCallback, useEffect, useRef, useState } from 'react'
import { useObsQuery } from './ObsContext'
import { obsFetchCached, obsFetchCacheKey, obsFetchCachePeek } from './obs-fetch-cache'

export function useObsPageData<T>(
  scope: string,
  loader: (query: ReturnType<typeof useObsQuery>) => Promise<T>,
  fallback: T,
  extraParams: Record<string, unknown> = {},
) {
  const query = useObsQuery()
  const cacheKey = obsFetchCacheKey(scope, { ...query, ...extraParams })
  const cached = obsFetchCachePeek<T>(cacheKey)

  const [data, setData] = useState<T>(cached ?? fallback)
  const [loading, setLoading] = useState(cached == null)
  const [error, setError] = useState<string | null>(null)
  const loaderRef = useRef(loader)
  const queryRef = useRef(query)

  useEffect(() => {
    loaderRef.current = loader
    queryRef.current = query
  })

  const reload = useCallback(
    async (force = false) => {
      const hasCache = obsFetchCachePeek<T>(cacheKey) != null
      if (!hasCache) setLoading(true)
      setError(null)
      try {
        const result = await obsFetchCached(cacheKey, () => loaderRef.current(queryRef.current), { force })
        setData(result)
      } catch (err) {
        setError(String((err as Error)?.message || err))
        if (!hasCache) setData(fallback)
      } finally {
        setLoading(false)
      }
    },
    [cacheKey, fallback],
  )

  useEffect(() => {
    const peek = obsFetchCachePeek<T>(cacheKey)
    if (peek != null) {
      queueMicrotask(() => {
        setData(peek)
        setLoading(false)
      })
    }
    queueMicrotask(() => queueMicrotask(() => void reload(false)))
  }, [cacheKey, reload])

  return { data, loading, error, reload: () => reload(true), live: !error }
}
