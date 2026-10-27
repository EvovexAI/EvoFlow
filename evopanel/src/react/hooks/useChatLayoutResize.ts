/**
 * Chat main-body / right-panel / bottom-dock layout resize + mobile pane classes.
 * Extracted from ChatApp.tsx (P7).
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { useDragResize } from './useDragResize.js'
import { normalizeRightStageKind } from '../../lib/right-stage/right-stage-types.js'
import {
  clampBottomDockHeight,
  clampRightPanelWidth,
  defaultNarrowRightPanelWidth,
  RIGHT_PANEL_NARROW_LEGACY_PX,
  defaultRightPanelWidth,
  defaultWideRightPanelWidth,
  loadChatLayoutPrefs,
  applyBottomAreaHeightDelta,
  measureBottomAreaNaturalHeight,
  saveChatLayoutPrefs,
} from '../../lib/chat-layout-storage.js'
import { notifyLayoutChromeChanged } from '../../lib/layout-chrome.js'

export function useChatLayoutResize(opts: {
  anyRightPanelOpen: boolean
  rightStageTabs: Array<{ kind?: string }>
  selectedSessionKey: string
}) {
  const { anyRightPanelOpen, rightStageTabs, selectedSessionKey } = opts

  const mainBodyRef = useRef<HTMLDivElement>(null)
  const conversationColRef = useRef<HTMLDivElement>(null)
  const bottomAreaRef = useRef<HTMLDivElement>(null)
  const bottomAreaNaturalHeightRef = useRef(160)
  const bottomAreaLiveHeightRef = useRef<number | null>(null)
  const layoutSizesRef = useRef({
    rightPanelWidthPx: loadChatLayoutPrefs().rightPanelWidthPx,
    bottomDockHeightPx: loadChatLayoutPrefs().bottomDockHeightPx,
  })
  const [layoutResizeEnabled, setLayoutResizeEnabled] = useState(
    () => typeof window === 'undefined' || !window.matchMedia('(max-width: 768px)').matches,
  )
  /** 窄屏微信式：list=会话列表全屏，thread=对话内容（桌面忽略） */
  const [isMobileChat, setIsMobileChat] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches,
  )
  const [mobileChatPane, setMobileChatPane] = useState<'list' | 'thread'>(() =>
    typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches ? 'list' : 'thread',
  )
  const [rightPanelWidthPx, setRightPanelWidthPx] = useState<number | null>(
    () => loadChatLayoutPrefs().rightPanelWidthPx,
  )
  const [bottomDockHeightPx, setBottomDockHeightPx] = useState<number | null>(
    () => loadChatLayoutPrefs().bottomDockHeightPx,
  )

  useLayoutEffect(() => {
    const stored = layoutSizesRef.current.bottomDockHeightPx
    if (stored == null) return
    const colH = conversationColRef.current?.clientHeight || 0
    if (!colH) return
    // 历史过大高度：钳制到主列可容纳范围，避免盖住消息区
    const clamped = clampBottomDockHeight(stored, window.innerHeight, colH)
    if (clamped !== stored) {
      setBottomDockHeightPx(clamped)
      layoutSizesRef.current.bottomDockHeightPx = clamped
      saveChatLayoutPrefs(layoutSizesRef.current)
    }
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const mq = window.matchMedia('(max-width: 768px)')
    const onChange = () => {
      const mobile = mq.matches
      setLayoutResizeEnabled(!mobile)
      setIsMobileChat(mobile)
      if (!mobile) setMobileChatPane('thread')
      else setMobileChatPane((prev) => prev || 'list')
    }
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const app = document.getElementById('app')
    const aside = document.getElementById('app-shell-aside')
    const apply = () => {
      const path = (window.location.hash.slice(1) || '/chat').split('?')[0]
      const chat = path === '/chat' || path === '/chat-react'
      const list = isMobileChat && mobileChatPane === 'list' && chat
      const thread = isMobileChat && mobileChatPane === 'thread' && chat
      app?.classList.toggle('evopanel-mobile-chat-list', list)
      app?.classList.toggle('evopanel-mobile-chat-thread', thread)
      if (list) {
        aside?.classList.add('shell-aside-open')
        document.getElementById('shell-aside-overlay')?.classList.remove('visible')
        const title = aside?.querySelector('.react-chat-aside-toolbar-title') as HTMLElement | null
        if (title && !title.dataset.desktopTitle) {
          title.dataset.desktopTitle = title.textContent || 'EvoFlow'
          title.textContent = '对话'
        }
      } else {
        if (isMobileChat) aside?.classList.remove('shell-aside-open')
        const title = aside?.querySelector('.react-chat-aside-toolbar-title') as HTMLElement | null
        if (title?.dataset.desktopTitle) {
          title.textContent = title.dataset.desktopTitle
          delete title.dataset.desktopTitle
        }
      }
    }
    apply()
    window.addEventListener('hashchange', apply)
    return () => {
      window.removeEventListener('hashchange', apply)
      app?.classList.remove('evopanel-mobile-chat-list')
      app?.classList.remove('evopanel-mobile-chat-thread')
      const title = document.querySelector(
        '#app-shell-aside .react-chat-aside-toolbar-title',
      ) as HTMLElement | null
      if (title?.dataset.desktopTitle) {
        title.textContent = title.dataset.desktopTitle
        delete title.dataset.desktopTitle
      }
    }
  }, [isMobileChat, mobileChatPane])

  // 摘要默认窄宽；宽内容标签（浏览器 / 壳页 / 进度）出现时抬到约 45%，之后尊重用户拖拽。
  const rightPanelWasOpenRef = useRef(false)
  const wideContentSeededRef = useRef(false)
  const wideContentSeedSessionRef = useRef(String(selectedSessionKey || ''))
  if (wideContentSeedSessionRef.current !== String(selectedSessionKey || '')) {
    wideContentSeedSessionRef.current = String(selectedSessionKey || '')
    wideContentSeededRef.current = false
  }

  useLayoutEffect(() => {
    if (!anyRightPanelOpen || !layoutResizeEnabled) {
      rightPanelWasOpenRef.current = false
      return
    }
    const el = mainBodyRef.current
    if (!el) return
    const bodyW = el.clientWidth
    const opening = !rightPanelWasOpenRef.current
    rightPanelWasOpenRef.current = true
    let shouldPersist = false
    setRightPanelWidthPx((prev) => {
      if (prev != null && Number.isFinite(prev) && prev > 0) {
        // 仍停在旧摘要默认 340：抬到新窄栏，避免卡片继续贴边
        const seed = prev === RIGHT_PANEL_NARROW_LEGACY_PX
          ? defaultNarrowRightPanelWidth(bodyW)
          : prev
        const clamped = clampRightPanelWidth(seed, bodyW)
        if (clamped !== prev) {
          layoutSizesRef.current.rightPanelWidthPx = clamped
          shouldPersist = true
        }
        return clamped
      }
      if (!opening && prev != null) return prev
      // 对话默认摘要：窄栏；不要一上来半屏
      const def = defaultNarrowRightPanelWidth(bodyW)
      layoutSizesRef.current.rightPanelWidthPx = def
      shouldPersist = true
      return def
    })
    if (shouldPersist) saveChatLayoutPrefs(layoutSizesRef.current)
  }, [anyRightPanelOpen, layoutResizeEnabled])

  /** 需要可读宽栏的标签（与 defaultLayoutForKind / open* layout:wide 对齐） */
  const hasWideStageTab = rightStageTabs.some((t) => {
    const k = normalizeRightStageKind(t.kind)
    return (
      k === 'browser' ||
      k === 'shell-page' ||
      k === 'employeeProcess' ||
      k === 'collab-workflow' ||
      k === 'collabSubtaskTranscript' ||
      k === 'write' ||
      k === 'web-embed' ||
      k === 'news-dashboard' ||
      k === 'mind-map' ||
      k === 'workspace-browse'
    )
  })
  const hasBrowserStageTab = rightStageTabs.some(
    (t) => normalizeRightStageKind(t.kind) === 'browser',
  )

  // 本会话首次出现宽内容标签：从摘要窄栏抬到宽栏默认；已更宽则不动。
  useLayoutEffect(() => {
    if (!anyRightPanelOpen || !layoutResizeEnabled) return
    if (!hasWideStageTab) return
    if (wideContentSeededRef.current) return
    const el = mainBodyRef.current
    if (!el) return
    wideContentSeededRef.current = true
    const bodyW = el.clientWidth
    const narrow = defaultNarrowRightPanelWidth(bodyW)
    const wide = defaultWideRightPanelWidth(bodyW)
    setRightPanelWidthPx((prev) => {
      // 已比宽默认更宽（或接近）则不动
      if (prev != null && Number.isFinite(prev) && prev >= wide - 8) {
        return prev
      }
      // 用户已明显拖离窄栏（比窄默认大约 64px+）→ 尊重，勿硬抬
      if (prev != null && Number.isFinite(prev) && prev > narrow + 64) {
        return prev
      }
      layoutSizesRef.current.rightPanelWidthPx = wide
      saveChatLayoutPrefs({
        ...layoutSizesRef.current,
        rightPanelWidthPx: wide,
      })
      return wide
    })
  }, [anyRightPanelOpen, layoutResizeEnabled, hasWideStageTab])

  useEffect(() => {
    layoutSizesRef.current = { rightPanelWidthPx, bottomDockHeightPx }
  }, [rightPanelWidthPx, bottomDockHeightPx])

  const persistLayoutSizes = useCallback(() => {
    saveChatLayoutPrefs(layoutSizesRef.current)
    // 拖宽结束：显式唤醒（拖拽中靠 BrowserPanel 的 RO/rAF 跟四角）。
    notifyLayoutChromeChanged('chat-layout-persist')
    window.setTimeout(() => notifyLayoutChromeChanged('chat-layout-settle'), 100)
  }, [])

  useEffect(() => {
    if (!anyRightPanelOpen) return
    notifyLayoutChromeChanged('chat-right-open')
    const t = window.setTimeout(() => notifyLayoutChromeChanged('chat-right-open-settle'), 160)
    return () => window.clearTimeout(t)
  }, [anyRightPanelOpen])

  const onRightPanelDragDelta = useCallback((delta: number) => {
    const el = mainBodyRef.current
    if (!el) return
    setRightPanelWidthPx((prev) => {
      const current = prev ?? defaultRightPanelWidth(el.clientWidth)
      const next = clampRightPanelWidth(current - delta, el.clientWidth)
      layoutSizesRef.current.rightPanelWidthPx = next
      return next
    })
  }, [])

  const onBottomDockDragDelta = useCallback((delta: number) => {
    const natural = bottomAreaNaturalHeightRef.current
    const current = bottomAreaLiveHeightRef.current ?? natural
    const colH = conversationColRef.current?.clientHeight || window.innerHeight
    const next = applyBottomAreaHeightDelta(
      current,
      delta,
      natural,
      window.innerHeight,
      colH,
    )
    bottomAreaLiveHeightRef.current = next
    layoutSizesRef.current.bottomDockHeightPx = next
    setBottomDockHeightPx(next)
  }, [])

  const handleBottomDockResizePointerEnd = useCallback(() => {
    bottomAreaLiveHeightRef.current = layoutSizesRef.current.bottomDockHeightPx
    persistLayoutSizes()
  }, [persistLayoutSizes])

  const {
    onPointerDown: onRightPanelResizePointerDown,
    dragging: rightPanelResizeDragging,
  } = useDragResize({
    axis: 'x',
    enabled: anyRightPanelOpen && layoutResizeEnabled,
    onDragDelta: onRightPanelDragDelta,
    onDragEnd: persistLayoutSizes,
  })

  const {
    onPointerDown: onBottomDockResizePointerDown,
    dragging: bottomDockResizeDragging,
  } = useDragResize({
    axis: 'y',
    enabled: layoutResizeEnabled,
    onDragDelta: onBottomDockDragDelta,
    onDragEnd: handleBottomDockResizePointerEnd,
  })

  const handleBottomDockResizePointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const el = bottomAreaRef.current
      if (el) {
        bottomAreaNaturalHeightRef.current = measureBottomAreaNaturalHeight(el)
        const rect = Math.ceil(el.getBoundingClientRect().height)
        bottomAreaLiveHeightRef.current = bottomDockHeightPx ?? rect
      }
      onBottomDockResizePointerDown(e)
    },
    [bottomDockHeightPx, onBottomDockResizePointerDown],
  )

  const mainBodyLayoutStyle = useMemo((): CSSProperties | undefined => {
    if (!anyRightPanelOpen || !layoutResizeEnabled || rightPanelWidthPx == null) return undefined
    return { ['--chat-right-panel-width' as string]: `${rightPanelWidthPx}px` }
  }, [anyRightPanelOpen, layoutResizeEnabled, rightPanelWidthPx])

  const bottomAreaLayoutStyle = useMemo(() => {
    if (!layoutResizeEnabled || bottomDockHeightPx == null) return undefined
    return {
      height: bottomDockHeightPx,
      minHeight: bottomDockHeightPx,
      maxHeight: bottomDockHeightPx,
      boxSizing: 'border-box' as const,
      overflowX: 'hidden' as const,
      overflowY: 'auto' as const,
      flexShrink: 0,
    }
  }, [layoutResizeEnabled, bottomDockHeightPx])

  return {
    mainBodyRef,
    conversationColRef,
    bottomAreaRef,
    layoutResizeEnabled,
    isMobileChat,
    mobileChatPane,
    setMobileChatPane,
    rightPanelWidthPx,
    bottomDockHeightPx,
    hasBrowserStageTab,
    onRightPanelResizePointerDown,
    rightPanelResizeDragging,
    handleBottomDockResizePointerDown,
    bottomDockResizeDragging,
    mainBodyLayoutStyle,
    bottomAreaLayoutStyle,
  }
}
