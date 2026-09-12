import { useState, useRef, useEffect, useLayoutEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'

export interface SelectOption {
  value: string
  label: string
}

interface CustomSelectProps {
  value: string
  onChange: (value: string) => void
  options: SelectOption[]
  /** 左侧标签文字（如"时间范围"） */
  label?: string
  /** 自定义选中值显示内容（替代默认的 <strong>） */
  children?: React.ReactNode
  /** 附加类名 */
  className?: string
  /** 下拉菜单对齐方式 */
  placement?: 'bottom-start' | 'bottom-end'
}

function obsPortalTarget(): HTMLElement {
  return document.getElementById('obs-fullscreen-root') ?? document.body
}

function dropdownFixedStyle(
  rect: DOMRect,
  placement: 'bottom-start' | 'bottom-end',
): React.CSSProperties {
  const style: React.CSSProperties = {
    position: 'fixed',
    top: rect.bottom + 6,
    minWidth: rect.width,
    zIndex: 10000,
  }
  if (placement === 'bottom-end') {
    style.right = window.innerWidth - rect.right
    style.left = 'auto'
  } else {
    style.left = rect.left
  }
  return style
}

export function CustomSelect({
  value,
  onChange,
  options,
  label,
  children,
  className = '',
  placement = 'bottom-start',
}: CustomSelectProps) {
  const [open, setOpen] = useState(false)
  const [menuStyle, setMenuStyle] = useState<React.CSSProperties | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLUListElement>(null)

  const syncMenuPosition = useCallback(() => {
    if (!ref.current) return
    setMenuStyle(dropdownFixedStyle(ref.current.getBoundingClientRect(), placement))
  }, [placement])

  useLayoutEffect(() => {
    console.log('[CustomSelect] open changed:', open, 'ref.current:', !!ref.current)
    if (!open) {
      queueMicrotask(() => setMenuStyle(null))
      return
    }
    syncMenuPosition()
    const onReposition = () => syncMenuPosition()
    window.addEventListener('resize', onReposition)
    window.addEventListener('scroll', onReposition, true)
    return () => {
      window.removeEventListener('resize', onReposition)
      window.removeEventListener('scroll', onReposition, true)
    }
  }, [open, syncMenuPosition])

  // 点击外部关闭
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      const target = e.target as Node
      if (ref.current?.contains(target) || menuRef.current?.contains(target)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  // Escape 关闭
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [open])

  const handleSelect = useCallback(
    (optValue: string) => {
      onChange(optValue)
      setOpen(false)
    },
    [onChange],
  )

  const selected = options.find((o) => o.value === value)

  return (
    <>
      <div
        ref={ref}
        className={`custom-select ${className} ${open ? 'custom-select-open' : ''}`}
      >
        <button
          type="button"
          className="custom-select-trigger"
          onClick={() => setOpen((v) => !v)}
          aria-haspopup="listbox"
          aria-expanded={open}
        >
          {label && <span className="custom-select-label">{label}</span>}
          {children || <strong>{selected?.label || value}</strong>}
          <i className="custom-select-arrow">⌄</i>
        </button>
      </div>
      {open && menuStyle
        ? createPortal(
            <ul
              ref={menuRef}
              className={`custom-select-dropdown placement-${placement}`}
              role="listbox"
              style={menuStyle}
            >
              {options.map((opt) => (
                <li
                  key={opt.value}
                  role="option"
                  aria-selected={value === opt.value}
                  className={`custom-select-option ${opt.value === value ? 'selected' : ''}`}
                  onMouseDown={(e) => {
                    e.preventDefault()
                    handleSelect(opt.value)
                  }}
                >
                  {opt.label}
                </li>
              ))}
            </ul>,
            obsPortalTarget(),
          )
        : null}
    </>
  )
}
