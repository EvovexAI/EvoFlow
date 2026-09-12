/**
 * Settings「代码索引」面板：状态 / 搜索结果 / 图谱
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { createElement } from 'react'
import { CodeIndexGraph } from '../../react/obs/components/CodeIndexGraph'
import { CodeIndexProgress } from '../../react/obs/components/CodeIndexProgress'
import { DataTable } from '../../react/obs/components/DataTable'
import {
  fetchCodeIndexBuild,
  fetchCodeIndexSearch,
  fetchCodeIndexStatus,
  relationsFromSearchResponse,
  waitForCodeIndexReady,
} from '../../react/obs/lib/code-index-api'
import { api } from '../../lib/tauri-api.js'
import type {
  CodeIndexStatus,
  IndexHit,
  IndexRelation,
  IndexSymbol,
} from '../../react/obs/types/code-index'

type ResultTab = 'symbols' | 'content' | 'relations' | 'related'

const RELATION_KIND_LABEL: Record<string, string> = {
  imported_by: '导入者',
  imports: '被导入',
  internal_ref: '内部引用',
  type_supertype: '父类型',
  type_subtype: '子类型',
}

function shortPath(path: string) {
  const p = String(path || '').replace(/\\/g, '/')
  const parts = p.split('/').filter(Boolean)
  if (parts.length <= 3) return p
  return `…/${parts.slice(-3).join('/')}`
}

function UsageCodeIndexPanel() {
  const [workspace, setWorkspace] = useState('')
  const [history, setHistory] = useState<string[]>([])
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<IndexHit[]>([])
  const [symbols, setSymbols] = useState<IndexSymbol[]>([])
  const [relatedFiles, setRelatedFiles] = useState<IndexHit[]>([])
  const [relations, setRelations] = useState<IndexRelation[]>([])
  const [focusPath, setFocusPath] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<ResultTab>('symbols')
  const [hasSearched, setHasSearched] = useState(false)
  const [loading, setLoading] = useState(false)
  const [building, setBuilding] = useState(false)
  const [indexStatus, setIndexStatus] = useState<CodeIndexStatus | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = (await api.listUserWorkspaceHistory()) as { paths?: string[] }
        const paths = Array.isArray(res?.paths) ? res.paths.filter(Boolean) : []
        if (cancelled) return
        setHistory(paths)
        if (paths[0]) setWorkspace(paths[0])
      } catch {
        if (!cancelled) setHistory([])
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const refreshStatus = useCallback(async () => {
    if (!workspace) {
      setIndexStatus(null)
      return
    }
    try {
      const st = await fetchCodeIndexStatus(workspace)
      setIndexStatus(st)
      setBuilding(!!st.building)
    } catch (err) {
      console.error('[settings code-index] status failed', err)
    }
  }, [workspace])

  useEffect(() => {
    void refreshStatus()
  }, [refreshStatus])

  useEffect(() => {
    if (!workspace) return
    const ms = building || indexStatus?.building ? 2000 : 15000
    const id = window.setInterval(() => void refreshStatus(), ms)
    return () => window.clearInterval(id)
  }, [workspace, building, indexStatus?.building, refreshStatus])

  const applySearchResponse = useCallback((res: Awaited<ReturnType<typeof fetchCodeIndexSearch>>) => {
    const nextHits = res.hits || []
    const nextSymbols = res.symbols || []
    const nextRelated = res.related_files || []
    const rel = relationsFromSearchResponse(res)
    setHits(nextHits)
    setSymbols(nextSymbols)
    setRelatedFiles(nextRelated)
    setRelations(rel)
    setFocusPath(res.symbols?.[0]?.path || res.hits?.[0]?.path || null)
    setHasSearched(true)

    if (nextSymbols.length) setActiveTab('symbols')
    else if (nextHits.length) setActiveTab('content')
    else if (rel.length) setActiveTab('relations')
    else if (nextRelated.length) setActiveTab('related')
    else setActiveTab('symbols')

    if (res.ready === false) {
      setError('索引未就绪：可点「构建索引」')
    } else if (!nextHits.length && !nextSymbols.length && !rel.length && !nextRelated.length) {
      setError('没有匹配结果，可换关键词重试')
    } else if (!rel.length && (nextHits.length || nextSymbols.length)) {
      setError(null)
    } else {
      setError(null)
    }
  }, [])

  const runSearch = useCallback(async () => {
    const q = query.trim() || 'class'
    if (!workspace) {
      setError('请先选择工作空间')
      return
    }
    setLoading(true)
    setError(null)
    try {
      const res = await fetchCodeIndexSearch(q, 40, workspace)
      applySearchResponse(res)
      void refreshStatus()
    } catch (e) {
      setHits([])
      setSymbols([])
      setRelatedFiles([])
      setRelations([])
      setHasSearched(true)
      setError(String((e as Error)?.message || e || '搜索失败'))
    } finally {
      setLoading(false)
    }
  }, [query, workspace, refreshStatus, applySearchResponse])

  useEffect(() => {
    if (!workspace) return
    let cancelled = false
    ;(async () => {
      setLoading(true)
      setError(null)
      setHasSearched(false)
      try {
        const res = await fetchCodeIndexSearch('class', 40, workspace)
        if (cancelled) return
        applySearchResponse(res)
      } catch (e) {
        if (!cancelled) {
          setHits([])
          setSymbols([])
          setRelatedFiles([])
          setRelations([])
          setError(String((e as Error)?.message || e || '加载失败'))
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [workspace, applySearchResponse])

  const handleBuild = useCallback(async () => {
    if (!workspace) return
    setBuilding(true)
    setError(null)
    try {
      await fetchCodeIndexBuild(workspace, true)
      const st = await waitForCodeIndexReady(workspace, {
        onProgress: (s) => {
          setIndexStatus(s)
          setBuilding(!!s.building)
        },
      })
      setIndexStatus(st)
      setBuilding(false)
      await runSearch()
    } catch (e) {
      setBuilding(false)
      setError(String((e as Error)?.message || e || '构建失败'))
    }
  }, [workspace, runSearch])

  const shortWs = useMemo(() => {
    const p = workspace.replace(/\\/g, '/')
    const parts = p.split('/')
    return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : p
  }, [workspace])

  const graphCounts = useMemo(() => {
    const nodes = new Set<string>()
    for (const r of relations) {
      if (r.from_path) nodes.add(r.from_path)
      if (r.to_path) nodes.add(r.to_path)
    }
    return { edges: relations.length, nodes: nodes.size }
  }, [relations])

  const hasResults =
    symbols.length > 0 || hits.length > 0 || relations.length > 0 || relatedFiles.length > 0

  return (
    <div className="su-code-index">
      <div className="su-code-index-toolbar">
        <label className="su-code-index-field">
          <span>工作空间</span>
          <select
            value={workspace}
            onChange={(e) => setWorkspace(e.target.value)}
            aria-label="工作空间"
          >
            {!workspace && <option value="">选择工作空间…</option>}
            {history.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
        <label className="su-code-index-field su-code-index-field--grow">
          <span>搜索</span>
          <input
            type="search"
            value={query}
            placeholder="符号 / 文件名（回车或点搜索）"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void runSearch()
            }}
          />
        </label>
        <button
          type="button"
          className="btn btn-sm btn-secondary"
          disabled={loading || !workspace}
          onClick={() => void runSearch()}
        >
          {loading ? '加载中…' : '搜索图谱'}
        </button>
        <button
          type="button"
          className="btn btn-sm btn-primary"
          disabled={building || !workspace}
          onClick={() => void handleBuild()}
        >
          {building ? '构建中…' : '构建索引'}
        </button>
      </div>
      {workspace ? <p className="su-code-index-hint">当前：{shortWs}</p> : null}

      {workspace ? (
        <div className="su-code-index-status-wrap">
          <CodeIndexProgress status={indexStatus} building={building} />
          <div className="su-code-index-meta-row">
            <span>
              图谱边 <strong>{graphCounts.edges}</strong>
            </span>
            <span>
              图谱节点 <strong>{graphCounts.nodes}</strong>
            </span>
            {indexStatus?.db_path ? (
              <span className="su-code-index-db" title={indexStatus.db_path}>
                DB · {indexStatus.db_path.replace(/\\/g, '/').split('/').slice(-2).join('/')}
              </span>
            ) : null}
          </div>
        </div>
      ) : null}

      {error ? <p className="su-code-index-error">{error}</p> : null}

      {hasSearched && hasResults ? (
        <section className="su-code-index-results" aria-label="搜索结果">
          <header className="su-code-index-results-head">
            <h3>搜索结果</h3>
            <div className="su-code-index-results-stats">
              <span>
                符号 <strong>{symbols.length}</strong>
              </span>
              <span>
                内容 <strong>{hits.length}</strong>
              </span>
              <span>
                关系 <strong>{relations.length}</strong>
              </span>
              {relatedFiles.length > 0 ? (
                <span>
                  相关文件 <strong>{relatedFiles.length}</strong>
                </span>
              ) : null}
            </div>
          </header>

          <div className="su-code-index-tabs" role="tablist">
            {symbols.length > 0 ? (
              <button
                type="button"
                role="tab"
                className={`su-code-index-tab${activeTab === 'symbols' ? ' is-active' : ''}`}
                aria-selected={activeTab === 'symbols'}
                onClick={() => setActiveTab('symbols')}
              >
                符号 ({symbols.length})
              </button>
            ) : null}
            {hits.length > 0 ? (
              <button
                type="button"
                role="tab"
                className={`su-code-index-tab${activeTab === 'content' ? ' is-active' : ''}`}
                aria-selected={activeTab === 'content'}
                onClick={() => setActiveTab('content')}
              >
                内容 ({hits.length})
              </button>
            ) : null}
            {relations.length > 0 ? (
              <button
                type="button"
                role="tab"
                className={`su-code-index-tab${activeTab === 'relations' ? ' is-active' : ''}`}
                aria-selected={activeTab === 'relations'}
                onClick={() => setActiveTab('relations')}
              >
                关系 ({relations.length})
              </button>
            ) : null}
            {relatedFiles.length > 0 ? (
              <button
                type="button"
                role="tab"
                className={`su-code-index-tab${activeTab === 'related' ? ' is-active' : ''}`}
                aria-selected={activeTab === 'related'}
                onClick={() => setActiveTab('related')}
              >
                相关文件 ({relatedFiles.length})
              </button>
            ) : null}
          </div>

          <div className="su-code-index-results-body">
            {activeTab === 'symbols' && symbols.length > 0 ? (
              <DataTable<IndexSymbol>
                compact
                rows={symbols}
                rowKey={(row) => `${row.path}:${row.name}:${row.line}`}
                onRowClick={(row) => setFocusPath(row.path)}
                columns={[
                  { key: 'name', label: '符号', render: (row) => <strong>{row.name}</strong> },
                  {
                    key: 'kind',
                    label: '类型',
                    render: (row) => <span className="su-code-index-kind">{row.kind}</span>,
                  },
                  {
                    key: 'path',
                    label: '文件',
                    render: (row) => (
                      <span className="su-code-index-path" title={row.path}>
                        {shortPath(row.path)}
                      </span>
                    ),
                  },
                  { key: 'line', label: '行', render: (row) => String(row.line) },
                ]}
              />
            ) : null}

            {activeTab === 'content' && hits.length > 0 ? (
              <DataTable<IndexHit>
                compact
                rows={hits}
                rowKey={(row) => row.path}
                onRowClick={(row) => setFocusPath(row.path)}
                columns={[
                  {
                    key: 'path',
                    label: '文件',
                    render: (row) => (
                      <span className="su-code-index-path" title={row.path}>
                        {shortPath(row.path)}
                      </span>
                    ),
                  },
                  {
                    key: 'snippet',
                    label: '片段',
                    render: (row) => (
                      <pre className="su-code-index-snippet">{row.snippet || '—'}</pre>
                    ),
                  },
                ]}
              />
            ) : null}

            {activeTab === 'relations' && relations.length > 0 ? (
              <DataTable<IndexRelation>
                compact
                rows={relations}
                rowKey={(row) => `${row.from_path}:${row.to_path}:${row.kind}:${row.symbol || ''}`}
                onRowClick={(row) => setFocusPath(row.from_path || row.to_path)}
                columns={[
                  {
                    key: 'from_path',
                    label: '来源',
                    render: (row) => (
                      <span className="su-code-index-path" title={row.from_path}>
                        {shortPath(row.from_path)}
                      </span>
                    ),
                  },
                  {
                    key: 'to_path',
                    label: '目标',
                    render: (row) => (
                      <span className="su-code-index-path" title={row.to_path}>
                        {shortPath(row.to_path)}
                      </span>
                    ),
                  },
                  {
                    key: 'kind',
                    label: '关系',
                    render: (row) => (
                      <span className="su-code-index-kind">
                        {RELATION_KIND_LABEL[row.kind] || row.kind}
                      </span>
                    ),
                  },
                  {
                    key: 'symbol',
                    label: '符号',
                    render: (row) => row.symbol || '—',
                  },
                ]}
              />
            ) : null}

            {activeTab === 'related' && relatedFiles.length > 0 ? (
              <DataTable<IndexHit>
                compact
                rows={relatedFiles}
                rowKey={(row) => row.path}
                onRowClick={(row) => setFocusPath(row.path)}
                columns={[
                  {
                    key: 'path',
                    label: '文件路径',
                    render: (row) => (
                      <span className="su-code-index-path" title={row.path}>
                        {row.path}
                      </span>
                    ),
                  },
                ]}
              />
            ) : null}
          </div>
        </section>
      ) : null}

      {hasSearched && !hasResults && !loading && !error ? (
        <p className="su-code-index-empty-results">暂无搜索结果</p>
      ) : null}

      <CodeIndexGraph relations={relations} focusPath={focusPath} />
    </div>
  )
}

/** @type {Root | null} */
let _root: Root | null = null

/**
 * @param {HTMLElement} host
 */
export function mountUsageCodeIndexPanel(host: HTMLElement) {
  unmountUsageCodeIndexPanel()
  _root = createRoot(host)
  _root.render(createElement(UsageCodeIndexPanel))
}

export function unmountUsageCodeIndexPanel() {
  if (_root) {
    try {
      _root.unmount()
    } catch {
      /* ignore */
    }
    _root = null
  }
}
