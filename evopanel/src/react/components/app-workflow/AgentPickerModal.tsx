import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import AssignedAgentAvatar from '../AssignedAgentAvatar.tsx'
import {
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
  onConfirm: (agentCode: string) => void
}

export function AgentPickerModal({
  open,
  onClose,
  agents,
  tools = [],
  skills = [],
  loading,
  selected,
  onConfirm,
}: Props) {
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

  const tagEntries = useMemo(() => buildTagPickerEntries(agents), [agents])

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
    if (!next) return
    onConfirm(next)
    onClose()
  }

  if (!open) return null

  return createPortal(
    <div
      className="react-chat-modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="选择智能体"
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
            <span className="react-chat-modal-title">选择智能体</span>
            <p className="react-chat-modal-desc" style={{ margin: '4px 0 0' }}>
              为本步骤指定执行者 · 查看描述与自带技能/工具 · 双击可直接确认
            </p>
          </div>
          <button type="button" className="react-chat-modal-close" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </div>

        <div className="react-chat-modal-body">
          <input
            ref={searchRef}
            className="react-chat-skill-modal-search"
            placeholder="搜索名称、编码、标签…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />

          {tagEntries.length ? (
            <div className="react-chat-skill-modal-tags" role="tablist">
              <button
                type="button"
                className={`react-chat-skill-tag${!tagFilter ? ' is-active' : ''}`}
                onClick={() => setTagFilter(null)}
              >
                全部
              </button>
              {tagEntries.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  className={`react-chat-skill-tag${tagFilter === t.label ? ' is-active' : ''}`}
                  onClick={() => setTagFilter(t.label)}
                >
                  {t.label}
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
                  onDoubleClick={() => confirm(code)}
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

        <div className="react-chat-modal-footer">
          <span className="react-chat-skill-modal-footer-count">
            {draft ? `已选：${draftLabel}` : '未选择'}
          </span>
          <div className="react-chat-modal-footer-actions">
            <button type="button" className="btn btn-secondary btn-sm" onClick={onClose}>
              取消
            </button>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={!draft}
              onClick={() => confirm(draft)}
            >
              确定
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}
