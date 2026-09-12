/** 内存缓存 + 进行中去重，避免同参数重复打 Gateway */
type CacheEntry<T> = {
  data?: T
  fetchedAt: number
  promise?: Promise<T>
}

const store = new Map<string, CacheEntry<unknown>>()

/** 缓存有效时长；菜单来回切换时直接读缓存 */
export const OBS_FETCH_CACHE_TTL_MS = 90_000

/** 超过此时间仍显示旧数据，但后台静默刷新（预留） */
export const OBS_FETCH_STALE_MS = 30_000

export function obsFetchCacheKey(scope: string, params: Record<string, unknown>): string {
  return `${scope}:${JSON.stringify(params)}`
}

export async function obsFetchCached<T>(
  key: string,
  fetcher: () => Promise<T>,
  options?: { ttlMs?: number; force?: boolean },
): Promise<T> {
  const ttlMs = options?.ttlMs ?? OBS_FETCH_CACHE_TTL_MS
  const now = Date.now()
  const hit = store.get(key) as CacheEntry<T> | undefined

  if (!options?.force && hit?.data !== undefined && now - hit.fetchedAt < ttlMs) {
    return hit.data
  }

  if (hit?.promise) {
    return hit.promise
  }

  const promise = fetcher()
    .then((data) => {
      store.set(key, { data, fetchedAt: Date.now() })
      return data
    })
    .catch((err) => {
      const cur = store.get(key) as CacheEntry<T> | undefined
      if (cur?.promise === promise) {
        store.delete(key)
      }
      throw err
    })

  store.set(key, {
    data: hit?.data,
    fetchedAt: hit?.fetchedAt ?? 0,
    promise,
  })

  return promise
}

export function obsFetchCachePeek<T>(key: string): T | undefined {
  return (store.get(key) as CacheEntry<T> | undefined)?.data
}

export function obsFetchCacheInvalidate(prefix?: string) {
  if (!prefix) {
    store.clear()
    return
  }
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) store.delete(key)
  }
}
