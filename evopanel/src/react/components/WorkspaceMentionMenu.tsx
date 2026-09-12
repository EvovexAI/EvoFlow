import { useEffect, useRef } from 'react'

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

export type MentionOption = MentionFileOption | MentionEmployeeOption

export function isEmployeeOption(item: MentionOption): item is MentionEmployeeOption {
  return 'agent_code' in item
}

type Props = {
  open: boolean
  loading: boolean
  query: string
  type: 'file' | 'employee' | null
  items: MentionOption[]
  activeIndex: number
  onPick: (item: MentionOption) => void
  onActiveIndexChange: (index: number) => void
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
}: Props) {
  const listRef = useRef<HTMLUListElement | null>(null)

  useEffect(() => {
    if (!open || !listRef.current) return
    const el = listRef.current.querySelector(`[data-idx="${activeIndex}"]`)
    if (el && 'scrollIntoView' in el) {
      el.scrollIntoView({ block: 'nearest' })
    }
  }, [activeIndex, open])

  if (!open) return null

  const isEmployee = type === 'employee'
  const headLabel = isEmployee ? '智能体员工' : '工作区文件'

  return (
    <div className="react-chat-mention-menu" role="listbox" aria-label={headLabel}>
      <div className="react-chat-mention-menu-head">
        {loading ? '搜索中…' : query ? `匹配「${query}」` : isEmployee ? '输入岗位名过滤' : '输入文件名过滤'}
      </div>
      {items.length === 0 && !loading ? (
        <div className="react-chat-mention-menu-empty">
          {query
            ? isEmployee
              ? '无匹配员工'
              : '无匹配文件'
            : isEmployee
              ? '继续输入以搜索员工'
              : '继续输入以搜索工作区文件'}
        </div>
      ) : (
        <ul ref={listRef} className="react-chat-mention-menu-list">
          {items.map((item, i) => {
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
          })}
        </ul>
      )}
    </div>
  )
}
