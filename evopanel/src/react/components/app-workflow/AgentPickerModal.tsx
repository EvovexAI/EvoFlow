import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import AssignedAgentAvatar from '../AssignedAgentAvatar.tsx'
import {
  BUILTIN_AGENT_TAGS,
  agentCapabilitySummary,
  buildTagPickerEntries,
  filterAgentsByTag,
  normalizeAgentTags,
  tagMetaForLabel,
  type AgentPickerRow,
} from '../../lib/agent-tags.ts'
import { labelSkills, resolveAgentToolsDisplay } from '../../lib/agent-caps-display.ts'
import type { SkillPickerItem } from '../SkillPickerModal.tsx'
import type { WorkflowToolItem } from '../../hooks/useWorkflowResources.ts'

type Props = {
  open: boolean
  onClose: () => void
  agents: AgentPickerRow[]
  tools?: WorkflowToolItem[]
  skills?: SkillPickerItem[]
  loading: boolean
  selected?: string | null
  /** select：挑选确认；detail：查看自带能力并可编辑员工/智能体 */
  mode?: 'select' | 'detail'
  onConfirm?: (agentCode: string) => void
  onEdit?: (agentCode: string) => void
}

export function AgentPickerModal({
  open,
  onClose,
  agents,
  tools = [],
  skills = [],
  loading,
  selected,
  mode = 'select',
  onConfirm,
  onEdit,
}: Props) {
  const isDetail = mode === 'detail'
  const [query, setQuery] = useState('')
  const [tagFilter, setTagFilter] = useState<string | null>(null)
  const [draft, setDraft] = useState<string>(selected || '')
  const searchRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (!open) return
    queueMicrotask(() => {
        setDraft(selected || '')
        setQuery('')
        setTagFilter(null)
      })
  }, [open, selected])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  useEffect(() => {
    if (!open) return
    const t = window.setTimeout(() => searchRef.current?.focus(), 0)
    return () => window.clearTimeout(t)
  }, [open])

  // 与聊天侧 AgentPicker 共用 chip 样式；员工/通用/内置类优先，长尾标签截断防刷屏
  const tagEntries = useMemo(() => {
    const all = buildTagPickerEntries(agents)
    const priority = new Map<string, number>([
      ['员工', 0],
      ['通用', 1],
      ...BUILTIN_AGENT_TAGS.map((t, i) => [t.label, i + 2] as const),
    ])
    return [...all]
      .sort((a, b) => {
        const pa = priority.has(a.label) ? (priority.get(a.label) as number) : 1000
        const pb = priority.has(b.label) ? (priority.get(b.label) as number) : 1000
        if (pa !== pb) return pa - pb
        return b.agent_count - a.agent_count || a.label.localeCompare(b.label, 'zh')
      })
      .slice(0, 18)
  }, [agents])

  const filtered = useMemo(() => {
    const byTag = filterAgentsByTag(agents, tagFilter)
    const q = query.trim().toLowerCase()
    if (!q) return byTag
    return byTag.filter((a) => {
      const code = String(a.agent_code || '').toLowerCase()
      const name = String(a.agent_name || '').toLowerCase()
      const tagText = normalizeAgentTags(a.tags).join(' ').toLowerCase()
      const desc = String(a.description || '').toLowerCase()
      return code.includes(q) || name.includes(q) || tagText.includes(q) || desc.includes(q)
    })
  }, [agents, tagFilter, query])

  const draftAgent = useMemo(
    () => agents.find((a) => String(a.agent_code || '') === draft) || null,
    [agents, draft],
  )

  const draftLabel = useMemo(() => {
    if (!draft) return ''
    return String(draftAgent?.agent_name || draft)
  }, [draft, draftAgent])

  const draftCaps = useMemo(() => agentCapabilitySummary(draftAgent, 8), [draftAgent])
  const draftSkillTags = useMemo(
    () => labelSkills(draftCaps.skills, skills),
    [draftCaps.skills, skills],
  )
  const draftToolDisplay = useMemo(
    () => resolveAgentToolsDisplay(draftAgent, tools, 12),
    [draftAgent, tools],
  )

  const confirm = (code: string) => {
    const next = code.trim()
    if (!next || !onConfirm) return
    onConfirm(next)
    onClose()
  }

  if (!open) return null

  return createPortal(
    <div
      className="react-chat-modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={isDetail ? '执行者详情' : '选择执行者'}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className="react-chat-modal-card react-chat-skill-modal wf-agent-picker"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="react-chat-modal-header">
          <div>
            <span className="react-chat-modal-title">
              {isDetail ? '执行者详情' : '选择执行者'}
            </span>
            <p className="react-chat-modal-desc" style={{ margin: '4px 0 0' }}>
              {isDetail
                ? '查看自带技能与工具；可打开编辑员工 / 智能体资料'
                : '优先复用在编员工；没有合适的可用通用 Agent · 双击可直接确认'}
            </p>
          </div>
          <button type="button" className="react-chat-modal-close" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </div>

        <div className="react-chat-modal-body react-chat-skill-modal-body">
          <div className="react-chat-skill-dropdown-search">
            <input
              ref={searchRef}
              type="search"
              className="react-chat-skill-dropdown-search-input"
              placeholder="搜索名称、编码、标签…"
              value={query}
              aria-label="搜索执行者"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
            />
          </div>

          {tagEntries.length ? (
            <div className="react-chat-skill-tag-bar" role="tablist" aria-label="按标签筛选">
              <button
                type="button"
                className={`react-chat-skill-tag-chip${!tagFilter ? ' active' : ''}`}
                onClick={() => setTagFilter(null)}
              >
                全部
              </button>
              {tagEntries.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  className={`react-chat-skill-tag-chip${tagFilter === t.label ? ' active' : ''}`}
                  style={{ ['--tag-color' as string]: t.color || '#64748b' } as CSSProperties}
                  onClick={() => setTagFilter((prev) => (prev === t.label ? null : t.label))}
                >
                  {t.icon ? `${t.icon} ` : ''}
                  {t.label}
                  {t.agent_count > 0 ? (
                    <span className="wf-agent-picker-tag-n">{t.agent_count}</span>
                  ) : null}
                </button>
              ))}
            </div>
          ) : null}

          {draft ? (
            <div className="wf-agent-picker-selected">
              <div className="react-chat-skill-modal-selected">
                <span className="react-chat-skill-modal-chip">
                  <span className="react-chat-skill-modal-chip-label">{draftLabel}</span>
                </span>
              </div>
              {draftCaps.description ? (
                <p className="wf-agent-picker-selected-desc">{draftCaps.description}</p>
              ) : (
                <p className="wf-agent-picker-selected-desc is-muted">暂无描述</p>
              )}
              <div className="wf-agent-picker-cap-block">
                <span className="wf-agent-picker-cap-title">
                  自带技能{draftCaps.skillTotal ? ` · ${draftCaps.skillTotal}` : ''}
                </span>
                {draftSkillTags.length ? (
                  <div className="wf-agent-picker-cap-chips">
                    {draftSkillTags.map((s) => (
                      <span key={s.id} className="wf-agent-picker-cap-chip" title={s.id}>
                        {s.label}
                      </span>
                    ))}
                    {draftCaps.skillsMore > 0 ? (
                      <span className="wf-agent-picker-cap-chip is-more">+{draftCaps.skillsMore}</span>
                    ) : null}
                  </div>
                ) : (
                  <span className="wf-agent-picker-cap-empty">未配置技能</span>
                )}
              </div>
              <div className="wf-agent-picker-cap-block">
                <span className="wf-agent-picker-cap-title">
                  自带工具{draftToolDisplay.total ? ` · ${draftToolDisplay.total}` : ''}
                  {draftToolDisplay.mode === 'default' ? ' · 默认包' : ''}
                </span>
                {draftToolDisplay.tags.length ? (
                  <div className="wf-agent-picker-cap-chips">
                    {draftToolDisplay.tags.map((t) => (
                      <span key={t.id} className="wf-agent-picker-cap-chip" title={t.id}>
                        {t.label}
                      </span>
                    ))}
                    {draftToolDisplay.more > 0 ? (
                      <span className="wf-agent-picker-cap-chip is-more">+{draftToolDisplay.more}</span>
                    ) : null}
                  </div>
                ) : (
                  <span className="wf-agent-picker-cap-empty">工具列表加载中…</span>
                )}
              </div>
            </div>
          ) : null}

          <div className="wf-agent-picker-grid">
            {loading ? (
              <div className="react-chat-bottom-dropdown-empty wf-agent-picker-empty">加载中…</div>
            ) : null}

            {!loading && filtered.length === 0 ? (
              <div className="react-chat-bottom-dropdown-empty wf-agent-picker-empty">无匹配智能体</div>
            ) : null}

            {filtered.map((a) => {
              const code = String(a.agent_code || '')
              const active = draft === code
              const tags = normalizeAgentTags(a.tags)
              const caps = agentCapabilitySummary(a, 3)
              const toolDisp = resolveAgentToolsDisplay(a, tools, 3)
              const skillDisp = labelSkills(caps.skills, skills)
              const desc = caps.description
              return (
                <button
                  key={code}
                  type="button"
                  className={`wf-agent-picker-item${active ? ' is-active' : ''}`}
                  onClick={() => setDraft(code)}
                  onDoubleClick={() => {
                    if (!isDetail) confirm(code)
                  }}
                >
                  <AssignedAgentAvatar agentCode={code} agents={agents} size={32} />
                  <span className="wf-agent-picker-main">
                    <span className="wf-agent-picker-name" title={a.agent_name || code}>
                      {a.agent_name || code}
                    </span>
                    <span className="wf-agent-picker-code" title={code}>
                      {code}
                    </span>
                    {desc ? (
                      <span className="wf-agent-picker-desc" title={desc}>
                        {desc}
                      </span>
                    ) : null}
                    {skillDisp.length || toolDisp.tags.length ? (
                      <span className="wf-agent-picker-mini-caps">
                        {skillDisp.length
                          ? `技能 ${skillDisp.map((s) => s.label).join('、')}${
                              caps.skillsMore ? ` +${caps.skillsMore}` : ''
                            }`
                          : ''}
                        {skillDisp.length && toolDisp.tags.length ? ' · ' : ''}
                        {toolDisp.tags.length
                          ? `工具 ${toolDisp.tags.map((t) => t.label).join('、')}${
                              toolDisp.more ? ` +${toolDisp.more}` : ''
                            }${toolDisp.mode === 'default' ? '（默认）' : ''}`
                          : ''}
                      </span>
                    ) : null}
                    {tags.length > 0 ? (
                      <span className="react-chat-skill-item-tags">
                        {tags.slice(0, 3).map((label) => {
                          const meta = tagMetaForLabel(label)
                          return (
                            <span
                              key={label}
                              className="react-chat-skill-item-tag"
                              style={{ '--tag-color': meta.color || '#64748b' } as CSSProperties}
                            >
                              {meta.icon ? `${meta.icon} ` : ''}
                              {label}
                            </span>
                          )
                        })}
                      </span>
                    ) : null}
                  </span>
                  {active ? <span className="wf-agent-picker-check">✓</span> : null}
                </button>
              )
            })}
          </div>
        </div>

        <div className="react-chat-modal-actions react-chat-skill-modal-actions">
          <span className="react-chat-skill-modal-footer-count">
            {draft ? `${isDetail ? '当前' : '已选'}：${draftLabel}` : '未选择'}
          </span>
          <button type="button" className="react-chat-modal-btn react-chat-modal-btn--ghost" onClick={onClose}>
            {isDetail ? '关闭' : '取消'}
          </button>
          {isDetail ? (
            <button
              type="button"
              className="react-chat-modal-btn react-chat-modal-btn--primary"
              disabled={!draft || !onEdit}
              onClick={() => {
                const code = draft.trim()
                if (!code || !onEdit) return
                onEdit(code)
              }}
            >
              编辑资料
            </button>
          ) : (
            <button
              type="button"
              className="react-chat-modal-btn react-chat-modal-btn--primary"
              disabled={!draft}
              onClick={() => confirm(draft)}
            >
              确定
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}
