import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { getSkillTags, getSkillTagMeta, SKILL_TAGS } from '../../lib/skill-catalog.js'

export type SkillPickerItem = {
  name: string
  label: string
  description: string
  icon: string
  enabled?: boolean
}
export type SkillSelection = { name: string; label: string; icon: string }

/**
 * 技能多选弹窗：参考 GoalModePanel 的 createPortal 全屏 modal 形态。
 * 列表项点击仅切换选中态（不关闭弹窗）；底部「确定」才回写父组件。
 */
export function SkillPickerModal({
  open,
  onClose,
  skills,
  loading,
  selected,
  onConfirm,
}: {
  open: boolean
  onClose: () => void
  skills: SkillPickerItem[]
  loading: boolean
  selected: SkillSelection[]
  onConfirm: (next: SkillSelection[]) => void
}) {
  const [query, setQuery] = useState('')
  const [draft, setDraft] = useState<SkillSelection[]>(selected)
  const [activeTag, setActiveTag] = useState<string>('all')
  const searchRef = useRef<HTMLInputElement | null>(null)

  // 打开时同步 draft（仅 open 变化触发，避免用户编辑中被父状态覆盖）
  useEffect(() => {
    if (open) queueMicrotask(() => setDraft(selected))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // Esc 关闭
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  // 聚焦搜索框
  useEffect(() => {
    if (!open) return
    const t = window.setTimeout(() => searchRef.current?.focus(), 0)
    return () => window.clearTimeout(t)
  }, [open])

  // 收集当前列表中出现过的所有标签（去重，保留 SKILL_TAGS 原始顺序）
  const availableTags = useMemo(() => {
    const keys = new Set<string>()
    for (const s of skills) {
      for (const t of getSkillTags(s.name)) keys.add(t)
    }
    return SKILL_TAGS.filter((t) => keys.has(t.key))
  }, [skills])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return skills.filter((s) => {
      const matchText =
        !q ||
        String(s.name || '').toLowerCase().includes(q) ||
        String(s.label || '').toLowerCase().includes(q) ||
        String(s.description || '').toLowerCase().includes(q)
      const matchTag = activeTag === 'all' || getSkillTags(s.name).includes(activeTag)
      return matchText && matchTag
    })
  }, [skills, query, activeTag])

  if (!open || typeof document === 'undefined') return null

  const isSelected = (name: string) => draft.some((s) => s.name === name)
  const toggle = (s: SkillPickerItem) => {
    setDraft((prev) =>
      isSelected(s.name)
        ? prev.filter((x) => x.name !== s.name)
        : [...prev, { name: s.name, label: s.label || s.name, icon: s.icon || '🧩' }],
    )
  }
  const removeChip = (name: string) => {
    setDraft((prev) => prev.filter((x) => x.name !== name))
  }
  const clearAll = () => setDraft([])

  return createPortal(
    <div
      className="react-chat-modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="选择技能"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="react-chat-modal-card react-chat-skill-modal" onClick={(e) => e.stopPropagation()}>
        <div className="react-chat-modal-header">
          <div className="react-chat-skill-modal-header-main">
            <span className="react-chat-modal-title">选择技能</span>
            <span className="react-chat-skill-modal-sub">可多选 · 发送时优先使用所选技能</span>
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
              placeholder="搜索技能…"
              value={query}
              aria-label="搜索技能"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
            />
          </div>

          {availableTags.length > 0 ? (
            <div className="react-chat-skill-tag-bar">
              <span
                className={`react-chat-skill-tag-chip${activeTag === 'all' ? ' active' : ''}`}
                onClick={() => setActiveTag('all')}
              >
                全部
              </span>
              {availableTags.map((t) => (
                <span
                  key={t.key}
                  className={`react-chat-skill-tag-chip${activeTag === t.key ? ' active' : ''}`}
                  onClick={() => setActiveTag(t.key)}
                >
                  {t.icon} {t.label}
                </span>
              ))}
            </div>
          ) : null}

          {draft.length > 0 ? (
            <div className="react-chat-skill-modal-selected">
              {draft.map((s) => (
                <span key={s.name} className="react-chat-skill-modal-chip">
                  <span className="react-chat-skill-modal-chip-icon" aria-hidden>
                    {s.icon || '🧩'}
                  </span>
                  <span className="react-chat-skill-modal-chip-label">{s.label}</span>
                  <button
                    type="button"
                    className="react-chat-skill-modal-chip-x"
                    aria-label={`移除 ${s.label}`}
                    onClick={() => removeChip(s.name)}
                  >
                    ×
                  </button>
                </span>
              ))}
              <button type="button" className="react-chat-skill-modal-clear" onClick={clearAll}>
                清空
              </button>
            </div>
          ) : null}

          <div className="react-chat-skill-modal-list react-chat-picker-card-grid">
            {loading ? (
              <div className="react-chat-bottom-dropdown-empty react-chat-picker-card-empty">加载中…</div>
            ) : skills.length === 0 ? (
              <div className="react-chat-bottom-dropdown-empty react-chat-picker-card-empty">暂无可用技能</div>
            ) : filtered.length === 0 ? (
              <div className="react-chat-bottom-dropdown-empty react-chat-picker-card-empty">无匹配技能</div>
            ) : (
              filtered.map((s) => {
                const active = isSelected(s.name)
                const itemTags = getSkillTags(s.name)
                return (
                  <button
                    key={s.name}
                    type="button"
                    className={`react-chat-picker-card${active ? ' is-active' : ''}`}
                    onClick={() => toggle(s)}
                  >
                    {active ? (
                      <span className="react-chat-picker-card-check" aria-hidden>
                        ✓
                      </span>
                    ) : null}
                    <span className="react-chat-picker-card-head">
                      <span className="react-chat-picker-card-avatar" aria-hidden>
                        {s.icon || '🧩'}
                      </span>
                      <span className="react-chat-picker-card-name">{s.label || s.name}</span>
                    </span>
                    {s.description ? (
                      <span className="react-chat-picker-card-desc">{s.description}</span>
                    ) : (
                      <span className="react-chat-picker-card-desc is-muted">暂无描述</span>
                    )}
                    {itemTags.length ? (
                      <span className="react-chat-picker-card-tags">
                        {itemTags.map((tk) => {
                          const m = getSkillTagMeta(tk)
                          return (
                            <span
                              key={tk}
                              className="react-chat-skill-item-tag"
                              style={m ? ({ ['--tag-color' as string]: m.color } as CSSProperties) : undefined}
                            >
                              {m?.icon || ''} {m?.label || tk}
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
            {draft.length > 0 ? `已选 ${draft.length} 个技能` : '未选择'}
          </span>
          <button type="button" className="react-chat-modal-btn react-chat-modal-btn--ghost" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="react-chat-modal-btn react-chat-modal-btn--primary"
            onClick={() => {
              onConfirm(draft)
              onClose()
            }}
          >
            确定{draft.length > 0 ? `（${draft.length}）` : ''}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
