import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import type { MentionType } from '../lib/workspace-mention.js'
import { resolvePluginIconSource } from '../../zcode-ui/lib/pluginIconSource.js'

export type MentionFileOption = {
  path: string
  name: string
  detail?: string
}

export type MentionEmployeeOption = {
  agent_code: string
  /** 岗位名（雇佣合同上的职位） */
  role_name: string
  /** 智能体显示名；侧栏/点名优先用这个 */
  agent_name?: string
  department?: string
  status?: string
}

/** Internal discriminator used to route skill/plugin items through MentionOption. */
export type MentionSkillOption = {
  __kind: 'skill'
  name: string
  label: string
  icon: string
  description?: string
}

export type MentionPluginOption = {
  __kind: 'plugin'
  id: string
  label: string
  iconUrl?: string
  description?: string
}

export type MentionCommandOption = {
  __kind: 'command'
  name: string
  label: string
  description?: string
}

export type MentionOption =
  | MentionFileOption
  | MentionEmployeeOption
  | MentionSkillOption
  | MentionPluginOption
  | MentionCommandOption

export function isEmployeeOption(item: MentionOption): item is MentionEmployeeOption {
  return 'agent_code' in item
}

export function isSkillOption(item: MentionOption): item is MentionSkillOption {
  return '__kind' in item && (item as MentionSkillOption).__kind === 'skill'
}

export function isPluginOption(item: MentionOption): item is MentionPluginOption {
  return '__kind' in item && (item as MentionPluginOption).__kind === 'plugin'
}

export function isCommandOption(item: MentionOption): item is MentionCommandOption {
  return '__kind' in item && (item as MentionCommandOption).__kind === 'command'
}

type Props = {
  open: boolean
  loading: boolean
  query: string
  type: MentionType | null
  items: MentionOption[]
  activeIndex: number
  onPick: (item: MentionOption) => void
  onActiveIndexChange: (index: number) => void
  /** Composer shell used to pin the floating panel above the input. */
  anchorRef?: RefObject<HTMLElement | null>
}

type PortalBox = {
  left: number
  width: number
  bottom: number
}

