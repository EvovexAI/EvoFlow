import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { getSkillTags, getSkillTagMeta, SKILL_TAGS } from '../../../lib/skill-catalog.js'
import type { SkillPickerItem, SkillSelection } from '../SkillPickerModal.tsx'
import type { WorkflowToolItem } from '../../hooks/useWorkflowResources.ts'

export type CapabilityPickerResult = {
  skills: SkillSelection[]
  tools: string[]
}

type TabId = 'skills' | 'tools'

const TOOL_TIER_TAGS: Array<{ key: string; label: string; color: string }> = [
  { key: 'runtime', label: '系统核心', color: '#6366f1' },
  { key: 'core', label: '日常常驻', color: '#0ea5e9' },
  { key: 'workspace', label: '工作区', color: '#10b981' },
  { key: 'plan', label: '规划协作', color: '#f59e0b' },
  { key: 'goal', label: '目标模式', color: '#8b5cf6' },
  { key: 'optional', label: '扩展可选', color: '#64748b' },
]

function toolTypeLabel(t: WorkflowToolItem) {
  return t.typeLabel || TOOL_TIER_TAGS.find((x) => x.key === t.tier)?.label || t.tier || ''
}

function toolTagMeta(tier: string) {
  return TOOL_TIER_TAGS.find((x) => x.key === tier) || null
}

/**
 * 技能 + 工具合一选择面板（标签筛选、多选、确定回写）。
 */
