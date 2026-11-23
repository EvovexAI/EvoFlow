import { useCallback, useEffect, useMemo, useState } from 'react'
import { fetchCapabilityContextOverhead } from '../../lib/capability-context-overhead.js'

export type AgentCapabilityPatch = {
  skills?: string[]
  tools?: string[] | null
  mcp_servers?: string[] | null
  knowledge_vault_ids?: string[]
}

type CapTab = 'skills' | 'tools' | 'mcp' | 'knowledge'

type CapRow = { id: string; name: string; tokens?: number | null }

type CatalogItem = { id: string; name: string; tier?: string; disabled?: boolean }

const TABS: { id: CapTab; label: string }[] = [
  { id: 'skills', label: '技能' },
  { id: 'tools', label: '工具' },
  { id: 'mcp', label: 'MCP' },
  { id: 'knowledge', label: '知识库' },
]

const PREVIEW = 8

function formatTokExact(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—'
  return Math.max(0, Math.round(n)).toLocaleString('en-US')
}

function formatTok(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—'
  const v = Math.max(0, Math.round(n))
  if (v >= 1000) return `${(v / 1000).toFixed(1)}k`
  return String(v)
}

async function loadSkillCatalog(includeDisabled = false): Promise<CatalogItem[]> {
  const { api } = await import('../../lib/tauri-api.js')
  try {
    // force：用户点开「添加」就是要看当前真实清单。走缓存会把应用启动时的旧快照
    // 端上来（外部拷进来的技能永远不出现），这里强制重新拉一次 /skills。
    const rows = await api.loadSkills({ force: true })
    const list = Array.isArray(rows) ? rows : []
    return list
      // 默认只给「可绑定」的技能；用户打开「显示已停用」时把停用项也列出来，
      // 否则刚拷进 skills/custom 的批量技能一旦被判成停用就永远点不到（只能看空列表）。
      .filter((s: { enabled?: boolean }) => includeDisabled || s?.enabled !== false)
      .map((s: { name?: string; enabled?: boolean }) => {
        const name = String(s?.name || '').trim()
        return name ? { id: name, name, disabled: s?.enabled === false } : null
      })
      .filter(Boolean) as CatalogItem[]
  } catch {
    return []
  }
}

async function loadToolCatalog(): Promise<CatalogItem[]> {
  const { api } = await import('../../lib/tauri-api.js')
  try {
    const meta = await api.getToolsMetadata()
    const tools = Array.isArray(meta?.tools) ? meta.tools : []
    return tools
      .map((t: { value?: string; name?: string; label?: string; tool_type?: string }) => {
        const id = String(t?.value || t?.name || '').trim()
        if (!id) return null
        const tier = String(t?.tool_type || 'optional').trim() || 'optional'
        if (tier === 'retired') return null
        return {
          id,
          name: String(t?.label || t?.name || id).trim() || id,
          tier,
        }
      })
      .filter(Boolean) as CatalogItem[]
  } catch {
    return []
  }
}

async function loadMcpCatalog(): Promise<CatalogItem[]> {
  const { api } = await import('../../lib/tauri-api.js')
  try {
    const cfg = await api.getMCPConfig()
    const servers = cfg?.mcp_servers && typeof cfg.mcp_servers === 'object' ? cfg.mcp_servers : {}
    return Object.entries(servers)
      .filter(([, c]) => (c as { enabled?: boolean })?.enabled !== false)
      .map(([name, c]) => ({
        id: name,
        name: String((c as { description?: string })?.description || name).trim() || name,
      }))
  } catch {
    return []
  }
}

async function loadKnowledgeCatalog(): Promise<CatalogItem[]> {
  const { api } = await import('../../lib/tauri-api.js')
  try {
    const raw = await api.listOwnedKnowledgeBases()
    const list = Array.isArray(raw)
      ? raw
      : Array.isArray(raw?.bases)
        ? raw.bases
        : Array.isArray(raw?.items)
          ? raw.items
          : []
    return list
      .map((row: { id?: string; name?: string; title?: string }) => {
        const id = String(row?.id || '').trim()
        if (!id) return null
        return { id, name: String(row?.name || row?.title || id).trim() || id }
      })
      .filter(Boolean) as CatalogItem[]
  } catch {
    return []
  }
}