export function WorkspaceMentionMenu({
  open,
  loading,
  query,
  type,
  items,
  activeIndex,
  onPick,
  onActiveIndexChange,
  anchorRef,
}: Props) {
  const listRef = useRef<HTMLUListElement | null>(null)
  const [box, setBox] = useState<PortalBox | null>(null)

  useLayoutEffect(() => {
    if (!open) {
      setBox(null)
      return
    }
    const update = () => {
      const el = anchorRef?.current
      if (!el) {
        setBox(null)
        return
      }
      const r = el.getBoundingClientRect()
      setBox({
        left: r.left,
        width: r.width,
        // Pin above the composer shell; grow upward over the message list.
        bottom: Math.max(8, window.innerHeight - r.top + 6),
      })
    }
    update()
    window.addEventListener('resize', update)
    // Capture scroll from nested message scroller / layout.
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [open, anchorRef, items.length, loading, type])

  useEffect(() => {
    if (!open || !listRef.current) return
    const el = listRef.current.querySelector(`[data-idx="${activeIndex}"]`)
    if (el && 'scrollIntoView' in el) {
      el.scrollIntoView({ block: 'nearest' })
    }
  }, [activeIndex, open])

  if (!open || typeof document === 'undefined') return null

  const isSkill = type === 'skill'
  const isEmployee = type === 'employee'
  const headLabel = isSkill ? '斜杠命令' : isEmployee ? 'BOT' : '工作区文件'

  const renderOption = (item: MentionOption, i: number) => {
    if (isEmployeeOption(item)) {
      const dept = item.department ? ` · ${item.department}` : ''
      return (
        <li key={item.agent_code}>
          <button
            type="button"
            role="option"
            data-idx={i}
            aria-selected={i === activeIndex}
            className={`react-chat-mention-menu-item react-chat-mention-menu-item--employee${i === activeIndex ? ' is-active' : ''}`}
            onMouseEnter={() => onActiveIndexChange(i)}
            onMouseDown={(e) => {
              e.preventDefault()
              onPick(item)
            }}
          >
            <span className="react-chat-mention-menu-name">{'@' + (item.agent_name || item.role_name)}</span>
            <span className="react-chat-mention-menu-path">{item.agent_code}{dept}</span>
          </button>
        </li>
      )
    }
    if (isCommandOption(item)) {
      return (
        <li key={`cmd:${item.name}`}>
          <button
            type="button"
            role="option"
            data-idx={i}
            aria-selected={i === activeIndex}
            className={`react-chat-mention-menu-item react-chat-mention-menu-item--row${i === activeIndex ? ' is-active' : ''}`}
            onMouseEnter={() => onActiveIndexChange(i)}
            onMouseDown={(e) => {
              e.preventDefault()
              onPick(item)
            }}
          >
            <span className="react-chat-mention-menu-name">{item.label}</span>
            <span className="react-chat-mention-menu-path">命令</span>
            {item.description ? <span className="react-chat-mention-menu-desc">{item.description}</span> : null}
          </button>
        </li>
      )
    }
    if (isSkillOption(item)) {
      return (
        <li key={item.name}>
          <button
            type="button"
            role="option"
            data-idx={i}
            aria-selected={i === activeIndex}
            className={`react-chat-mention-menu-item react-chat-mention-menu-item--row react-chat-mention-menu-item--stacked${i === activeIndex ? ' is-active' : ''}`}
            onMouseEnter={() => onActiveIndexChange(i)}
            onMouseDown={(e) => {
              e.preventDefault()
              onPick(item)
            }}
          >
            <span className="react-chat-mention-menu-icon" aria-hidden>
              {item.icon || '⚡'}
            </span>
            <span className="react-chat-mention-menu-main">
              <span className="react-chat-mention-menu-title">
                <span className="react-chat-mention-menu-name">{item.label || item.name}</span>
                <span className="react-chat-mention-menu-path">技能</span>
              </span>
              {item.description ? <span className="react-chat-mention-menu-desc">{item.description}</span> : null}
            </span>
          </button>
        </li>
      )
    }
    if (isPluginOption(item)) {
      const iconSrc = resolvePluginIconSource(item.id, item.iconUrl)
      return (
        <li key={item.id}>
          <button
            type="button"
            role="option"
            data-idx={i}
            aria-selected={i === activeIndex}
            className={`react-chat-mention-menu-item react-chat-mention-menu-item--row react-chat-mention-menu-item--stacked${i === activeIndex ? ' is-active' : ''}`}
            onMouseEnter={() => onActiveIndexChange(i)}
            onMouseDown={(e) => {
              e.preventDefault()
              onPick(item)
            }}
          >
            <span className="react-chat-mention-menu-icon" aria-hidden>
              {iconSrc ? (
                <img src={iconSrc} alt="" className="react-chat-mention-menu-icon-img" />
              ) : (
                '🧩'
              )}
            </span>
            <span className="react-chat-mention-menu-main">
              <span className="react-chat-mention-menu-title">
                <span className="react-chat-mention-menu-name">{item.label}</span>
                <span className="react-chat-mention-menu-path">插件</span>
              </span>
              {item.description ? <span className="react-chat-mention-menu-desc">{item.description}</span> : null}
            </span>
          </button>
        </li>
      )
    }
    return (
      <li key={item.path}>
        <button
          type="button"
          role="option"
          data-idx={i}
          aria-selected={i === activeIndex}
          className={`react-chat-mention-menu-item${i === activeIndex ? ' is-active' : ''}`}
          onMouseEnter={() => onActiveIndexChange(i)}
          onMouseDown={(e) => {
            e.preventDefault()
            onPick(item)
          }}
        >
          <span className="react-chat-mention-menu-name">{'#' + item.name}</span>
          <span className="react-chat-mention-menu-path">{item.path}</span>
          {item.detail ? <span className="react-chat-mention-menu-detail">{item.detail}</span> : null}
        </button>
      </li>
    )
  }

  const slashGroups = isSkill
    ? [
        { id: 'commands', title: '命令', rows: items.map((item, i) => ({ item, i })).filter((row) => isCommandOption(row.item)) },
        { id: 'skills', title: '技能', rows: items.map((item, i) => ({ item, i })).filter((row) => isSkillOption(row.item)) },
        { id: 'plugins', title: '插件', rows: items.map((item, i) => ({ item, i })).filter((row) => isPluginOption(row.item)) },
      ].filter((group) => (query ? group.rows.length > 0 : true))
    : []

  const panel = (
    <div
      className="react-chat-mention-menu react-chat-mention-menu--portal"
      role="listbox"
      aria-label={headLabel}
      style={
        box
          ? {
              left: box.left,
              width: box.width,
              bottom: box.bottom,
            }
          : { visibility: 'hidden' as const }
      }
    >
      <div className="react-chat-mention-menu-head">
        {loading
          ? '搜索中…'
          : isSkill
            ? query
              ? `匹配「${query}」`
              : '命令、技能与插件'
            : query
              ? `匹配「${query}」`
              : isEmployee
                ? '输入岗位名过滤'
                : '输入文件名过滤'}
      </div>
      {items.length === 0 && !loading ? (
        <div className="react-chat-mention-menu-empty">
          {query
            ? isSkill
              ? '无匹配'
              : isEmployee
                ? '无匹配 BOT'
                : '无匹配文件'
            : isEmployee
              ? '继续输入以搜索 BOT'
              : '继续输入以搜索工作区文件'}
        </div>
      ) : isSkill ? (
        <ul ref={listRef} className="react-chat-mention-menu-list">
          {slashGroups.map((group) => (
            <li key={group.id} className="react-chat-mention-menu-section">
              <div className="react-chat-mention-menu-section-title">{group.title}</div>
              {group.rows.length === 0 ? (
                <div className="react-chat-mention-menu-empty">无可用{group.title}</div>
              ) : (
                <ul className="react-chat-mention-menu-section-list">
                  {group.rows.map((row) => renderOption(row.item, row.i))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <ul ref={listRef} className="react-chat-mention-menu-list">
          {items.map((item, i) => renderOption(item, i))}
        </ul>
      )}
    </div>
  )

  return createPortal(panel, document.body)
}
