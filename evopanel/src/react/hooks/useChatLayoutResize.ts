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
  /**
   * 用户拖拽出的**原始宽度意图**（未按当前主列宽钳制）。
   *
   * 【self-evolution-bot · 2026-11-21 · 第114轮 · 模型:deepseek-v4.1-flash-1017】
   * 为什么要有这个 ref：渲染宽度必须恒为 clamp(意图, 当前主列宽)。
   *   若只留一个 state，缩窗时把它改小就等于**把用户的意图永久改写**，
   *   窗口放大回来也回不到原来的宽度。分开存：state=显示值（可变），ref=意图（只被拖拽改）。
   */
  const rightPanelWidthPrefRef = useRef<number | null>(loadChatLayoutPrefs().rightPanelWidthPx)

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
        // 【self-evolution-bot · 2026-11-21 · 第114轮 · 模型:deepseek-v4.1-flash-1017】
        // 迁移种子也写回意图 ref，否则存储里仍是旧的 340，缩窗重算会按 340 走。
        if (seed !== prev) rightPanelWidthPrefRef.current = seed
        if (clamped !== prev) {
          layoutSizesRef.current.rightPanelWidthPx = clamped
          shouldPersist = true
        }
        return clamped
      }
      if (!opening && prev != null) return prev
      // 对话默认摘要：窄栏；不要一上来半屏
      const def = defaultNarrowRightPanelWidth(bodyW)
      rightPanelWidthPrefRef.current = def
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
      rightPanelWidthPrefRef.current = wide
      saveChatLayoutPrefs({
        ...layoutSizesRef.current,
        rightPanelWidthPx: wide,
      })
      return wide
    })
  }, [anyRightPanelOpen, layoutResizeEnabled, hasWideStageTab])

  useEffect(() => {
    // 【self-evolution-bot · 2026-11-21 · 第114轮 · 模型:deepseek-v4.1-flash-1017】
    // 改了什么：持久化用**意图**（pref ref），不用显示值。
    // 为什么：显示值在窄窗下已被钳制（如意图 896 → 显示 610），若把它当意图落盘，
    //   窗口放大回来也回不到 896 —— 等于缩一次窗就永久改写用户拖出来的宽度。
    layoutSizesRef.current = {
      rightPanelWidthPx: rightPanelWidthPrefRef.current ?? rightPanelWidthPx,
      bottomDockHeightPx,
    }
  }, [rightPanelWidthPx, bottomDockHeightPx])

  /**
   * 窗口尺寸变化时重算右栏宽度。
   *
   * 【self-evolution-bot · 2026-11-21 · 第114轮 · 模型:deepseek-v4.1-flash-1017】
   * 改了什么：新增这个 effect —— 主列宽度变化（拖窗口边框 / 最大化 / 还原）时，
   *   把显示宽度重算为 clamp(用户意图, 新主列宽)。用户意图存 rightPanelWidthPrefRef，
   *   不回写，所以窗口放大回来时宽度能回到用户拖出来的原值。
   * 为什么（现网实测原文，2026-11-21 本轮 1440 窗口已装包）::
   *
   *   用户拖到 896px 后缩窗，右栏**停在 896px 不动**，直接伸出视口：
   *     vw=1280 → asideR 1273，clipped 0
   *     vw=1100 → asideR 1176，clipped 76px
   *     vw=1000 → asideR 1176，clipped 176px
   *     vw= 960（窗口 minWidth）→ asideR 1176，clipped 216px
   *   同时对话列被压到 220px 底限不再收缩 —— 即溢出全部落在右栏右边缘被裁，
   *   标签条（tabsR 恒 1176）与面板内容一起被切，用户看不到右侧内容。
   * 判据：缩窗后 aside.getBoundingClientRect().right 必须 ≤ innerWidth（clippedPx 归 0），
   *   放大回来 asideW 必须回到拖拽原值。
   */
  useEffect(() => {
    if (typeof window === 'undefined') return
    const el = mainBodyRef.current
    if (!el || !anyRightPanelOpen || !layoutResizeEnabled) return
    let raf = 0
    const recompute = () => {
      const bodyW = mainBodyRef.current?.clientWidth || 0
      if (!bodyW) return
      const pref = rightPanelWidthPrefRef.current
      if (pref == null || !Number.isFinite(pref) || pref <= 0) return
      const next = clampRightPanelWidth(pref, bodyW)
      setRightPanelWidthPx((prev) => (prev == null || Math.abs(prev - next) >= 1 ? next : prev))
    }
    const onResize = () => {
      if (raf) window.cancelAnimationFrame(raf)
      raf = window.requestAnimationFrame(() => {
        raf = 0
        recompute()
      })
    }
    window.addEventListener('resize', onResize)
    // 主列宽度不一定跟 window resize 同步（侧栏收起、输入区变化都会改它）。
    let ro: ResizeObserver | null = null
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(onResize)
      ro.observe(el)
    }
    return () => {
      if (raf) window.cancelAnimationFrame(raf)
      window.removeEventListener('resize', onResize)
      ro?.disconnect()
    }
  }, [anyRightPanelOpen, layoutResizeEnabled])

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
      // 【self-evolution-bot · 2026-11-21 · 第114轮 · 模型:deepseek-v4.1-flash-1017】
      // 拖拽是唯一改写「用户意图」的入口：这里同步 pref ref，缩窗重算才不会按旧值走。
      rightPanelWidthPrefRef.current = next
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
