import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchSessionKnowledgeMap } from '../../lib/knowledge-map-fetch.js'

export interface KnowledgeMapNode {
  external_id?: string
  kind?: string
  parent_external_id?: string | null
  title?: string
  body?: string
  status?: string
  meta?: Record<string, unknown>
  created_at?: string
  updated_at?: string
}

export interface KnowledgeMapEdge {
  external_id?: string
  from_external_id?: string
  to_external_id?: string
  rel?: string
  label?: string
}

export interface KnowledgeMapSnapshot {
  threadId?: string
  sessionKey?: string
  header?: {
    graph_version?: number
    node_count?: number
    edge_count?: number
    render_summary?: string
    goal?: string
  } | null
  nodes?: KnowledgeMapNode[]
  edges?: KnowledgeMapEdge[]
  graphVersion?: number
  nodeCount?: number
  edgeCount?: number
}

export function useKnowledgeMap(
  sessionKey: string | null | undefined,
  opts?: { enabled?: boolean; refreshKey?: number; pollMs?: number },
) {
  const enabled = !!opts?.enabled && !!String(sessionKey || '').trim()
  const refreshKey = opts?.refreshKey ?? 0
  const pollMs = opts?.pollMs ?? 0
  const [data, setData] = useState<KnowledgeMapSnapshot | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const activeRef = useRef(true)

  const load = useCallback(async () => {
    const sk = String(sessionKey || '').trim()
    if (!sk) {
      setData(null)
      setError(null)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const snap = (await fetchSessionKnowledgeMap(sk)) as KnowledgeMapSnapshot
      if (!activeRef.current) return
      setData(snap)
    } catch (e) {
      if (!activeRef.current) return
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      if (activeRef.current) setLoading(false)
    }
  }, [sessionKey])

  useEffect(() => {
    activeRef.current = true
    if (!enabled) {
      queueMicrotask(() => {
        setData(null)
        setError(null)
        setLoading(false)
      })
      return () => {
        activeRef.current = false
      }
    }
    queueMicrotask(() => void load())
    return () => {
      activeRef.current = false
    }
  }, [enabled, load, refreshKey])

  useEffect(() => {
    if (!enabled || !pollMs || pollMs < 1000) return undefined
    const id = window.setInterval(() => {
      void load()
    }, pollMs)
    return () => window.clearInterval(id)
  }, [enabled, load, pollMs])

  return { data, loading, error, refresh: load }
}
