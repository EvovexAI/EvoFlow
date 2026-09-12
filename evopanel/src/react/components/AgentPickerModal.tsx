import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import AgentAvatar from './AgentAvatar.js'
import {
  buildTagPickerEntries,
  filterAgentsByTag,
  normalizeAgentTags,
  tagMetaForLabel,
  type AgentPickerRow,
} from '../lib/agent-tags.js'

/**
 * 对话预设角色单选弹窗：与 SkillPickerModal 同形态（portal 全屏 modal + 标签筛选）。
 * 列表项点击仅切换选中态；底部「确定」或双击才回写父组件。
 */
export function AgentPickerModal({
  open,
  onClose,
  agents,
  loading,
  selected,
  onConfirm,
}: {
  open: boolean
  onClose: () => void
  agents: AgentPickerRow[]
  loading: boolean
  selected: string | null
  onConfirm: (agentCode: string) => void
}) {
  const [query, setQuery] = useState('')
  const [draft, setDraft] = useState<string>(selected || '')
  const [activeTag, setActiveTag] = useState<string | null>(null)
  const searchRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (!open) return
    queueMicrotask(() => {
      setDraft(selected || '')
      setQuery('')
      setActiveTag(null)
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
    const byTag = filterAgentsByTag(agents, activeTag)
    const q = query.trim().toLowerCase()
    if (!q) return byTag
    return byTag.filter((a) => {
      const code = String(a.agent_code || '').toLowerCase()
      const name = String(a.agent_name || '').toLowerCase()
      const desc = String(a.description || '').toLowerCase()
      const tagText = normalizeAgentTags(a.tags).join(' ').toLowerCase()
      return code.includes(q) || name.includes(q) || desc.includes(q) || tagText.includes(q)
    })
  }, [agents, activeTag, query])

  const draftLabel = useMemo(() => {
    if (!draft) return ''
    const row = agents.find(
      (a) => String(a.agent_code || '').trim().toLowerCase() === draft.toLowerCase(),
    )
    return String(row?.agent_name || draft).trim() || draft
  }, [agents, draft])

  const confirm = (code: string) => {
    const next = code.trim()
    if (!next) return
    onConfirm(next)
    onClose()
  }

  if (!open || typeof document === 'undefined') return null

  return createPortal(
    <div
      className="react-chat-modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="选择预设角色"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="react-chat-modal-card react-chat-skill-modal" onClick={(e) => e.stopPropagation()}>
        <div className="react-chat-modal-header">
          <div className="react-chat-skill-modal-header-main">
            <span className="react-chat-modal-title">选择预设角色</span>
            <span className="react-chat-skill-modal-sub">单选 · 切换后立即作用于当前会话</span>
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
              aria-label="搜索智能体"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
            />
          </div>

          {tagEntries.length > 0 ? (
            <div className="react-chat-skill-tag-bar">
              <span
                className={`react-chat-skill-tag-chip${!activeTag ? ' active' : ''}`}
                onClick={() => setActiveTag(null)}
              >
                全部
              </span>
              {tagEntries.map((t) => (
                <span
                  key={t.key}
                  className={`react-chat-skill-tag-chip${activeTag === t.label ? ' active' : ''}`}
                  style={{ ['--tag-color' as string]: t.color || '#64748b' } as CSSProperties}
                  onClick={() => setActiveTag((prev) => (prev === t.label ? null : t.label))}
                >
                  {t.icon ? `${t.icon} ` : ''}
                  {t.label}
                </span>
              ))}
            </div>
          ) : null}

          {draft ? (
            <div className="react-chat-skill-modal-selected">
              <span className="react-chat-skill-modal-chip">
                <span className="react-chat-skill-modal-chip-label">{draftLabel}</span>
                <button
                  type="button"
                  className="react-chat-skill-modal-chip-x"
                  aria-label="清除选择"
                  onClick={() => setDraft('')}
                >
                  ×
                </button>
              </span>
            </div>
          ) : null}

          <div className="react-chat-skill-modal-list react-chat-picker-card-grid">
            {loading ? (
              <div className="react-chat-bottom-dropdown-empty react-chat-picker-card-empty">加载中…</div>
            ) : agents.length === 0 ? (
              <div className="react-chat-bottom-dropdown-empty react-chat-picker-card-empty">
                暂无预设，请先到「角色管理」创建
              </div>
            ) : filtered.length === 0 ? (
              <div className="react-chat-bottom-dropdown-empty react-chat-picker-card-empty">无匹配角色</div>
            ) : (
              filtered.map((a) => {
                const code = String(a.agent_code || '').trim()
                if (!code) return null
                const label = String(a.agent_name || '').trim() || code
                const desc = String(a.description || '').trim()
                const active = draft.toLowerCase() === code.toLowerCase()
                const tags = normalizeAgentTags(a.tags)
                return (
                  <button
                    key={code}
                    type="button"
                    className={`react-chat-picker-card${active ? ' is-active' : ''}`}
                    onClick={() => setDraft(code)}
                    onDoubleClick={() => confirm(code)}
                  >
                    {active ? (
                      <span className="react-chat-picker-card-check" aria-hidden>
                        ✓
                      </span>
                    ) : null}
                    <span className="react-chat-picker-card-head">
                      <span className="react-chat-picker-card-avatar react-chat-picker-card-avatar--agent">
                        <AgentAvatar agent={a} agentCode={code} size={20} />
                      </span>
                      <span className="react-chat-picker-card-name">{label}</span>
                    </span>
                    {desc ? (
                      <span className="react-chat-picker-card-desc">{desc}</span>
                    ) : (
                      <span className="react-chat-picker-card-desc is-muted">暂无描述</span>
                    )}
                    {tags.length > 0 ? (
                      <span className="react-chat-picker-card-tags">
                        {tags.slice(0, 3).map((tagLabel) => {
                          const m = tagMetaForLabel(tagLabel)
                          return (
                            <span
                              key={tagLabel}
                              className="react-chat-skill-item-tag"
                              style={
                                {
                                  ['--tag-color' as string]: m.color || '#64748b',
                                } as CSSProperties
                              }
                            >
                              {m.icon ? `${m.icon} ` : ''}
                              {tagLabel}
                            </span>
                          )
                        })}
                      </span>
                    ) : null}
                  </button>
                )
              })
            )}
          </div>
        </div>

        <div className="react-chat-modal-actions react-chat-skill-modal-actions">
          <span className="react-chat-skill-modal-footer-count">
            {draft ? `已选：${draftLabel}` : '未选择'}
          </span>
          <button type="button" className="react-chat-modal-btn react-chat-modal-btn--ghost" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="react-chat-modal-btn react-chat-modal-btn--primary"
            disabled={!draft}
            onClick={() => confirm(draft)}
          >
            确定
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