export function AgentCapabilityTabs({
  skillNames,
  toolNames,
  mcpServers = null,
  knowledgeVaultIds = [],
  modelName = '',
  editable = false,
  busy = false,
  /** 工作流侧栏：一行芯片切换，不要大四格 + 重复 Tab */
  compact = false,
  onPatch,
}: {
  skillNames: string[]
  /** null = unrestricted (all tools) */
  toolNames?: string[] | null
  /** null = unrestricted */
  mcpServers?: string[] | null
  knowledgeVaultIds?: string[]
  modelName?: string
  editable?: boolean
  busy?: boolean
  compact?: boolean
  onPatch?: (patch: AgentCapabilityPatch) => Promise<void>
}) {
  const [tab, setTab] = useState<CapTab>('skills')
  const [expanded, setExpanded] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerQ, setPickerQ] = useState('')
  const [catalog, setCatalog] = useState<CatalogItem[]>([])
  const [catalogLoading, setCatalogLoading] = useState(false)
  const [skillTok, setSkillTok] = useState<Map<string, number | null>>(() => new Map())
  const [toolTok, setToolTok] = useState<Map<string, number | null>>(() => new Map())
  const [skillsTotal, setSkillsTotal] = useState<number | null>(null)
  const [toolsTotal, setToolsTotal] = useState<number | null>(null)
  const [tokLoading, setTokLoading] = useState(false)
  const [kbCatalog, setKbCatalog] = useState<CatalogItem[]>([])
  const [mcpCatalog, setMcpCatalog] = useState<CatalogItem[]>([])
  const [toolCatalog, setToolCatalog] = useState<CatalogItem[]>([])
  const [patching, setPatching] = useState(false)
  /** 「添加技能」里是否连已停用的技能一起列出（默认否；用来排查“装了却看不到”） */
  const [pickerShowDisabled, setPickerShowDisabled] = useState(false)
  /** 本地乐观覆盖：父级 agents 列表刷新慢/漂移时，点 × 仍立刻从列表消失 */
  const [localOverride, setLocalOverride] = useState<AgentCapabilityPatch | null>(null)

  const effectiveSkillNames = localOverride?.skills ?? skillNames
  const effectiveToolNames =
    localOverride && Object.prototype.hasOwnProperty.call(localOverride, 'tools')
      ? localOverride.tools
      : toolNames
  const effectiveMcpServers =
    localOverride && Object.prototype.hasOwnProperty.call(localOverride, 'mcp_servers')
      ? localOverride.mcp_servers
      : mcpServers
  const effectiveKnowledgeVaultIds =
    localOverride?.knowledge_vault_ids ?? knowledgeVaultIds

  const mcpUnrestricted = effectiveMcpServers == null
  const toolsUnrestricted = effectiveToolNames == null
  const boundToolNames = Array.isArray(effectiveToolNames) ? effectiveToolNames : []
  const boundMcpNames = Array.isArray(effectiveMcpServers) ? effectiveMcpServers : []
  // Parent panels may recreate these arrays on every render.  Depend on a
  // content signature below so token estimation only runs when the actual
  // capability selection changes (rather than on every render).
  const skillNamesSignature = JSON.stringify(effectiveSkillNames)
  const toolNamesSignature = JSON.stringify(effectiveToolNames)
  const mcpNamesSignature = JSON.stringify(effectiveMcpServers)
  const knowledgeSignature = JSON.stringify(effectiveKnowledgeVaultIds)
  /** 步骤切换时的能力指纹：用来把默认 Tab 切到「已有内容」的那一栏 */
  const stepCapSignature = `${skillNamesSignature}|${toolNamesSignature}|${mcpNamesSignature}|${knowledgeSignature}`

  useEffect(() => {
    setExpanded(false)
    setPickerOpen(false)
    setPickerQ('')
  }, [tab])

  // 父级 props 追上本地乐观值后清掉 override，避免和远端永久分叉
  useEffect(() => {
    if (!localOverride) return
    const skillsSame =
      localOverride.skills === undefined ||
      JSON.stringify(localOverride.skills) === JSON.stringify(skillNames)
    const toolsSame =
      !Object.prototype.hasOwnProperty.call(localOverride, 'tools') ||
      JSON.stringify(localOverride.tools ?? null) === JSON.stringify(toolNames ?? null)
    const mcpSame =
      !Object.prototype.hasOwnProperty.call(localOverride, 'mcp_servers') ||
      JSON.stringify(localOverride.mcp_servers ?? null) === JSON.stringify(mcpServers ?? null)
    const kbSame =
      localOverride.knowledge_vault_ids === undefined ||
      JSON.stringify(localOverride.knowledge_vault_ids) === JSON.stringify(knowledgeVaultIds)
    if (skillsSame && toolsSame && mcpSame && kbSame) setLocalOverride(null)
  }, [localOverride, skillNames, toolNames, mcpServers, knowledgeVaultIds])

  // 点节点时若已绑工具却停在「技能」空态，看起来像「没配工具」——自动切到有内容的栏
  useEffect(() => {
    if (boundToolNames.length) setTab('tools')
    else if (effectiveSkillNames.length) setTab('skills')
    else if (effectiveKnowledgeVaultIds.length) setTab('knowledge')
    else if (!mcpUnrestricted && boundMcpNames.length) setTab('mcp')
    else setTab('skills')
    setExpanded(false)
    setPickerOpen(false)
    setPickerQ('')
    // 仅随步骤能力指纹变化；不要跟 tab 本身循环
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stepCapSignature])

  useEffect(() => {
    let cancelled = false
    void loadKnowledgeCatalog().then((rows) => {
      if (!cancelled) setKbCatalog(rows)
    })
    void loadMcpCatalog().then((rows) => {
      if (!cancelled) setMcpCatalog(rows)
    })
    void loadToolCatalog().then((rows) => {
      if (!cancelled) setToolCatalog(rows)
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    const toolsForTok = boundToolNames
    if (!effectiveSkillNames.length && !toolsForTok.length) {
      setTokLoading(false)
      return () => {
        cancelled = true
      }
    }
    setTokLoading(true)
    void fetchCapabilityContextOverhead({
      skills: effectiveSkillNames,
      tools: toolsForTok,
      model: modelName || null,
    })
      .then((data) => {
        if (cancelled) return
        const sm = new Map<string, number | null>()
        for (const r of data.skills) sm.set(r.name, r.tokens)
        const tm = new Map<string, number | null>()
        for (const r of data.tools) tm.set(r.name, r.tokens)
        setSkillTok(sm)
        setToolTok(tm)
        setSkillsTotal(data.skillsTotal > 0 ? data.skillsTotal : null)
        setToolsTotal(data.toolsTotal > 0 ? data.toolsTotal : null)
      })
      .catch(() => {
        if (cancelled) return
        setSkillTok(new Map())
        setToolTok(new Map())
        setSkillsTotal(null)
        setToolsTotal(null)
      })
      .finally(() => {
        if (!cancelled) setTokLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [skillNamesSignature, toolNamesSignature, modelName])

  const knowledgeRows: CapRow[] = useMemo(() => {
    const byId = new Map(kbCatalog.map((k) => [k.id, k.name]))
    return effectiveKnowledgeVaultIds.map((id) => ({
      id,
      name: byId.get(id) || id,
    }))
  }, [effectiveKnowledgeVaultIds, kbCatalog])

  const mcpRows: CapRow[] = useMemo(() => {
    if (Array.isArray(effectiveMcpServers)) {
      const byId = new Map(mcpCatalog.map((k) => [k.id, k.name]))
      return effectiveMcpServers.map((id) => ({ id, name: byId.get(id) || id }))
    }
    return mcpCatalog.map((k) => ({ id: k.id, name: k.name }))
  }, [effectiveMcpServers, mcpCatalog])

  const skillRows: CapRow[] = useMemo(
    () =>
      effectiveSkillNames.map((name) => ({
        id: name,
        name,
        tokens: skillTok.get(name) ?? null,
      })),
    [effectiveSkillNames, skillTok],
  )
  const toolRows: CapRow[] = useMemo(() => {
    if (toolsUnrestricted) {
      return toolCatalog.map((t) => ({ id: t.id, name: t.name, tokens: toolTok.get(t.id) ?? null }))
    }
    if (boundToolNames.length) {
      const byId = new Map(toolCatalog.map((t) => [t.id, t.name]))
      return boundToolNames.map((name) => ({
        id: name,
        name: byId.get(name) || name,
        tokens: toolTok.get(name) ?? null,
      }))
    }
    return []
  }, [toolsUnrestricted, toolCatalog, boundToolNames, toolTok])

  const activeRows =
    tab === 'skills'
      ? skillRows
      : tab === 'tools'
        ? toolRows
        : tab === 'mcp'
          ? mcpRows
          : knowledgeRows

  const sumLabel =
    tab === 'skills'
      ? skillsTotal != null
        ? `${formatTok(skillsTotal)} · ${effectiveSkillNames.length}个`
        : tokLoading
          ? `计算中 · ${effectiveSkillNames.length}个`
          : `${effectiveSkillNames.length}个`
      : tab === 'tools'
        ? toolsUnrestricted
          ? toolRows.length
            ? `全部 · ${toolRows.length}个`
            : '全部可用'
          : toolsTotal != null
            ? `${formatTok(toolsTotal)} · ${boundToolNames.length}个`
            : tokLoading
              ? `计算中 · ${boundToolNames.length}个`
              : `${boundToolNames.length}个`
        : tab === 'mcp'
          ? mcpUnrestricted
            ? mcpRows.length
              ? `全部 · ${mcpRows.length}个`
              : '全部可用'
            : mcpRows.length
              ? `${mcpRows.length}个`
              : '未连接'
          : knowledgeRows.length
            ? `${knowledgeRows.length}个`
            : '未绑定'

  const emptyText =
    tab === 'skills'
      ? '还没配置技能'
      : tab === 'tools'
        ? toolsUnrestricted
          ? '暂无可用工具'
          : '还没配置工具'
        : tab === 'mcp'
          ? mcpUnrestricted
            ? '暂无启用的 MCP'
            : '未连接 MCP'
          : '未绑定知识库'

  const runPatch = useCallback(
    async (patch: AgentCapabilityPatch) => {
      if (!onPatch) return
      if (patching || busy) return
      setPatching(true)
      // 先乐观更新列表，避免「点了 × 没反应」
      setLocalOverride((prev) => ({ ...(prev || {}), ...patch }))
      try {
        await onPatch(patch)
        setPickerOpen(false)
      } catch (e) {
        // 失败回滚乐观值
        setLocalOverride(null)
        throw e
      } finally {
        setPatching(false)
      }
    },
    [onPatch, patching, busy],
  )

  const openPicker = useCallback(async () => {
    if (!editable || patching || busy) return
    setPickerOpen(true)
    setCatalogLoading(true)
    setPickerQ('')
    setPickerShowDisabled(false)
    try {
      const rows =
        tab === 'skills'
          ? await loadSkillCatalog(false)
          : tab === 'tools'
            ? await loadToolCatalog()
            : tab === 'mcp'
              ? await loadMcpCatalog()
              : await loadKnowledgeCatalog()
      setCatalog(rows)
    } finally {
      setCatalogLoading(false)
    }
  }, [editable, patching, busy, tab])

  /** 切「显示已停用」时按同一 Tab 重新拉一次目录（技能按 enabled 过滤，其它 Tab 不受影响）。 */
  const toggleShowDisabled = useCallback(async () => {
    if (tab !== 'skills') return
    const next = !pickerShowDisabled
    setPickerShowDisabled(next)
    setCatalogLoading(true)
    try {
      setCatalog(await loadSkillCatalog(next))
    } finally {
      setCatalogLoading(false)
    }
  }, [tab, pickerShowDisabled])

  const boundIds = useMemo(() => {
    if (tab === 'skills') return new Set(effectiveSkillNames)
    if (tab === 'tools') {
      if (toolsUnrestricted) return new Set(toolCatalog.map((t) => t.id))
      return new Set(boundToolNames)
    }
    if (tab === 'mcp')
      return mcpUnrestricted
        ? new Set(mcpCatalog.map((m) => m.id))
        : new Set(effectiveMcpServers || [])
    return new Set(effectiveKnowledgeVaultIds)
  }, [
    tab,
    effectiveSkillNames,
    toolsUnrestricted,
    toolCatalog,
    boundToolNames,
    mcpUnrestricted,
    mcpCatalog,
    effectiveMcpServers,
    effectiveKnowledgeVaultIds,
  ])

  const pickerCandidates = useMemo(() => {
    const q = pickerQ.trim().toLowerCase()
    return catalog.filter((c) => {
      if (boundIds.has(c.id)) return false
      if (!q) return true
      return c.id.toLowerCase().includes(q) || c.name.toLowerCase().includes(q)
    })
  }, [catalog, boundIds, pickerQ])

  const onRemove = useCallback(
    async (id: string) => {
      if (!editable || !onPatch) return
      if (tab === 'skills') {
        await runPatch({ skills: effectiveSkillNames.filter((s) => s !== id) })
        return
      }
      if (tab === 'tools') {
        if (toolsUnrestricted) {
          const all = toolCatalog.map((t) => t.id).filter((x) => x !== id)
          await runPatch({ tools: all })
          return
        }
        await runPatch({ tools: boundToolNames.filter((t) => t !== id) })
        return
      }
      if (tab === 'mcp') {
        if (mcpUnrestricted) {
          const all = mcpCatalog.map((m) => m.id).filter((x) => x !== id)
          await runPatch({ mcp_servers: all })
          return
        }
        await runPatch({
          mcp_servers: (effectiveMcpServers || []).filter((m) => m !== id),
        })
        return
      }
      await runPatch({
        knowledge_vault_ids: effectiveKnowledgeVaultIds.filter((k) => k !== id),
      })
    },
    [
      editable,
      onPatch,
      tab,
      effectiveSkillNames,
      toolsUnrestricted,
      toolCatalog,
      boundToolNames,
      mcpUnrestricted,
      mcpCatalog,
      effectiveMcpServers,
      effectiveKnowledgeVaultIds,
      runPatch,
    ],
  )

  const onAdd = useCallback(
    async (id: string) => {
      if (!editable || !onPatch) return
      if (tab === 'skills') {
        if (effectiveSkillNames.includes(id)) return
        await runPatch({ skills: [...effectiveSkillNames, id] })
        return
      }
      if (tab === 'tools') {
        if (toolsUnrestricted) return
        if (boundToolNames.includes(id)) return
        await runPatch({ tools: [...boundToolNames, id] })
        return
      }
      if (tab === 'mcp') {
        if (mcpUnrestricted) return
        if ((effectiveMcpServers || []).includes(id)) return
        await runPatch({ mcp_servers: [...(effectiveMcpServers || []), id] })
        return
      }
      if (effectiveKnowledgeVaultIds.includes(id)) return
      await runPatch({
        knowledge_vault_ids: [...effectiveKnowledgeVaultIds, id],
      })
    },
    [
      editable,
      onPatch,
      tab,
      effectiveSkillNames,
      toolsUnrestricted,
      boundToolNames,
      mcpUnrestricted,
      effectiveMcpServers,
      effectiveKnowledgeVaultIds,
      runPatch,
    ],
  )

  const visible = expanded ? activeRows : activeRows.slice(0, PREVIEW)
  const canExpand = activeRows.length > PREVIEW
  const showTokens = tab === 'skills' || tab === 'tools'
  const disabled = !editable || patching || busy

  const toolsOverviewCount = toolsUnrestricted
    ? toolCatalog.length || toolRows.length
    : boundToolNames.length
  const mcpOverviewCount = mcpUnrestricted
    ? mcpCatalog.length || mcpRows.length
    : (effectiveMcpServers || []).length

  const overviewItems = (
    [
      { id: 'skills' as CapTab, label: '技能', value: effectiveSkillNames.length },
      { id: 'tools' as CapTab, label: '工具', value: toolsOverviewCount },
      {
        id: 'knowledge' as CapTab,
        label: '知识',
        value: effectiveKnowledgeVaultIds.length,
      },
      { id: 'mcp' as CapTab, label: 'MCP', value: mcpOverviewCount },
    ] as const
  )

  return (
    <section
      className={`react-chat-agent-cap is-tabbed${compact ? ' is-compact' : ''}`}
      aria-label="能力概览"
    >
      <div className="react-chat-agent-cap-overview" role="tablist" aria-label="能力概览">
        {overviewItems.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            className={`react-chat-agent-cap-overview-item${tab === item.id ? ' is-active' : ''}`}
            onClick={() => setTab(item.id)}
          >
            {compact ? (
              <>
                <span className="react-chat-agent-cap-overview-label">{item.label}</span>
                <span className="react-chat-agent-cap-overview-value">{item.value}</span>
              </>
            ) : (
              <>
                <span className="react-chat-agent-cap-overview-value">{item.value}</span>
                <span className="react-chat-agent-cap-overview-label">{item.label}</span>
              </>
            )}
          </button>
        ))}
      </div>
      {!compact ? (
        <div className="react-chat-agent-cap-tabs is-detail-tabs" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              className={`react-chat-agent-cap-tab${tab === t.id ? ' is-active' : ''}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
      ) : null}
      <div className="react-chat-agent-cap-toolbar">
        <span className="react-chat-agent-cap-sum" title={sumLabel}>
          {sumLabel}
        </span>
        {editable ? (
          <button
            type="button"
            className="react-chat-agent-cap-add"
            disabled={disabled || (tab === 'mcp' && mcpUnrestricted) || (tab === 'tools' && toolsUnrestricted)}
            title={
              (tab === 'mcp' && mcpUnrestricted) || (tab === 'tools' && toolsUnrestricted)
                ? '当前未限制（全部可用）；移除某一项后会变为白名单'
                : `添加${TABS.find((t) => t.id === tab)?.label || ''}`
            }
            onClick={() => void openPicker()}
          >
            添加
          </button>
        ) : null}
      </div>

      {compact && boundToolNames.length > 0 && tab !== 'tools' ? (
        <button
          type="button"
          className="react-chat-agent-cap-bound-hint"
          onClick={() => setTab('tools')}
          title={boundToolNames.join(', ')}
        >
          已绑工具 {boundToolNames.length}：{boundToolNames.slice(0, 4).join(', ')}
          {boundToolNames.length > 4 ? '…' : ''} · 点此查看
        </button>
      ) : null}

      <div className="react-chat-agent-cap-panel" role="tabpanel">
        {activeRows.length === 0 ? (
          <p className="react-chat-agent-cap-empty">{emptyText}</p>
        ) : (
          <>
            <ul className={`react-chat-agent-cap-list${expanded ? ' is-expanded' : ''}`}>
              {visible.map((row) => (
                <li key={row.id}>
                  <span className="react-chat-agent-cap-name" title={row.name}>
                    {row.name}
                  </span>
                  {showTokens ? (
                    <span
                      className={`react-chat-agent-cap-tok${row.tokens == null && tokLoading ? ' is-pending' : ''}`}
                    >
                      {row.tokens == null
                        ? tokLoading
                          ? '计算中…'
                          : '—'
                        : formatTokExact(row.tokens)}
                    </span>
                  ) : null}
                  {editable ? (
                    <button
                      type="button"
                      className="react-chat-agent-cap-remove"
                      disabled={disabled}
                      aria-label={`移除 ${row.name}`}
                      title="移除"
                      onClick={() => void onRemove(row.id)}
                    >
                      ×
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
            {canExpand ? (
              <button
                type="button"
                className="react-chat-agent-cap-more"
                onClick={() => setExpanded((v) => !v)}
              >
                {expanded ? '收起' : `更多 · ${activeRows.length - PREVIEW}`}
              </button>
            ) : null}
          </>
        )}

        {pickerOpen ? (
          <div className="react-chat-agent-cap-picker">
            <div className="react-chat-agent-cap-picker-head">
              <input
                className="react-chat-agent-cap-picker-search"
                value={pickerQ}
                onChange={(e) => setPickerQ(e.target.value)}
                placeholder="搜索…"
                autoFocus
              />
              {tab === 'skills' ? (
                <label
                  className="react-chat-agent-cap-picker-toggle"
                  title="默认只列可绑定的技能；勾上后连已停用的也列出来（排查“装了却看不到”）"
                >
                  <input
                    type="checkbox"
                    checked={pickerShowDisabled}
                    onChange={() => void toggleShowDisabled()}
                  />
                  含已停用
                </label>
              ) : null}
              <button
                type="button"
                className="react-chat-agent-cap-picker-close"
                onClick={() => setPickerOpen(false)}
              >
                关闭
              </button>
            </div>
            {catalogLoading ? (
              <p className="react-chat-agent-cap-empty">加载可选列表…</p>
            ) : pickerCandidates.length === 0 ? (
              <p className="react-chat-agent-cap-empty">没有可添加的项</p>
            ) : (
              <ul className="react-chat-agent-cap-picker-list">
                {pickerCandidates.slice(0, 40).map((c) => (
                  <li key={c.id}>
                    <button
                      type="button"
                      className="react-chat-agent-cap-picker-item"
                      disabled={disabled}
                      onClick={() => void onAdd(c.id)}
                    >
                      <span className="react-chat-agent-cap-name" title={c.name}>
                        {c.name}
                        {c.disabled ? <span className="react-chat-agent-cap-picker-off">已停用</span> : null}
                      </span>
                      <span className="react-chat-agent-cap-picker-plus">+</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {catalog.length > 40 ? (
              <p className="react-chat-agent-cap-picker-more">
                共 {catalog.length} 项，先显示前 40 项 — 用上方搜索缩小范围
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  )
}
