import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { Card } from '../components/Card'
import { DataTable } from '../components/DataTable'
import { JsonViewer } from '../components/JsonViewer'
import { CodeIndexGraph } from '../components/CodeIndexGraph'
import { CodeIndexProgress } from '../components/CodeIndexProgress'
import type { CodeIndexStatus, IndexHit, IndexSymbol, IndexRelation } from '../types/code-index'
import {
  fetchCodeIndexSearch,
  fetchCodeIndexBuild,
  fetchCodeIndexStatus,
  waitForCodeIndexReady,
  relationsFromSearchResponse,
} from '../lib/code-index-api'
export function CodeIndex() {
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<IndexHit[]>([])
  const [symbols, setSymbols] = useState<IndexSymbol[]>([])
  const [relations, setRelations] = useState<IndexRelation[]>([])
  const [relatedFiles, setRelatedFiles] = useState<IndexHit[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [ready, setReady] = useState<boolean | null>(null)
  const [building, setBuilding] = useState(false)
  const [indexStatus, setIndexStatus] = useState<CodeIndexStatus | null>(null)
  const [selectedIndex, setSelectedIndex] = useState<IndexHit | IndexSymbol | null>(null)
  const [activeTab, setActiveTab] = useState<'symbols' | 'content' | 'relations'>('symbols')
  
  // 当前工作空间(从对话界面选择的工作空间)
  const [currentWorkspace, setCurrentWorkspace] = useState<string>('')
  // 工作空间历史(从用户历史中获取)
  const [workspaceHistory, setWorkspaceHistory] = useState<string[]>([])
  const [showWorkspaceHistory, setShowWorkspaceHistory] = useState(false)
  const workspaceDropdownRef = useRef<HTMLDivElement>(null)

  // 点击外部关闭工作空间下拉菜单
  useEffect(() => {
    if (!showWorkspaceHistory) return
    const handleClickOutside = (e: MouseEvent) => {
      if (workspaceDropdownRef.current && !workspaceDropdownRef.current.contains(e.target as Node)) {
        setShowWorkspaceHistory(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [showWorkspaceHistory])

  // 加载工作空间历史
  const loadWorkspaceHistory = useCallback(async () => {
    try {
      const { gatewayFetch } = await import('../../../lib/gateway-json.js')
      const res = await gatewayFetch('/api/workspaces/user-history', { method: 'GET' })
      const data = await res.json()
      if (data?.paths) {
        setWorkspaceHistory(data.paths)
        // 默认选择第一个(最新的)工作空间
        if (data.paths.length > 0) {
          setCurrentWorkspace(data.paths[0])
        }
      }
    } catch (err) {
      console.error('Failed to load workspace history:', err)
    }
  }, [])

  useEffect(() => {
    queueMicrotask(() => {
    loadWorkspaceHistory()
  })
  }, [loadWorkspaceHistory])

  const refreshIndexStatus = useCallback(async () => {
    if (!currentWorkspace) {
      setIndexStatus(null)
      return
    }
    try {
      const st = await fetchCodeIndexStatus(currentWorkspace)
      setIndexStatus(st)
      setReady(!!st.ready)
      setBuilding(!!st.building)
    } catch (err) {
      console.error('[CodeIndex] status poll failed:', err)
    }
  }, [currentWorkspace])

  useEffect(() => {
    queueMicrotask(() => void refreshIndexStatus())
  }, [refreshIndexStatus])

  useEffect(() => {
    if (!currentWorkspace) return
    const ms = building || indexStatus?.building ? 2000 : 15000
    const id = setInterval(() => void refreshIndexStatus(), ms)
    return () => clearInterval(id)
  }, [currentWorkspace, building, indexStatus?.building, refreshIndexStatus])

  const graphFocusPath = useMemo(
    () => symbols[0]?.path || hits[0]?.path || null,
    [symbols, hits]
  )

  const handleSearch = useCallback(async () => {
    const q = query.trim()
    if (!q) {
      setError('请输入搜索关键词')
      return
    }
    setLoading(true)
    setError(null)
    try {
      const res = await fetchCodeIndexSearch(q, 50, currentWorkspace || undefined)
      setHits(res.hits || [])
      setSymbols(res.symbols || [])
      setRelatedFiles(res.related_files || [])
      setRelations(relationsFromSearchResponse(res))
      setReady(res.ready ?? null)
      setBuilding(!!res.building)
      void refreshIndexStatus()
    } catch (err) {
      console.error('[CodeIndex] Search error:', err)
      setError(err instanceof Error ? err.message : '搜索失败')
    } finally {
      setLoading(false)
    }
  }, [query, currentWorkspace, refreshIndexStatus])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleSearch()
    }
  }

  // 选择工作空间
  const handleWorkspaceChange = useCallback(async (workspacePath: string) => {
    setCurrentWorkspace(workspacePath)
    setShowWorkspaceHistory(false)
    // 清空之前的搜索结果
    setHits([])
    setSymbols([])
    setRelations([])
    setRelatedFiles([])
    setQuery('')
    void refreshIndexStatus()
  }, [refreshIndexStatus])

  // 从历史记录中选择工作空间
  const handleHistorySelect = useCallback((path: string) => {
    handleWorkspaceChange(path)
  }, [handleWorkspaceChange])

  // 从历史记录中移除
  const removeFromHistory = useCallback(async (path: string) => {
    try {
      const { gatewayJson } = await import('../../../lib/gateway-json.js')
      await gatewayJson('POST', '/api/workspaces/user-history/remove', { path })
      const updated = workspaceHistory.filter(p => p !== path)
      setWorkspaceHistory(updated)
      if (currentWorkspace === path) {
        setCurrentWorkspace(updated[0] || '')
      }
    } catch (err) {
      console.error('Failed to remove workspace history:', err)
    }
  }, [workspaceHistory, currentWorkspace])

  const handleRowClick = (row: IndexHit | IndexSymbol) => {
    setSelectedIndex(selectedIndex === row ? null : row)
  }

  const renderDetailDrawer = () => {
    if (!selectedIndex) return null
    const isHit = 'snippet' in selectedIndex
    return (
      <div className="code-index-drawer-overlay" onClick={() => setSelectedIndex(null)}>
        <div className="code-index-drawer" onClick={(e) => e.stopPropagation()}>
          <div className="code-index-drawer-header">
            <h2>{isHit ? '代码内容' : '符号定义'}</h2>
            <button className="code-index-drawer-close" onClick={() => setSelectedIndex(null)}>✕</button>
          </div>
          <div className="code-index-drawer-body">
            <div className="code-index-detail-section">
              <div className="code-index-detail-label">文件路径</div>
              <div className="code-index-detail-value">{(selectedIndex as any).path}</div>
            </div>
            {!isHit && (
              <div className="code-index-detail-section">
                <div className="code-index-detail-label">符号类型</div>
                <div className="code-index-detail-value">{(selectedIndex as IndexSymbol).kind}</div>
              </div>
            )}
            {!isHit && (
              <div className="code-index-detail-section">
                <div className="code-index-detail-label">行号</div>
                <div className="code-index-detail-value">{(selectedIndex as IndexSymbol).line}</div>
              </div>
            )}
            {isHit && (
              <div className="code-index-detail-section">
                <div className="code-index-detail-label">代码片段</div>
                <div className="code-index-detail-value code-index-snippet">
                  // @ts-ignore
                  <JsonViewer title="" value={(selectedIndex as IndexHit).snippet || ''} maxHeight={400} />
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    )
  }

  return (
    <>
      <div className="code-index-page">
        {/* 工作空间选择器 */}
        <div className="code-index-header">
          <div>
            <h1>代码索引搜索</h1>
            <p className="code-index-subtitle">搜索已索引的代码内容和符号定义</p>
          </div>
        </div>

        <Card className="code-index-workspace-card">
          <div className="code-index-workspace-selector">
            <label className="code-index-workspace-label">工作空间</label>
            <div className="code-index-workspace-dropdown" ref={workspaceDropdownRef}>
              <button 
                className="code-index-workspace-btn"
                onClick={() => setShowWorkspaceHistory(!showWorkspaceHistory)}
              >
                {currentWorkspace || '选择工作空间...'} ▾
              </button>
              {showWorkspaceHistory && (
                <div className="code-index-workspace-menu">
                  {workspaceHistory.length > 0 && (
                    <div className="code-index-workspace-section">
                      <div className="code-index-workspace-section-title">历史记录</div>
                      {workspaceHistory.map((path, idx) => (
                        <div key={idx} className="code-index-workspace-history-item">
                          <button
                            className={`code-index-workspace-item ${currentWorkspace === path ? 'active' : ''}`}
                            onClick={() => handleHistorySelect(path)}
                          >
                            <span className="code-index-workspace-icon">🕐</span>
                            <span className="code-index-workspace-name">{path}</span>
                          </button>
                          <button
                            className="code-index-workspace-remove"
                            onClick={(e) => {
                              e.stopPropagation()
                              removeFromHistory(path)
                            }}
                            title="移除"
                          >
                            ✕
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  {workspaceHistory.length === 0 && (
                    <div className="code-index-workspace-empty">暂无工作空间历史</div>
                  )}
                </div>
              )}
            </div>
            {currentWorkspace && (
              <button 
                className="code-index-build-btn"
                disabled={building}
                onClick={async () => {
                  setBuilding(true)
                  setError(null)
                  try {
                    await fetchCodeIndexBuild(currentWorkspace, true)
                    const st = await waitForCodeIndexReady(currentWorkspace, {
                      timeoutMs: 20 * 60 * 1000,
                      onProgress: (s) => setIndexStatus(s),
                    })
                    setReady(!!st.ready)
                    setIndexStatus(st)
                    if (!st.ready) {
                      setError('索引构建超时，请稍后刷新状态或重试')
                    }
                  } catch (err) {
                    console.error('Failed to build index:', err)
                    setError(err instanceof Error ? err.message : '索引构建失败')
                  } finally {
                    setBuilding(false)
                    void refreshIndexStatus()
                  }
                }}
              >
                {building ? '构建中…' : '🔄 重建索引'}
              </button>
            )}
          </div>
        </Card>

        {currentWorkspace && (
          <Card title="索引构建进度" subtitle="Index Build Progress">
            <CodeIndexProgress status={indexStatus} building={building} />
            {indexStatus?.db_path && (
              <div className="code-index-progress-db">
                数据库: <code>{indexStatus.db_path}</code>
              </div>
            )}
          </Card>
        )}

        <Card className="code-index-search-card">
          <div className="code-index-search-box">
            <input
              type="text"
              className="code-index-search-input"
              placeholder="输入关键词搜索代码（支持模糊匹配）..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
            />
            <button
              className="code-index-search-btn"
              onClick={handleSearch}
              disabled={loading || building}
            >
              {loading ? '搜索中...' : building ? '索引构建中...' : '搜索'}
            </button>
            {query && (
              <button className="code-index-clear-btn" onClick={() => {
                setQuery('')
                setHits([])
                setSymbols([])
                setRelations([])
                setRelatedFiles([])
              }}>
                清除
              </button>
            )}
          </div>
          {error && <div className="code-index-error">{error}</div>}

          {currentWorkspace && !hits.length && !symbols.length && (
            <div className="code-index-hint">
              <div>💡 提示：输入函数名、类名或代码片段进行搜索</div>
              <div style={{ marginTop: '8px', fontSize: '13px', color: 'var(--text-muted)' }}>
                当前工作空间:{' '}
                <code style={{ backgroundColor: 'var(--obs-surface-muted)', padding: '2px 6px', borderRadius: '4px' }}>
                  {currentWorkspace}
                </code>
              </div>
            </div>
          )}
        </Card>

        {currentWorkspace && (
          <Card title="代码图谱" subtitle="Code Graph">
            <CodeIndexGraph relations={relations} focusPath={graphFocusPath} />
          </Card>
        )}

        {ready !== false && (hits.length > 0 || symbols.length > 0) && (
          <div className="code-index-stats">
            <span className="code-index-stat">
              找到 <strong>{symbols.length}</strong> 个符号匹配
            </span>
            <span className="code-index-stat">
              找到 <strong>{hits.length}</strong> 个内容匹配
            </span>
            {relatedFiles.length > 0 && (
              <span className="code-index-stat">
                相关 <strong>{relatedFiles.length}</strong> 个文件
              </span>
            )}
          </div>
        )}

        {(symbols.length > 0 || hits.length > 0 || relations.length > 0) && (
          <Card title="搜索结果" subtitle="Search Results">
            <div className="code-index-tabs">
              {symbols.length > 0 && (
                <button
                  className={`code-index-tab ${activeTab === 'symbols' ? 'active' : ''}`}
                  onClick={() => setActiveTab('symbols')}
                >
                  符号 ({symbols.length})
                </button>
              )}
              {hits.length > 0 && (
                <button
                  className={`code-index-tab ${activeTab === 'content' ? 'active' : ''}`}
                  onClick={() => setActiveTab('content')}
                >
                  内容 ({hits.length})
                </button>
              )}
              {relations.length > 0 && (
                <button
                  className={`code-index-tab ${activeTab === 'relations' ? 'active' : ''}`}
                  onClick={() => setActiveTab('relations')}
                >
                  关系 ({relations.length})
                </button>
              )}
            </div>

            {activeTab === 'symbols' && symbols.length > 0 && (
              <DataTable<IndexSymbol>
                rows={symbols}
                rowKey={(row) => `${row.path}:${row.name}:${row.line}`}
                onRowClick={(row) => handleRowClick(row)}
                columns={[
                  { key: 'name', label: '符号', render: (row) => <strong>{row.name}</strong> },
                  { key: 'kind', label: '类型', render: (row) => <span className="code-index-kind">{row.kind}</span> },
                  { key: 'path', label: '文件', render: (row) => <span className="code-index-path">{row.path}</span> },
                  { key: 'line', label: '行号', render: (row) => <span className="code-index-line">{row.line}</span> },
                ]}
              />
            )}

            {activeTab === 'content' && hits.length > 0 && (
              <DataTable<IndexHit>
                rows={hits}
                rowKey={(row) => row.path}
                onRowClick={(row) => handleRowClick(row)}
                columns={[
                  { key: 'path', label: '文件', render: (row) => <span className="code-index-path">{row.path}</span> },
                  {
                    key: 'snippet',
                    label: '代码片段',
                    render: (row) => (
                      <div className="code-index-snippet-inline">
                        // @ts-ignore
                        <JsonViewer title="" value={row.snippet || ''} maxHeight={150} />
                      </div>
                    ),
                  },
                ]}
              />
            )}

            {activeTab === 'relations' && relations.length > 0 && (
              <DataTable<IndexRelation>
                rows={relations}
                rowKey={(row) => `${row.from_path}:${row.to_path}:${row.kind}:${row.symbol || ''}`}
                columns={[
                  { key: 'from_path', label: '来源文件', render: (row) => <span className="code-index-path">{row.from_path}</span> },
                  { key: 'to_path', label: '目标文件', render: (row) => <span className="code-index-path">{row.to_path}</span> },
                  {
                    key: 'kind',
                    label: '关系类型',
                    render: (row) => {
                      const kindMap: Record<string, { label: string; color: string }> = {
                        imported_by: { label: '导入者', color: 'var(--blue)' },
                        imports: { label: '被导入', color: 'var(--green)' },
                        internal_ref: { label: '内部引用', color: 'var(--purple)' },
                        type_supertype: { label: '父类型', color: '#f59e0b' },
                        type_subtype: { label: '子类型', color: '#ef4444' },
                      }
                      const config = kindMap[row.kind] || { label: row.kind, color: 'var(--text-secondary)' }
                      return (
                        <span className="code-index-relation-chip" style={{ borderColor: config.color }}>
                          {config.label}
                        </span>
                      )
                    },
                  },
                  {
                    key: 'symbol',
                    label: '符号',
                    render: (row) => row.symbol ? <span>{row.symbol}</span> : null,
                  },
                ]}
              />
            )}
          </Card>
        )}

        {relatedFiles.length > 0 && (
          <Card title="相关文件" subtitle="Related Files" className="code-index-related-card">
            <DataTable<IndexHit>
              rows={relatedFiles}
              rowKey={(row) => row.path}
              columns={[
                { key: 'path', label: '文件路径', render: (row) => <span className="code-index-path">{row.path}</span> },
              ]}
            />
          </Card>
        )}

        {renderDetailDrawer()}
      </div>
    </>
  )
}