export function CapabilityPickerModal({
  open,
  onClose,
  skills,
  tools,
  loading,
  selectedSkills,
  selectedTools,
  onConfirm,
  initialTab = 'skills',
}: {
  open: boolean
  onClose: () => void
  skills: SkillPickerItem[]
  tools: WorkflowToolItem[]
  loading: boolean
  selectedSkills: SkillSelection[]
  selectedTools: string[]
  onConfirm: (next: CapabilityPickerResult) => void
  initialTab?: TabId
}) {
  const [tab, setTab] = useState<TabId>(initialTab)
  const [query, setQuery] = useState('')
  const [skillDraft, setSkillDraft] = useState<SkillSelection[]>(selectedSkills)
  const [toolDraft, setToolDraft] = useState<string[]>(selectedTools)
  const [skillTag, setSkillTag] = useState('all')
  const [toolTag, setToolTag] = useState('all')
  const searchRef = useRef<HTMLInputElement | null>(null)

  const pickerTools = useMemo(
    () => tools.filter((t) => t.tier !== 'retired'),
    [tools],
  )

  useEffect(() => {
    if (!open) return
    queueMicrotask(() => {
        setSkillDraft(selectedSkills)
        setToolDraft(selectedTools)
        setTab(initialTab)
        setQuery('')
        setSkillTag('all')
      })
    queueMicrotask(() => setToolTag('all'))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

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
  }, [open, tab])

  const availableSkillTags = useMemo(() => {
    const keys = new Set<string>()
    for (const s of skills) {
      for (const t of getSkillTags(s.name)) keys.add(t)
    }
    return SKILL_TAGS.filter((t) => keys.has(t.key))
  }, [skills])

  const availableToolTags = useMemo(() => {
    const keys = new Set(pickerTools.map((t) => t.tier || 'optional'))
    return TOOL_TIER_TAGS.filter((t) => keys.has(t.key))
  }, [pickerTools])

  const filteredSkills = useMemo(() => {
    const q = query.trim().toLowerCase()
    return skills.filter((s) => {
      const matchText =
        !q ||
        String(s.name || '').toLowerCase().includes(q) ||
        String(s.label || '').toLowerCase().includes(q) ||
        String(s.description || '').toLowerCase().includes(q)
      const matchTag = skillTag === 'all' || getSkillTags(s.name).includes(skillTag)
      return matchText && matchTag
    })
  }, [skills, query, skillTag])

  const filteredTools = useMemo(() => {
    const q = query.trim().toLowerCase()
    return pickerTools.filter((t) => {
      const matchText =
        !q ||
        t.value.toLowerCase().includes(q) ||
        t.label.toLowerCase().includes(q) ||
        t.desc.toLowerCase().includes(q) ||
        toolTypeLabel(t).toLowerCase().includes(q)
      const matchTag = toolTag === 'all' || (t.tier || 'optional') === toolTag
      return matchText && matchTag
    })
  }, [pickerTools, query, toolTag])

  if (!open || typeof document === 'undefined') return null

  const skillSelected = (name: string) => skillDraft.some((s) => s.name === name)
  const toggleSkill = (s: SkillPickerItem) => {
    setSkillDraft((prev) =>
      skillSelected(s.name)
        ? prev.filter((x) => x.name !== s.name)
        : [...prev, { name: s.name, label: s.label || s.name, icon: s.icon || '🧩' }],
    )
  }
  const toggleTool = (value: string) => {
    setToolDraft((prev) => (prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value]))
  }

  const totalSelected = skillDraft.length + toolDraft.length

  return createPortal(
    <div
      className="react-chat-modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="选择技能与工具"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="react-chat-modal-card react-chat-skill-modal" onClick={(e) => e.stopPropagation()}>
        <div className="react-chat-modal-header">
          <div className="react-chat-skill-modal-header-main">
            <span className="react-chat-modal-title">技能与工具</span>
            <span className="react-chat-skill-modal-sub">可多选 · 都不选也能跑（用智能体默认能力）</span>
          </div>
          <button type="button" className="react-chat-modal-close" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </div>

        <div className="react-chat-modal-body react-chat-skill-modal-body">
          <div className="wf-cap-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'skills'}
              className={`wf-cap-tab${tab === 'skills' ? ' is-active' : ''}`}
              onClick={() => setTab('skills')}
            >
              技能{skillDraft.length ? ` · ${skillDraft.length}` : ''}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'tools'}
              className={`wf-cap-tab${tab === 'tools' ? ' is-active' : ''}`}
              onClick={() => setTab('tools')}
            >
              工具{toolDraft.length ? ` · ${toolDraft.length}` : ''}
            </button>
          </div>

          <div className="react-chat-skill-dropdown-search">
            <input
              ref={searchRef}
              type="search"
              className="react-chat-skill-dropdown-search-input"
              placeholder={tab === 'skills' ? '搜索技能…' : '搜索工具…'}
              value={query}
              aria-label={tab === 'skills' ? '搜索技能' : '搜索工具'}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
            />
          </div>

          {tab === 'skills' && availableSkillTags.length > 0 ? (
            <div className="react-chat-skill-tag-bar">
              <span
                className={`react-chat-skill-tag-chip${skillTag === 'all' ? ' active' : ''}`}
                onClick={() => setSkillTag('all')}
              >
                全部
              </span>
              {availableSkillTags.map((t) => (
                <span
                  key={t.key}
                  className={`react-chat-skill-tag-chip${skillTag === t.key ? ' active' : ''}`}
                  onClick={() => setSkillTag(t.key)}
                >
                  {t.icon} {t.label}
                </span>
              ))}
            </div>
          ) : null}

          {tab === 'tools' && availableToolTags.length > 0 ? (
            <div className="react-chat-skill-tag-bar">
              <span
                className={`react-chat-skill-tag-chip${toolTag === 'all' ? ' active' : ''}`}
                onClick={() => setToolTag('all')}
              >
                全部
              </span>
              {availableToolTags.map((t) => (
                <span
                  key={t.key}
                  className={`react-chat-skill-tag-chip${toolTag === t.key ? ' active' : ''}`}
                  style={{ ['--tag-color' as string]: t.color } as CSSProperties}
                  onClick={() => setToolTag(t.key)}
                >
                  {t.label}
                </span>
              ))}
            </div>
          ) : null}

          {totalSelected > 0 ? (
            <div className="react-chat-skill-modal-selected">
              {skillDraft.map((s) => (
                <span key={`s-${s.name}`} className="react-chat-skill-modal-chip">
                  <span className="react-chat-skill-modal-chip-icon" aria-hidden>
                    {s.icon || '🧩'}
                  </span>
                  <span className="react-chat-skill-modal-chip-label">{s.label}</span>
                  <button
                    type="button"
                    className="react-chat-skill-modal-chip-x"
                    aria-label={`移除技能 ${s.label}`}
                    onClick={() => setSkillDraft((prev) => prev.filter((x) => x.name !== s.name))}
                  >
                    ×
                  </button>
                </span>
              ))}
              {toolDraft.map((name) => {
                const hit = pickerTools.find((t) => t.value === name)
                return (
                  <span key={`t-${name}`} className="react-chat-skill-modal-chip wf-cap-chip--tool">
                    <span className="react-chat-skill-modal-chip-icon" aria-hidden>
                      {hit?.icon || '⚙'}
                    </span>
                    <span className="react-chat-skill-modal-chip-label">{hit?.label || name}</span>
                    <button
                      type="button"
                      className="react-chat-skill-modal-chip-x"
                      aria-label={`移除工具 ${hit?.label || name}`}
                      onClick={() => setToolDraft((prev) => prev.filter((v) => v !== name))}
                    >
                      ×
                    </button>
                  </span>
                )
              })}
              <button
                type="button"
                className="react-chat-skill-modal-clear"
                onClick={() => {
                  setSkillDraft([])
                  setToolDraft([])
                }}
              >
                清空
              </button>
            </div>
          ) : null}

          <div className="react-chat-skill-dropdown-list react-chat-skill-modal-list">
            {loading ? (
              <div className="react-chat-bottom-dropdown-empty">加载中…</div>
            ) : tab === 'skills' ? (
              skills.length === 0 ? (
                <div className="react-chat-bottom-dropdown-empty">暂无可用技能</div>
              ) : filteredSkills.length === 0 ? (
                <div className="react-chat-bottom-dropdown-empty">无匹配技能</div>
              ) : (
                filteredSkills.map((s) => {
                  const active = skillSelected(s.name)
                  const itemTags = getSkillTags(s.name)
                  return (
                    <button
                      key={s.name}
                      type="button"
                      className={`react-chat-bottom-dropdown-item react-chat-skill-item${
                        active ? ' react-chat-bottom-dropdown-item--active' : ''
                      }`}
                      onClick={() => toggleSkill(s)}
                    >
                      <span className="react-chat-skill-item-icon" aria-hidden>
                        {s.icon || '🧩'}
                      </span>
                      <span className="react-chat-skill-item-main">
                        <span className="react-chat-skill-item-label">{s.label || s.name}</span>
                        {s.description ? (
                          <span className="react-chat-skill-item-desc">{s.description}</span>
                        ) : null}
                        {itemTags.length ? (
                          <span className="react-chat-skill-item-tags">
                            {itemTags.map((tk) => {
                              const m = getSkillTagMeta(tk)
                              return (
                                <span
                                  key={tk}
                                  className="react-chat-skill-item-tag"
                                  style={
                                    m ? ({ ['--tag-color' as string]: m.color } as CSSProperties) : undefined
                                  }
                                >
                                  {m?.icon || ''} {m?.label || tk}
                                </span>
                              )
                            })}
                          </span>
                        ) : null}
                      </span>
                      <span className="react-chat-skill-item-check" aria-hidden>
                        {active ? '✓' : ''}
                      </span>
                    </button>
                  )
                })
              )
            ) : pickerTools.length === 0 ? (
              <div className="react-chat-bottom-dropdown-empty">暂无可用工具</div>
            ) : filteredTools.length === 0 ? (
              <div className="react-chat-bottom-dropdown-empty">无匹配工具</div>
            ) : (
              filteredTools.map((t) => {
                const active = toolDraft.includes(t.value)
                const typeLabel = toolTypeLabel(t)
                const meta = toolTagMeta(t.tier || 'optional')
                return (
                  <button
                    key={t.value}
                    type="button"
                    className={`react-chat-bottom-dropdown-item react-chat-skill-item${
                      active ? ' react-chat-bottom-dropdown-item--active' : ''
                    }`}
                    onClick={() => toggleTool(t.value)}
                  >
                    <span className="react-chat-skill-item-icon" aria-hidden>
                      {t.icon || '⚙'}
                    </span>
                    <span className="react-chat-skill-item-main">
                      <span className="react-chat-skill-item-label">{t.label || t.value}</span>
                      {t.desc ? <span className="react-chat-skill-item-desc">{t.desc}</span> : null}
                      {typeLabel ? (
                        <span className="react-chat-skill-item-tags">
                          <span
                            className="react-chat-skill-item-tag"
                            style={
                              meta
                                ? ({ ['--tag-color' as string]: meta.color } as CSSProperties)
                                : undefined
                            }
                          >
                            {typeLabel}
                          </span>
                        </span>
                      ) : null}
                    </span>
                    <span className="react-chat-skill-item-check" aria-hidden>
                      {active ? '✓' : ''}
                    </span>
                  </button>
                )
              })
            )}
          </div>
        </div>

        <div className="react-chat-modal-actions react-chat-skill-modal-actions">
          <span className="react-chat-skill-modal-footer-count">
            {totalSelected > 0
              ? `已选 ${skillDraft.length} 技能 · ${toolDraft.length} 工具`
              : '未选择'}
          </span>
          <button type="button" className="react-chat-modal-btn react-chat-modal-btn--ghost" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="react-chat-modal-btn react-chat-modal-btn--primary"
            onClick={() => {
              onConfirm({ skills: skillDraft, tools: toolDraft })
              onClose()
            }}
          >
            确定{totalSelected > 0 ? `（${totalSelected}）` : ''}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
