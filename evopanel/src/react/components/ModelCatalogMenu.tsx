import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type Ref,
} from 'react'
import { createPortal } from 'react-dom'
import {
  groupModelCatalogByVendor,
  modelDisplayLabel,
  type ModelCatalogEntry,
} from '../lib/model-catalog.js'

export type ModelCatalogMenuProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  catalog: ModelCatalogEntry[]
  connNameMap?: Record<string, string>
  selectedModel: string
  pillLabel: string
  loading?: boolean
  disabled?: boolean
  /** 选择模型（仅 name）；关闭菜单由组件内部处理 */
  onSelect: (modelName: string) => void
  /** 打开前钩子（例如互斥关闭其它菜单） */
  onBeforeOpen?: () => void
  /** 暴露根节点，供外层统一处理点击外部关闭 */
  rootRef?: Ref<HTMLDivElement | null>
  /** 是否自行处理点击外部 / Esc 关闭；外层已管时设 false */
  manageDismiss?: boolean
  /** 上拉（会话底栏）或下拉（首页靠顶输入区） */
  placement?: 'up' | 'down'
  /**
   * 挂到 body + fixed，避开父级 overflow 裁切（输入区上拉后桌面/手机均需要）。
   * 外层点外部关闭请同时识别 `.react-chat-bottom-dropdown--model-portal`。
   */
  portalFixed?: boolean
  /**
   * portal 下改为纵向堆叠厂商+模型（窄屏触控）。
   * false 时保留桌面右侧级联，并对 flyout 使用 fixed 定位以免被裁切。
   */
  portalStack?: boolean
  className?: string
  /** 触发按钮额外 class（如首页 chip） */
  triggerClassName?: string
}

