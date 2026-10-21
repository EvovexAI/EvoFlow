/**
 * 产品风格下拉选择：替代原生 `<select>` / 系统默认菜单。
 * 视觉对齐聊天底栏 `.react-chat-bottom-dropdown`（圆角面板 + 条目高亮），
 * 触发器提供 `field`（表单）与 `pill`（工具栏）两种样式。
 */
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'

export type DropdownSelectOption = {
  value: string
  label: string
  disabled?: boolean
  /** 次要说明，显示在主文案下方 */
  description?: string
}

export type DropdownSelectGroup = {
  label: string
  options: DropdownSelectOption[]
}

export type DropdownSelectProps = {
  value: string
  onChange: (value: string) => void
  options?: DropdownSelectOption[]
  groups?: DropdownSelectGroup[]
  placeholder?: string
  disabled?: boolean
  /** field：表单控件；pill：聊天底栏药丸 */
  variant?: 'field' | 'pill'
  /** 菜单相对触发器展开方向；默认按 variant 推断（field=down，pill=up） */
  placement?: 'up' | 'down'
  /** 挂到 body，避免父级 overflow 裁切 */
  portal?: boolean
  className?: string
  triggerClassName?: string
  menuClassName?: string
  /** 触发器左侧图标 / 自定义前缀 */
  leading?: ReactNode
  'aria-label'?: string
  title?: string
  /** 未匹配到选项时展示的文案；默认回退到 value 本身 */
  emptyLabel?: string
}

function flattenOptions(
  options: DropdownSelectOption[] | undefined,
  groups: DropdownSelectGroup[] | undefined,
): DropdownSelectOption[] {
  const flat: DropdownSelectOption[] = [...(options || [])]
  for (const g of groups || []) {
    for (const o of g.options) flat.push(o)
  }
  return flat
}

export function DropdownSelect({
  value,
  onChange,
  options,
  groups,
  placeholder = '请选择…',
  disabled = false,
  variant = 'field',
  placement,
  portal = false,
  className = '',
  triggerClassName = '',
  menuClassName = '',
  leading,
  'aria-label': ariaLabel,
  title,
  emptyLabel,
}: DropdownSelectProps) {
  const listId = useId()
  const rootRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const [open, setOpen] = useState(false)
  const [portalStyle, setPortalStyle] = useState<CSSProperties | null>(null)

  const resolvedPlacement = placement ?? (variant === 'pill' ? 'up' : 'down')
  const flat = useMemo(() => flattenOptions(options, groups), [options, groups])
  const selected = flat.find((o) => o.value === value)
  const triggerText = selected?.label || (value ? emptyLabel || value : placeholder)
  const showPlaceholder = !selected && !value

  const close = useCallback(() => setOpen(false), [])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        close()
        triggerRef.current?.focus()
      }
    }
    const onPointer = (e: MouseEvent | PointerEvent) => {
      const t = e.target as Node | null
      if (!t) return
      if (rootRef.current?.contains(t)) return
      if (menuRef.current?.contains(t)) return
      close()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onPointer, true)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onPointer, true)
    }
  }, [open, close])

  useLayoutEffect(() => {
    if (!open || !portal || typeof window === 'undefined') {
      setPortalStyle(null)
      return
    }
    const update = () => {
      const btn = triggerRef.current
      if (!btn) return
      const r = btn.getBoundingClientRect()
      const gap = 8
      const sidePad = 10
      const minW = Math.max(r.width, 160)
      const maxH = Math.min(320, window.innerHeight * 0.5)
      const left = Math.max(sidePad, Math.min(r.left, window.innerWidth - sidePad - minW))

      if (resolvedPlacement === 'up') {
        const bottom = Math.max(sidePad, window.innerHeight - r.top + gap)
        setPortalStyle({
          position: 'fixed',
          left,
          bottom,
          top: 'auto',
          minWidth: minW,
          maxHeight: Math.max(80, Math.min(maxH, r.top - gap - sidePad)),
          zIndex: 10060,
        })
      } else {
        const top = Math.min(window.innerHeight - sidePad - 80, r.bottom + gap)
        setPortalStyle({
          position: 'fixed',
          left,
          top,
          bottom: 'auto',
          minWidth: minW,
          maxHeight: Math.max(80, Math.min(maxH, window.innerHeight - top - sidePad)),
          zIndex: 10060,
        })
      }
    }
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [open, portal, resolvedPlacement, triggerText])

  const renderOption = (opt: DropdownSelectOption) => {
    const active = opt.value === value
    return (
      <button
        key={opt.value || '__empty__'}
        type="button"
        role="option"
        aria-selected={active}
        disabled={opt.disabled}
        className={`ef-dropdown-select__item${active ? ' ef-dropdown-select__item--active' : ''}`}
        onClick={() => {
          if (opt.disabled) return
          onChange(opt.value)
          close()
          triggerRef.current?.focus()
        }}
      >
        <span className="ef-dropdown-select__item-label">{opt.label}</span>
        {opt.description ? (
          <span className="ef-dropdown-select__item-desc">{opt.description}</span>
        ) : null}
      </button>
    )
  }

  const menuBody = open ? (
    <div
      ref={menuRef}
      id={listId}
      role="listbox"
      className={`ef-dropdown-select__menu ef-dropdown-select__menu--${resolvedPlacement}${
        portal ? ' ef-dropdown-select__menu--portal' : ''
      }${menuClassName ? ` ${menuClassName}` : ''}`}
      style={portal ? portalStyle || { display: 'none' } : undefined}
    >
      {options?.length ? options.map(renderOption) : null}
      {groups?.map((g) => (
        <div key={g.label} className="ef-dropdown-select__group" role="group" aria-label={g.label}>
          <div className="ef-dropdown-select__group-label">{g.label}</div>
          {g.options.map(renderOption)}
        </div>
      ))}
      {!flat.length ? <div className="ef-dropdown-select__empty">暂无选项</div> : null}
    </div>
  ) : null

  return (
    <div
      ref={rootRef}
      className={`ef-dropdown-select ef-dropdown-select--${variant}${
        open ? ' is-open' : ''
      }${disabled ? ' is-disabled' : ''}${className ? ` ${className}` : ''}`}
    >
      <button
        ref={triggerRef}
        type="button"
        className={`ef-dropdown-select__trigger ef-dropdown-select__trigger--${variant}${
          open ? ' is-open' : ''
        }${showPlaceholder ? ' is-placeholder' : ''}${triggerClassName ? ` ${triggerClassName}` : ''}`}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={ariaLabel}
        title={title}
        onClick={() => {
          if (disabled) return
          setOpen((v) => !v)
        }}
      >
        {leading ? <span className="ef-dropdown-select__leading">{leading}</span> : null}
        <span className="ef-dropdown-select__value">{triggerText}</span>
        <span className="ef-dropdown-select__caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {portal && typeof document !== 'undefined' && menuBody
        ? createPortal(menuBody, document.body)
        : menuBody}
    </div>
  )
}