export function ModelCatalogMenu({
  open,
  onOpenChange,
  catalog,
  connNameMap,
  selectedModel,
  pillLabel,
  loading = false,
  disabled = false,
  onSelect,
  onBeforeOpen,
  rootRef,
  manageDismiss = true,
  placement = 'up',
  portalFixed = false,
  portalStack = false,
  className = '',
  triggerClassName = '',
}: ModelCatalogMenuProps) {
  const [vendorHover, setVendorHover] = useState<string | null>(null)
  const [flyoutSide, setFlyoutSide] = useState<'right' | 'left'>('right')
  const [portalStyle, setPortalStyle] = useState<CSSProperties | null>(null)
  const [flyoutStyle, setFlyoutStyle] = useState<CSSProperties | null>(null)
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const localRootRef = useRef<HTMLDivElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const flyoutRef = useRef<HTMLDivElement | null>(null)
  const vendorItemRefs = useRef<Map<string, HTMLDivElement>>(new Map())

  const setRootNode = (node: HTMLDivElement | null) => {
    localRootRef.current = node
    if (typeof rootRef === 'function') rootRef(node)
    else if (rootRef && typeof rootRef === 'object') {
      ;(rootRef as { current: HTMLDivElement | null }).current = node
    }
  }

  const cascadePortal = portalFixed && !portalStack

  useEffect(() => {
    if (!open) {
      setVendorHover(null)
      setFlyoutSide('right')
      setFlyoutStyle(null)
      if (hoverTimerRef.current) {
        clearTimeout(hoverTimerRef.current)
        hoverTimerRef.current = null
      }
    }
  }, [open])

  useLayoutEffect(() => {
    if (!vendorHover || typeof window === 'undefined') {
      setFlyoutSide('right')
      setFlyoutStyle(null)
      return
    }

    // 手机堆叠：flyout 在文档流内，无需 fixed
    if (portalStack) {
      setFlyoutSide('right')
      setFlyoutStyle(null)
      return
    }

    const vendorEl = vendorItemRefs.current.get(vendorHover)
    const flyout = flyoutRef.current
    if (!vendorEl || !flyout) return

    // 桌面 portal：fixed 贴厂商行底边向上展开（与旧 absolute bottom:0 一致），
    // 勿改成「贴顶向下」——会把列表甩到视口很上方，看起来不在厂商旁边。
    if (cascadePortal) {
      const row = vendorEl.getBoundingClientRect()
      const pad = 10
      const gap = 4
      const estimatedW = Math.min(340, Math.max(200, flyout.offsetWidth || 240))
      let side: 'right' | 'left' = 'right'
      let left = row.right + gap
      if (left + estimatedW > window.innerWidth - pad) {
        side = 'left'
        left = Math.max(pad, row.left - gap - estimatedW)
      }

      const spaceAbove = Math.max(0, row.bottom - pad)
      const spaceBelow = Math.max(0, window.innerHeight - row.top - pad)
      // 默认底对齐向上；上方实在不够再改为顶对齐向下
      const flipDown = spaceAbove < 140 && spaceBelow > spaceAbove
      if (flipDown) {
        const maxH = Math.max(120, Math.min(320, spaceBelow))
        setFlyoutSide(side)
        setFlyoutStyle({
          position: 'fixed',
          left,
          top: row.top,
          bottom: 'auto',
          right: 'auto',
          maxHeight: maxH,
          zIndex: 10061,
        })
      } else {
        const maxH = Math.max(120, Math.min(320, spaceAbove))
        setFlyoutSide(side)
        setFlyoutStyle({
          position: 'fixed',
          left,
          top: 'auto',
          bottom: Math.max(pad, window.innerHeight - row.bottom),
          right: 'auto',
          maxHeight: maxH,
          zIndex: 10061,
        })
      }
      return
    }

    // 非 portal：absolute 级联，贴边时改向左
    setFlyoutStyle(null)
    flyout.classList.remove('is-left')
    vendorEl.classList.remove('is-flyout-left')
    const rect = flyout.getBoundingClientRect()
    const overflowRight = rect.right > window.innerWidth - 10
    if (overflowRight) {
      setFlyoutSide('left')
      flyout.classList.add('is-left')
      vendorEl.classList.add('is-flyout-left')
    } else {
      setFlyoutSide('right')
    }
  }, [vendorHover, portalStack, cascadePortal, catalog, connNameMap])

  useEffect(() => {
    return () => {
      if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current)
    }
  }, [])

  useLayoutEffect(() => {
    if (!open || !portalFixed || typeof window === 'undefined') {
      setPortalStyle(null)
      return
    }
    const update = () => {
      const btn = triggerRef.current
      if (!btn) return
      const r = btn.getBoundingClientRect()
      const gap = 10
      const sidePad = 10
      if (portalStack) {
        const maxW = Math.min(window.innerWidth - sidePad * 2, 340)
        const left = Math.max(sidePad, Math.min(r.left, window.innerWidth - sidePad - maxW))
        if (placement === 'down') {
          const top = r.bottom + gap
          const maxH = Math.max(120, Math.min(window.innerHeight * 0.55, window.innerHeight - top - sidePad))
          setPortalStyle({
            position: 'fixed',
            left,
            top,
            bottom: 'auto',
            width: maxW,
            maxWidth: maxW,
            maxHeight: maxH,
            zIndex: 10060,
          })
          return
        }
        const bottom = Math.max(sidePad, window.innerHeight - r.top + gap)
        const maxH = Math.max(120, Math.min(window.innerHeight * 0.55, r.top - gap - sidePad))
        setPortalStyle({
          position: 'fixed',
          left,
          bottom,
          top: 'auto',
          width: maxW,
          maxWidth: maxW,
          maxHeight: maxH,
          zIndex: 10060,
        })
        return
      }

      // 桌面级联：只固定厂商列，右侧模型 flyout 另用 fixed
      const vendorMaxW = 220
      const left = Math.max(sidePad, Math.min(r.left, window.innerWidth - sidePad - vendorMaxW))
      if (placement === 'down') {
        const top = r.bottom + gap
        const maxH = Math.max(120, Math.min(window.innerHeight * 0.55, window.innerHeight - top - sidePad))
        setPortalStyle({
          position: 'fixed',
          left,
          top,
          bottom: 'auto',
          maxWidth: vendorMaxW,
          maxHeight: maxH,
          zIndex: 10060,
        })
        return
      }
      const bottom = Math.max(sidePad, window.innerHeight - r.top + gap)
      const maxH = Math.max(120, Math.min(window.innerHeight * 0.55, r.top - gap - sidePad))
      setPortalStyle({
        position: 'fixed',
        left,
        bottom,
        top: 'auto',
        maxWidth: vendorMaxW,
        maxHeight: maxH,
        zIndex: 10060,
      })
    }
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [open, portalFixed, portalStack, placement, pillLabel])

  useEffect(() => {
    if (!open || !manageDismiss) return
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node
      if (localRootRef.current?.contains(t)) return
      if (menuRef.current?.contains(t)) return
      if (flyoutRef.current?.contains(t)) return
      onOpenChange(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onOpenChange(false)
    }
    document.addEventListener('mousedown', onDoc)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      window.removeEventListener('keydown', onKey)
    }
  }, [open, manageDismiss, onOpenChange])

  const modelDisabled = disabled || (loading && !catalog.length)

  const menuBody =
    open && !modelDisabled ? (
      <div
        ref={menuRef}
        className={`react-chat-bottom-dropdown react-chat-bottom-dropdown--model${
          portalFixed ? ' react-chat-bottom-dropdown--model-portal' : ''
        }${portalStack ? ' is-portal-stack' : ''}${cascadePortal ? ' is-portal-cascade' : ''}`}
        role="menu"
        style={portalFixed ? portalStyle || { display: 'none' } : undefined}
      >
        {catalog.length > 0 ? (
          groupModelCatalogByVendor(catalog, connNameMap).map((group) => (
            <div
              key={group.vendor}
              ref={(node) => {
                if (node) vendorItemRefs.current.set(group.vendor, node)
                else vendorItemRefs.current.delete(group.vendor)
              }}
              className={`react-chat-model-vendor-item${
                vendorHover === group.vendor && flyoutSide === 'left' ? ' is-flyout-left' : ''
              }`}
              onMouseEnter={() => {
                if (hoverTimerRef.current) {
                  clearTimeout(hoverTimerRef.current)
                  hoverTimerRef.current = null
                }
                setVendorHover(group.vendor)
              }}
              onMouseLeave={() => {
                // 堆叠触控：靠点击切换，不因 leave 收起
                if (portalStack) return
                if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current)
                hoverTimerRef.current = setTimeout(() => {
                  setVendorHover(null)
                  hoverTimerRef.current = null
                }, 180)
              }}
            >
              <button
                type="button"
                className={`react-chat-model-vendor-header${
                  vendorHover === group.vendor ? ' react-chat-model-vendor-header--hover' : ''
                }${
                  group.rows.some((r) => r.name === selectedModel)
                    ? ' react-chat-model-vendor-header--active'
                    : ''
                }`}
                title={group.label}
                onClick={(e) => {
                  // 触控无 hover：点厂商展开/收起子菜单
                  e.preventDefault()
                  e.stopPropagation()
                  setVendorHover((prev) => (prev === group.vendor ? null : group.vendor))
                }}
              >
                <span className="react-chat-model-vendor-label">{group.label}</span>
                <span className="react-chat-more-submenu-caret" aria-hidden>
                  ▸
                </span>
              </button>
              {vendorHover === group.vendor
                ? (() => {
                    const flyoutNode = (
                      <div
                        ref={flyoutRef}
                        className={`react-chat-more-submenu-flyout react-chat-more-submenu-flyout--scroll${
                          flyoutSide === 'left' ? ' is-left' : ''
                        }${cascadePortal ? ' is-portal-fixed react-chat-model-flyout-portal' : ''}`}
                        role="menu"
                        style={
                          cascadePortal
                            ? flyoutStyle || {
                                position: 'fixed',
                                left: 0,
                                top: 0,
                                visibility: 'hidden',
                                pointerEvents: 'none',
                              }
                            : undefined
                        }
                        onMouseEnter={() => {
                          if (hoverTimerRef.current) {
                            clearTimeout(hoverTimerRef.current)
                            hoverTimerRef.current = null
                          }
                          setVendorHover(group.vendor)
                        }}
                        onMouseLeave={() => {
                          if (portalStack) return
                          if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current)
                          hoverTimerRef.current = setTimeout(() => {
                            setVendorHover(null)
                            hoverTimerRef.current = null
                          }, 180)
                        }}
                      >
                        {group.rows.map((row) => {
                          const label = modelDisplayLabel(row)
                          const fullTitle =
                            row.availabilityStatus === 'unavailable'
                              ? row.unavailableReason || '模型当前不可用'
                              : row.name && label !== row.name
                                ? `${label}\n${row.name}`
                                : label || row.name
                          return (
                            <button
                              key={row.name}
                              type="button"
                              role="menuitem"
                              className={`react-chat-bottom-dropdown-item${
                                row.name === selectedModel ? ' is-active' : ''
                              }${
                                row.availabilityStatus === 'unavailable' ? ' is-unavailable' : ''
                              }`}
                              title={fullTitle}
                              onClick={() => {
                                onSelect(row.name)
                                onOpenChange(false)
                              }}
                            >
                              <span className="react-chat-model-item-label">{label}</span>
                              {row.availabilityStatus === 'unavailable' ? (
                                <span className="react-chat-model-item-badge">不可用</span>
                              ) : null}
                            </button>
                          )
                        })}
                      </div>
                    )
                    // 桌面级联：flyout 也挂到 body，避免厂商列滚动容器裁切
                    return cascadePortal && typeof document !== 'undefined'
                      ? createPortal(flyoutNode, document.body)
                      : flyoutNode
                  })()
                : null}
            </div>
          ))
        ) : (
          <div className="react-chat-bottom-dropdown-empty">
            {loading ? '加载模型中…' : '暂无可用模型'}
          </div>
        )}
      </div>
    ) : null

  return (
    <div
      className={`react-chat-bottom-pill-root${
        placement === 'down' ? ' react-chat-bottom-pill-root--down' : ''
      } ${className}`.trim()}
      ref={setRootNode}
    >
      <button
        ref={triggerRef}
        type="button"
        className={`react-chat-bottom-pill react-chat-bottom-model-pill${
          modelDisabled ? ' react-chat-bottom-pill--disabled' : ''
        }${open ? ' react-chat-bottom-pill--open' : ''}${triggerClassName ? ` ${triggerClassName}` : ''}`}
        title={modelDisabled ? undefined : pillLabel}
        disabled={modelDisabled}
        onClick={() => {
          const next = !open
          if (next) onBeforeOpen?.()
          onOpenChange(next)
        }}
      >
        <svg
          className="react-chat-bottom-pill-icon"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden="true"
        >
          <path d="M4 4h16v16H4z" />
          <path d="M9 9h6v6H9z" />
        </svg>
        <span className="react-chat-bottom-pill-text react-chat-bottom-pill-text--model">
          {pillLabel}
        </span>
        <span className="react-chat-bottom-pill-caret">▾</span>
      </button>
      {portalFixed && typeof document !== 'undefined' && menuBody
        ? createPortal(menuBody, document.body)
        : menuBody}
    </div>
  )
}

export default ModelCatalogMenu
