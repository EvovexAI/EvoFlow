import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import type { ChatAttachment } from '../chat-types.js'
import {
  getShortcutBinding,
  KEYBOARD_SHORTCUTS_CHANGED,
  micVoiceHintText,
  pushToTalkReleaseMatches,
  shortcutMatchesEvent,
  voiceShortcutHintText,
} from '../../lib/keyboard-shortcuts.js'
import { isTauri } from '../../lib/panel-login.js'
import { api } from '../../lib/tauri-api.js'
import {
  cancelVoiceCapture,
  getVoicePartialTranscript,
  isVoiceCaptureActive,
  startVoiceCapture,
  stopVoiceCapture,
} from '../../lib/voice-capture-service.js'
import { VOICE_CAPTURE_SESSION_BEGIN, VOICE_CAPTURE_SESSION_END } from '../../lib/background-voice-bridge.js'
import { ObjectUrlImg } from './ObjectUrlImg.js'
import { ImagePreviewModal, type ImagePreviewItem } from './ImagePreviewModal.js'
import {
  hideVoiceInputOverlay,
  showVoiceInputOverlay,
} from '../../lib/background-voice.js'
import { getMentionAtCursor } from '../lib/workspace-mention.js'
import { measureTextareaCaret } from '../lib/textarea-caret.js'
import { WorkspaceMentionMenu, type MentionFileOption, type MentionEmployeeOption, type MentionOption, isEmployeeOption } from './WorkspaceMentionMenu.js'
import {
  appendUrlsToDraft,
  createComposeAttachHandlers,
  looksLikeLocalPath,
  pickLocalContextFiles,
  type ComposeAttachResult,
  type ComposePathEntry,
} from '../lib/compose-attach.js'

export type { MentionEmployeeOption }

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result || ''))
    r.onerror = () => reject(r.error || new Error('read failed'))
    r.readAsDataURL(file)
  })
}

/** Downscale / re-encode large phone photos so chat JSON body stays under gateway chunk limits. */
async function compressImageForChat(file: File): Promise<ChatAttachment | null> {
  const rawType = String(file.type || '').toLowerCase()
  const looksImage =
    rawType.startsWith('image/') ||
    /\.(jpe?g|png|gif|webp|heic|heif|bmp)$/i.test(file.name || '')
  if (!looksImage) return null
  // Keep GIF as-is (animation); skip if already small enough.
  if (rawType === 'image/gif') return null
  if (file.size > 0 && file.size <= 900_000 && (rawType === 'image/jpeg' || rawType === 'image/webp')) {
    return null
  }

  const dataUrl = await readFileAsDataUrl(file)
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image()
    el.onload = () => resolve(el)
    el.onerror = () => reject(new Error('image decode failed'))
    el.src = dataUrl
  })

  const maxEdge = 1600
  const w = img.naturalWidth || img.width
  const h = img.naturalHeight || img.height
  if (!w || !h) return null
  const scale = Math.min(1, maxEdge / Math.max(w, h))
  const tw = Math.max(1, Math.round(w * scale))
  const th = Math.max(1, Math.round(h * scale))
  const canvas = document.createElement('canvas')
  canvas.width = tw
  canvas.height = th
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.drawImage(img, 0, 0, tw, th)

  const outType = 'image/jpeg'
  const blob: Blob | null = await new Promise((resolve) =>
    canvas.toBlob((b) => resolve(b), outType, 0.82),
  )
  if (!blob) return null
  const outName = String(file.name || 'image').replace(/\.[^.]+$/, '') + '.jpg'
  const outUrl = await readFileAsDataUrl(new File([blob], outName, { type: outType }))
  const base64 = outUrl.split(',')[1] || ''
  if (!base64) return null
  return { mimeType: outType, content: base64, filename: outName }
}

function isImageFile(file: File): boolean {
  const rawType = String(file.type || '').toLowerCase()
  if (rawType.startsWith('image/')) return true
  return /\.(jpe?g|png|gif|webp|heic|heif|bmp)$/i.test(file.name || '')
}

function readFileAsAttachment(file: File): Promise<ChatAttachment> {
  return (async () => {
    const filename = String(file.name || '').trim() || 'file'
    // Documents: keep File for thread uploads API (markitdown). Do not base64 as fake images.
    if (!isImageFile(file)) {
      return {
        mimeType: file.type || 'application/octet-stream',
        filename,
        file,
      }
    }
    try {
      const compressed = await compressImageForChat(file)
      if (compressed) return compressed
    } catch {
      /* fall through to raw */
    }
    const dataUrl = await readFileAsDataUrl(file)
    const base64 = dataUrl.split(',')[1] || ''
    if (!base64) throw new Error('empty file')
    return {
      mimeType: file.type || 'application/octet-stream',
      content: base64,
      filename,
    }
  })()
}

export type WorkspaceMentionConfig = {
  enabled: boolean
  searchFiles: (query: string) => Promise<MentionFileOption[]>
  onAttachFile: (entry: MentionFileOption) => void
  /** Active employees for `@员工` dispatch. When omitted, `@` is disabled. */
  roles?: MentionEmployeeOption[]
}

/** Result of parsing a leading `@员工名` token from the message text. */
export type ParsedEmployeeMention = {
  agent_code: string
  role_name: string
  /** The message text after the mention token (the dispatched goal). */
  taskText: string
}

/**
 * Parse a leading `@员工` mention at the very start of the message.
 * Supported forms:
 *   @前端架构师 检查 login 报错
 *   @前端架构师检查 login 报错   (space optional when name has no ambiguity)
 * Returns null when no role name matches (so plain `@someone` falls through to
 * normal chat).
 */
export function parseEmployeeMention(
  text: string,
  roles: MentionEmployeeOption[],
): ParsedEmployeeMention | null {
  const raw = String(text || '').trimStart()
  if (!raw.startsWith('@')) return null
  const list = Array.isArray(roles) ? roles : []
  if (!list.length) return null

  // Prefer the longest matching role name to avoid ambiguity between
  // 「前端」and「前端架构师」when the user types the longer one.
  const sorted = [...list].sort((a, b) => b.role_name.length - a.role_name.length)
  for (const r of sorted) {
    const name = String(r.role_name || '').trim()
    if (!name) continue
    // @name<space|rest>
    if (raw.length > name.length + 1 && raw.slice(1, 1 + name.length) === name) {
      const after = raw.slice(1 + name.length)
      const taskText = after.replace(/^[\s:：]+/, '').trim()
      if (taskText) {
        return { agent_code: r.agent_code, role_name: name, taskText }
      }
    }
  }
  return null
}

export const ChatComposer = memo(function ChatComposer({
  sessionReady,
  engineReady = true,
  sending,
  streaming,
  initialDraft,
  draftVersion,
  onDraftChange,
  onComposerWarmup,
  onSend,
  onAbort,
  pendingSteers = [],
  pendingSendQueue = [],
  onSteerWhileBusy,
  onQueueWhileBusy,
  onFlushPendingSend,
  onCancelPendingSend,
  onEditPendingSend,
  onInterruptAndSendSteers,
  onEnhancePrompt,
  placeholder = '输入消息…',
  renderBottomControls,
  workspaceMention,
  attachedContextFileCount = 0,
  onAttachContextFiles,
  speechEnabled,
  onVoiceTranscribed,
  onDispatchEmployee,
}: {
  sessionReady: boolean
  /** False while Gateway Agent/LangGraph is still warming — UI stays browsable. */
  engineReady?: boolean
  sending: boolean
  streaming: boolean
  /** Draft text to restore when `draftVersion` bumps (session switch). */
  initialDraft: string
  draftVersion: number
  /** Persists draft to parent ref/map without triggering parent re-render. */
  onDraftChange: (value: string) => void
  /** Latency warmup: focus → ensure-thread (send path stays hot). */
  onComposerWarmup?: () => void
  onSend: (message: string, attachments?: ChatAttachment[], opts?: { voiceInitiated?: boolean }) => void | Promise<void>
  onAbort: () => void | Promise<void>
  /**
   * runtime-aligned mid-turn steers already submitted via ↑ / turn/steer.
   * Shown above the composer until the next tool/model boundary consumes them.
   */
  pendingSteers?: Array<{ id: string; messageId: string; text: string }>
  /** 流式进行中排队等待发送的消息（回合结束后再发；runtime queued follow-ups） */
  pendingSendQueue?: Array<{ id: string; text: string }>
  /** 流式中 Enter：排队，整轮结束后自动发送 */
  onSteerWhileBusy?: (text: string) => void
  /** 流式中 Enter/Tab：排队，回合结束后再发 */
  onQueueWhileBusy?: (text: string) => void
  /** ↑ / 空 Enter：把排队消息提升为下次工具前纠偏（不打断整轮） */
  onFlushPendingSend?: (id: string) => void
  /** 取消某条等待发送 */
  onCancelPendingSend?: (id: string) => void
  /** 修改排队中的正文 */
  onEditPendingSend?: (id: string, text: string) => void
  /** Esc：打断当前回合并立即发送全部 pending steers（runtime Esc 路径） */
  onInterruptAndSendSteers?: () => void
  /** When set, shows microphone for voice input (requires Gateway speech config). */
  speechEnabled?: boolean
  onVoiceTranscribed?: (text: string) => void | Promise<void>
  /** When set, shows a magic-wand button to refine draft text before send. */
  onEnhancePrompt?: (text: string) => Promise<string | null>
  placeholder?: string
  renderBottomControls?: (args: {
    pickFiles: () => void
    pickDocFiles: () => void
    insertText: (next: string) => void
  }) => ReactNode
  workspaceMention?: WorkspaceMentionConfig
  /** 输入框上方 @ 附加的工作区文件数量（允许仅附加文件时发送） */
  attachedContextFileCount?: number
  /** 粘贴/拖放解析出本机或工作区路径时挂载（不上传） */
  onAttachContextFiles?: (entries: ComposePathEntry[]) => void
  /** `@员工名 任务` -> 派发任务给员工。命中时不走 onSend，主聊天不产生消息。 */
  onDispatchEmployee?: (agentCode: string, goal: string) => void | Promise<void>
}) {
  const [text, setText] = useState(initialDraft)
  const [pendingFiles, setPendingFiles] = useState<File[]>([])
  /** 图片预览 modal：null=关闭，number=打开并展示该索引 */
  const [imagePreviewIndex, setImagePreviewIndex] = useState<number | null>(null)
  /** 粘贴路径后父级 context count 尚未回写前，先本地记一笔以便点亮发送 */
  const [pendingContextBoost, setPendingContextBoost] = useState(0)
  const [enhancing, setEnhancing] = useState(false)
  const [enhanceAnchor, setEnhanceAnchor] = useState<{ left: number; top: number } | null>(null)
  const [mentionItems, setMentionItems] = useState<MentionOption[]>([])
  const [mentionLoading, setMentionLoading] = useState(false)
  const [mentionActive, setMentionActive] = useState(0)
  const [cursor, setCursor] = useState(0)
  const fileRef = useRef<HTMLInputElement | null>(null)
  const docFileRef = useRef<HTMLInputElement | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const mentionSearchRef = useRef(0)
  const voiceStartSourceRef = useRef<'mic' | 'keyboard' | null>(null)
  const voiceStartingRef = useRef(false)
  const pendingStopRef = useRef(false)
  const voiceHoldStartedAtRef = useRef(0)
  const savedDraftBeforeVoiceRef = useRef('')
  const appliedDraftVersionRef = useRef(draftVersion)
  const enhanceAnchorRafRef = useRef(0)
  const [voiceRecording, setVoiceRecording] = useState(false)
  const [voiceBusy, setVoiceBusy] = useState(false)
  const [, setVoiceStreaming] = useState(false)
  const [voiceShortcutTick, setVoiceShortcutTick] = useState(0)
  const [ttsSpeaking, setTtsSpeaking] = useState(false)
  const voiceRecordingRef = useRef(false)
  const voiceBusyRef = useRef(false)
  const canUseVoiceRef = useRef(false)

  useEffect(() => {
    voiceRecordingRef.current = voiceRecording
  }, [voiceRecording])

  useEffect(() => {
    voiceBusyRef.current = voiceBusy
  }, [voiceBusy])

  useEffect(() => {
    canUseVoiceRef.current =
      !!speechEnabled &&
      !!onVoiceTranscribed &&
      sessionReady &&
      !streaming &&
      !sending &&
      !voiceBusy &&
      !voiceRecording
  }, [speechEnabled, onVoiceTranscribed, sessionReady, streaming, sending, voiceBusy, voiceRecording])

  // 监听 TTS 播报状态：播报中显示「停止播报」按钮
  useEffect(() => {
    let unsub = () => {}
    void import('../../lib/speech-client.js').then(({ onSpeakingChange }) => {
      unsub = onSpeakingChange(setTtsSpeaking)
    })
    return () => unsub()
  }, [])

  useLayoutEffect(() => {
    if (appliedDraftVersionRef.current === draftVersion) return
    appliedDraftVersionRef.current = draftVersion
    setText(initialDraft)
    setCursor(initialDraft.length)
    setPendingContextBoost(0)
  }, [draftVersion, initialDraft])

  useEffect(() => {
    if (attachedContextFileCount > 0) setPendingContextBoost(0)
  }, [attachedContextFileCount])

  const contextAttachCount = attachedContextFileCount + pendingContextBoost

  const setTextAndNotify = useCallback(
    (next: string) => {
      setText(next)
      onDraftChange(next)
    },
    [onDraftChange],
  )

  const mentionRange = useMemo(() => {
    if (!workspaceMention?.enabled) return null
    const range = getMentionAtCursor(text, cursor)
    if (!range) return null
    // Employee menu only when roles are available; otherwise `@` is left as
    // plain text (no autocomplete) so users can still type @someone in chat.
    if (range.type === 'employee' && !(workspaceMention.roles && workspaceMention.roles.length)) {
      return null
    }
    return range
  }, [workspaceMention?.enabled, workspaceMention?.roles, text, cursor])

  const mentionOpen = !!mentionRange

  const showEnhanceBtn =
    !!onEnhancePrompt && !(streaming || sending) && !!text.trim() && sessionReady && !mentionOpen

  const syncEnhanceAnchor = useCallback(() => {
    const ta = textareaRef.current
    if (!ta || !showEnhanceBtn) {
      setEnhanceAnchor(null)
      return
    }
    const end = text.length
    const pos = measureTextareaCaret(ta, end)
    setEnhanceAnchor(pos)
  }, [showEnhanceBtn, text.length])

  const scheduleEnhanceAnchor = useCallback(() => {
    if (enhanceAnchorRafRef.current) return
    enhanceAnchorRafRef.current = requestAnimationFrame(() => {
      enhanceAnchorRafRef.current = 0
      syncEnhanceAnchor()
    })
  }, [syncEnhanceAnchor])

  useLayoutEffect(() => {
    scheduleEnhanceAnchor()
  }, [scheduleEnhanceAnchor, showEnhanceBtn])

  useEffect(() => {
    return () => {
      if (enhanceAnchorRafRef.current) cancelAnimationFrame(enhanceAnchorRafRef.current)
    }
  }, [])

  useEffect(() => {
    const ta = textareaRef.current
    if (!ta || !showEnhanceBtn) return
    const onScroll = () => scheduleEnhanceAnchor()
    ta.addEventListener('scroll', onScroll, { passive: true })
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => scheduleEnhanceAnchor()) : null
    ro?.observe(ta)
    window.addEventListener('resize', onScroll)
    return () => {
      ta.removeEventListener('scroll', onScroll)
      ro?.disconnect()
      window.removeEventListener('resize', onScroll)
    }
  }, [showEnhanceBtn, scheduleEnhanceAnchor])

  const pickFiles = useMemo(
    () => () => {
      fileRef.current?.click()
    },
    [],
  )

  const pickDocFiles = useMemo(
    () => async () => {
      if (isTauri && onAttachContextFiles) {
        const entries = await pickLocalContextFiles()
        if (!entries.length) return
        onAttachContextFiles(entries)
        setPendingContextBoost((n) => n + entries.length)
        void import('../../components/toast.js').then(({ toast }) => {
          toast(`已附加：${entries.map((e) => e.name).join('、')}（发送后注入 Agent 上下文）`, 'info')
        })
        return
      }
      docFileRef.current?.click()
    },
    [onAttachContextFiles],
  )

  useEffect(() => {
    const onHomePick = () => pickFiles()
    window.addEventListener('evopanel:composer-pick-files', onHomePick)
    return () => window.removeEventListener('evopanel:composer-pick-files', onHomePick)
  }, [pickFiles])

  function insertText(next: string) {
    setTextAndNotify(next)
    textareaRef.current?.focus()
  }

  const closeMention = useCallback(() => {
    setMentionItems([])
    setMentionActive(0)
  }, [])

  const applyMentionPick = useCallback(
    (item: MentionOption) => {
      if (!mentionRange) return
      const isEmp = isEmployeeOption(item)
      const trigger = isEmp ? '@' : '#'
      const label = isEmp
        ? String((item as MentionEmployeeOption).role_name || '').trim()
        : String((item as MentionFileOption).name || (item as MentionFileOption).path || '').trim()
      const token = label ? `${trigger}${label} ` : ''
      const next = text.slice(0, mentionRange.start) + token + text.slice(mentionRange.end)
      setTextAndNotify(next)
      const pos = mentionRange.start + token.length
      setCursor(pos)
      requestAnimationFrame(() => {
        const ta = textareaRef.current
        if (ta) {
          ta.focus()
          ta.setSelectionRange(pos, pos)
        }
      })
      if (!isEmp) {
        workspaceMention?.onAttachFile(item as MentionFileOption)
      }
      closeMention()
    },
    [closeMention, mentionRange, setTextAndNotify, text, workspaceMention],
  )

  useEffect(() => {
    if (!mentionOpen || !workspaceMention?.enabled) {
      closeMention()
      return
    }
    const q = mentionRange?.query ?? ''
    const mType = mentionRange?.type ?? null
    // Employee mentions are filtered locally from the roles list (no backend round-trip).
    // Empty query still lists all roles so the menu auto-shows available employees.
    if (mType === 'employee') {
      const roles = workspaceMention.roles || []
      const ql = q.toLowerCase()
      const matched = roles.filter((r) => {
        const name = String(r.role_name || '').toLowerCase()
        const code = String(r.agent_code || '').toLowerCase()
        return name.includes(ql) || code.includes(ql)
      })
      setMentionItems(matched)
      setMentionLoading(false)
      setMentionActive(0)
      return
    }
    if (!q.trim()) {
      setMentionItems([])
      setMentionLoading(false)
      setMentionActive(0)
      return
    }
    // File mentions go through the existing async searchFiles.
    const ticket = ++mentionSearchRef.current
    setMentionLoading(true)
    const timer = window.setTimeout(() => {
      void workspaceMention
        .searchFiles(q)
        .then((items) => {
          if (mentionSearchRef.current !== ticket) return
          setMentionItems(items)
          setMentionActive(0)
        })
        .catch(() => {
          if (mentionSearchRef.current !== ticket) return
          setMentionItems([])
        })
        .finally(() => {
          if (mentionSearchRef.current === ticket) setMentionLoading(false)
        })
    }, 180)
    return () => window.clearTimeout(timer)
  }, [closeMention, mentionOpen, mentionRange?.query, mentionRange?.type, workspaceMention])

  async function handleEnhancePrompt() {
    const draft = text.trim()
    if (!draft || !onEnhancePrompt || enhancing || streaming || sending) return
    setEnhancing(true)
    try {
      const next = await onEnhancePrompt(draft)
      if (next && next.trim()) {
        setTextAndNotify(next.trim())
        requestAnimationFrame(() => {
          const ta = textareaRef.current
          if (ta) {
            ta.focus()
            const end = next.trim().length
            ta.setSelectionRange(end, end)
            setCursor(end)
            scheduleEnhanceAnchor()
          }
        })
      }
    } finally {
      setEnhancing(false)
    }
  }

  async function handleSend() {
    // 粘贴后偶发 state 未跟上：以输入框 DOM 为准
    const live = String(textareaRef.current?.value ?? text)
    if (live !== text) {
      setText(live)
      onDraftChange(live)
    }
    const t = live.trim()
    if (!t && !pendingFiles.length && contextAttachCount <= 0) {
      // 忙时、输入框空、已有排队：再次 Enter → 提升为下次工具前纠偏
      if (
        (streaming || sending) &&
        pendingSendQueue[0] &&
        onFlushPendingSend &&
        !pendingFiles.length
      ) {
        onFlushPendingSend(pendingSendQueue[0].id)
      }
      return
    }

    if (!engineReady) {
      void import('../../components/toast.js').then(({ toast }) => {
        toast('Agent 引擎仍在加载，就绪后再发送', 'info')
      })
      return
    }

    // 流式中：Enter = 排队等整轮结束自动发；已排队时 ↑ / 空 Enter = 下次工具前注入
    if ((streaming || sending) && onQueueWhileBusy) {
      if (!t) return
      if (pendingFiles.length) {
        void import('../../components/toast.js').then(({ toast }) => {
          toast('处理中暂不能带附件排队，请等本轮结束后再发，或先移除附件', 'warning')
        })
        return
      }
      onQueueWhileBusy(t)
      setTextAndNotify('')
      closeMention()
      return
    }
    if (streaming || sending) return

    // ── @员工 任务派发路由（方案 A：主聊天不产生消息） ──────────────
    // 文本以 `@岗位名` 开头且命中已注册员工时，走派发而非普通聊天。
    // 未命中（无 roles / 名字不匹配）则原样当普通消息发送，保持向下兼容。
    if (onDispatchEmployee && workspaceMention?.roles && workspaceMention.roles.length) {
      const dispatch = parseEmployeeMention(t, workspaceMention.roles)
      if (dispatch) {
        const attachments: ChatAttachment[] = []
        try {
          for (const f of pendingFiles) {
            attachments.push(await readFileAsAttachment(f))
          }
        } catch (e) {
          console.warn('[ChatComposer] dispatch attachment', e)
          return
        }
        setTextAndNotify('')
        setPendingFiles([])
        closeMention()
        try {
          await onDispatchEmployee(dispatch.agent_code, dispatch.taskText)
        } catch (e) {
          console.warn('[ChatComposer] dispatch failed', e)
          // 派发失败时把任务文本还原，方便用户重试或改走普通聊天
          setTextAndNotify(`@${dispatch.role_name} ${dispatch.taskText}`)
        }
        return
      }
    }

    const attachments: ChatAttachment[] = []
    try {
      for (const f of pendingFiles) {
        attachments.push(await readFileAsAttachment(f))
      }
    } catch (e) {
      console.warn('[ChatComposer] attachment', e)
      return
    }
    setTextAndNotify('')
    setPendingFiles([])
    closeMention()
    await onSend(t, attachments.length ? attachments : undefined)
  }

  const cancelVoiceCaptureLocal = useCallback(() => {
    voiceStartSourceRef.current = null
    cancelVoiceCapture()
    void hideVoiceInputOverlay()
    setVoiceStreaming(false)
    setVoiceRecording(false)
    setVoiceBusy(false)
    const restore = savedDraftBeforeVoiceRef.current
    savedDraftBeforeVoiceRef.current = ''
    if (restore) setTextAndNotify(restore)
    else setTextAndNotify('')
  }, [setTextAndNotify])

  const stopVoiceRecordingAndSend = useCallback(async () => {
    // 录音正在启动中（showVoiceInputOverlay / startVoiceCapture 还没返回）→ 排队等启动完成后自动停止
    if (voiceStartingRef.current && !isVoiceCaptureActive()) {
      pendingStopRef.current = true
      return
    }
    if (!voiceRecordingRef.current && !isVoiceCaptureActive()) return
    if (voiceBusyRef.current) return
    // 同步上锁：Alt/X 连续 keyup 或「再按一次」的 keydown+keyup 不能并发停两次
    voiceBusyRef.current = true

    // 键盘按住过短：提示按住说话，不发送
    if (voiceStartSourceRef.current === 'keyboard' && voiceHoldStartedAtRef.current > 0) {
      const heldMs = Date.now() - voiceHoldStartedAtRef.current
      if (heldMs < 400) {
        voiceHoldStartedAtRef.current = 0
        cancelVoiceCapture()
        voiceStartSourceRef.current = null
        void hideVoiceInputOverlay()
        setVoiceRecording(false)
        setVoiceStreaming(false)
        voiceBusyRef.current = false
        setVoiceBusy(false)
        const restore = savedDraftBeforeVoiceRef.current
        savedDraftBeforeVoiceRef.current = ''
        if (restore) setTextAndNotify(restore)
        else setTextAndNotify('')
        const { toast } = await import('../../components/toast.js')
        const { PTT_SHORT_PRESS_HINT } = await import('../../lib/voice-ptt.js')
        toast(PTT_SHORT_PRESS_HINT, 'info')
        return
      }
    }
    voiceHoldStartedAtRef.current = 0

    setVoiceBusy(true)
    setVoiceRecording(false)
    setVoiceStreaming(false)

    let finalText
    try {
      void hideVoiceInputOverlay()
      const partial = getVoicePartialTranscript()
      // Keep wake paused if we get text and arm follow-up; otherwise resume.
      const { transcript, error } = await stopVoiceCapture({ keepWakePaused: true })
      if (error) throw error
      finalText = String(transcript || partial || '').trim()
      savedDraftBeforeVoiceRef.current = ''
      setTextAndNotify('')
      if (finalText) {
        await onVoiceTranscribed?.(finalText)
        setTextAndNotify('')
        // After AI TTS: auto-listen for follow-ups (same as wake / Alt+X).
        try {
          const { armVoiceFollowUpAfterSend } = await import('../../lib/voice-follow-up.js')
          const { setVoiceTrayState } = await import('../../lib/background-voice.js')
          armVoiceFollowUpAfterSend({
            sendText: async (t) => {
              await onVoiceTranscribed?.(t)
            },
            onTrayState: (s) => {
              void setVoiceTrayState(s as 'idle' | 'recording' | 'processing' | 'running' | 'speaking')
            },
            onPartial: (partialText) => {
              setTextAndNotify(String(partialText || ''))
            },
          })
        } catch (e) {
          console.warn('[ChatComposer] follow-up arm failed', e)
          void import('../../lib/background-voice.js').then(({ resumeWakeEarAfterVoiceSession }) =>
            resumeWakeEarAfterVoiceSession(),
          )
        }
      } else {
        void import('../../lib/background-voice.js').then(({ resumeWakeEarAfterVoiceSession }) =>
          resumeWakeEarAfterVoiceSession(),
        )
        const { toast } = await import('../../components/toast.js')
        toast('未识别到语音内容，请按住说话后再试', 'warning')
      }
    } catch (e) {
      console.warn('[ChatComposer] voice', e)
      const { microphoneErrorMessage } = await import('../../lib/speech-audio.js')
      const { toast } = await import('../../components/toast.js')
      toast(microphoneErrorMessage(e), 'error')
      setTextAndNotify('')
    } finally {
      voiceStartSourceRef.current = null
      void hideVoiceInputOverlay()
      setVoiceRecording(false)
      setVoiceStreaming(false)
      voiceBusyRef.current = false
      setVoiceBusy(false)
    }
  }, [onVoiceTranscribed, setTextAndNotify])

  const startVoiceRecording = useCallback(
    async (source: 'mic' | 'keyboard') => {
      if (!speechEnabled || !onVoiceTranscribed) return
      if (!sessionReady || streaming || sending || voiceBusyRef.current) return
      if (voiceRecordingRef.current || isVoiceCaptureActive()) return

      try {
        const { cancelVoiceFollowUp } = await import('../../lib/voice-follow-up.js')
        cancelVoiceFollowUp()
      } catch {
        /* ignore */
      }

      // Mic start barges in on assistant TTS (same as PTT).
      try {
        const { stopAllAssistantSpeech } = await import('../../lib/speech-client.js')
        stopAllAssistantSpeech()
        const { notifyTTSStopped } = await import('../../lib/background-voice.js')
        notifyTTSStopped()
      } catch {
        /* ignore */
      }

      voiceStartSourceRef.current = source
      voiceHoldStartedAtRef.current = source === 'keyboard' ? Date.now() : 0
      voiceStartingRef.current = true
      savedDraftBeforeVoiceRef.current = text
      setTextAndNotify('')

      try {
        await showVoiceInputOverlay()
        await startVoiceCapture({
          onPartial: (next) => {
            setTextAndNotify(String(next || ''))
          },
        })
        // 启动期间已松手：勿标成 recording，否则界面卡住要再按一次
        if (pendingStopRef.current) {
          pendingStopRef.current = false
          voiceStartingRef.current = false
          const heldMs =
            voiceHoldStartedAtRef.current > 0
              ? Date.now() - voiceHoldStartedAtRef.current
              : 0
          if (voiceStartSourceRef.current === 'keyboard' && heldMs < 400) {
            voiceHoldStartedAtRef.current = 0
            cancelVoiceCapture()
            voiceStartSourceRef.current = null
            void hideVoiceInputOverlay()
            setVoiceRecording(false)
            setVoiceStreaming(false)
            const restore = savedDraftBeforeVoiceRef.current
            savedDraftBeforeVoiceRef.current = ''
            if (restore) setTextAndNotify(restore)
            else setTextAndNotify('')
            const { toast } = await import('../../components/toast.js')
            const { PTT_SHORT_PRESS_HINT } = await import('../../lib/voice-ptt.js')
            toast(PTT_SHORT_PRESS_HINT, 'info')
            return
          }
          setVoiceStreaming(true)
          setVoiceRecording(true)
          void stopVoiceRecordingAndSend()
          return
        }
        setVoiceStreaming(true)
        setVoiceRecording(true)
      } catch (e) {
        console.warn('[ChatComposer] voice start', e)
        voiceStartSourceRef.current = null
        voiceHoldStartedAtRef.current = 0
        pendingStopRef.current = false
        savedDraftBeforeVoiceRef.current = ''
        void hideVoiceInputOverlay()
        setVoiceRecording(false)
        setVoiceStreaming(false)
        const { microphoneErrorMessage } = await import('../../lib/speech-audio.js')
        const { toast } = await import('../../components/toast.js')
        toast(microphoneErrorMessage(e), 'error')
      } finally {
        voiceStartingRef.current = false
        if (pendingStopRef.current) {
          pendingStopRef.current = false
          void stopVoiceRecordingAndSend()
        }
      }
    },
    [
      onVoiceTranscribed,
      sessionReady,
      setTextAndNotify,
      speechEnabled,
      streaming,
      sending,
      text,
      stopVoiceRecordingAndSend,
    ],
  )

  useEffect(() => {
    const refresh = () => setVoiceShortcutTick((t) => t + 1)
    window.addEventListener(KEYBOARD_SHORTCUTS_CHANGED, refresh)
    return () => window.removeEventListener(KEYBOARD_SHORTCUTS_CHANGED, refresh)
  }, [])

  const voicePushBinding = useMemo(
    () => getShortcutBinding('voicePushToTalk'),
    [voiceShortcutTick],
  )

  useEffect(() => {
    if (isTauri) return
    if (!speechEnabled || !onVoiceTranscribed) return
    if (voicePushBinding.disabled) return

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.repeat) return
      if (e.key === 'Escape' && voiceRecordingRef.current) {
        e.preventDefault()
        cancelVoiceCaptureLocal()
        return
      }
      if (!shortcutMatchesEvent(voicePushBinding, e)) return
      e.preventDefault()
      // 已在听：再按一次立即发送（松手事件丢失时也能收尾）
      if (voiceRecordingRef.current || isVoiceCaptureActive()) {
        void stopVoiceRecordingAndSend()
        return
      }
      if (canUseVoiceRef.current) void startVoiceRecording('keyboard')
    }

    const onKeyUp = (e: KeyboardEvent) => {
      // Alt+X 常先松 Alt：不能要求完整组合仍匹配
      if (!pushToTalkReleaseMatches(voicePushBinding, e)) return
      e.preventDefault()
      if (voiceRecordingRef.current || isVoiceCaptureActive() || voiceStartingRef.current) {
        void stopVoiceRecordingAndSend()
      }
    }

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [
    cancelVoiceCaptureLocal,
    onVoiceTranscribed,
    speechEnabled,
    startVoiceRecording,
    stopVoiceRecordingAndSend,
    voicePushBinding,
  ])

  useEffect(() => {
    const onVoiceSessionBegin = () => {
      if (!speechEnabled || !onVoiceTranscribed) return
      if (voiceRecordingRef.current || isVoiceCaptureActive()) return
      savedDraftBeforeVoiceRef.current = text
      setVoiceRecording(true)
      setVoiceStreaming(true)
      setVoiceBusy(false)
    }
    const onVoiceSessionEnd = (ev: Event) => {
      const detail = (ev as CustomEvent<{ cancelled?: boolean }>).detail || {}
      void hideVoiceInputOverlay()
      setVoiceRecording(false)
      setVoiceStreaming(false)
      setVoiceBusy(false)
      voiceStartingRef.current = false
      pendingStopRef.current = false
      voiceStartSourceRef.current = null
      if (detail.cancelled) {
        const restore = savedDraftBeforeVoiceRef.current
        savedDraftBeforeVoiceRef.current = ''
        if (restore) setTextAndNotify(restore)
      } else {
        savedDraftBeforeVoiceRef.current = ''
        setTextAndNotify('')
      }
    }
    window.addEventListener(VOICE_CAPTURE_SESSION_BEGIN, onVoiceSessionBegin)
    window.addEventListener(VOICE_CAPTURE_SESSION_END, onVoiceSessionEnd)
    return () => {
      window.removeEventListener(VOICE_CAPTURE_SESSION_BEGIN, onVoiceSessionBegin)
      window.removeEventListener(VOICE_CAPTURE_SESSION_END, onVoiceSessionEnd)
    }
  }, [onVoiceTranscribed, setTextAndNotify, speechEnabled, text])

  useEffect(() => {
    return () => {
      cancelVoiceCapture()
    }
  }, [])

  const applyComposeAttach = useCallback(
    (result: ComposeAttachResult, opts?: { insertUrls?: boolean; keepPlainText?: string }) => {
      if (result.contextFiles.length) {
        if (onAttachContextFiles) {
          onAttachContextFiles(result.contextFiles)
          setPendingContextBoost((n) => n + result.contextFiles.length)
        } else if (workspaceMention?.onAttachFile) {
          for (const f of result.contextFiles) {
            workspaceMention.onAttachFile({ path: f.path, name: f.name })
          }
          setPendingContextBoost((n) => n + result.contextFiles.length)
        }
      }
      if (result.blobFiles.length) {
        // Tauri 粘贴/拖入的无路径 File blob 也进 pendingFiles：
        // 让图片显示缩略图预览、可点击放大，非图片显示文件 chip
        setPendingFiles((p) => [...p, ...result.blobFiles])
      }
      if (opts?.insertUrls && result.urls.length) {
        setText((prev) => {
          const next = appendUrlsToDraft(prev, result.urls)
          onDraftChange(next)
          return next
        })
      }
      if (opts?.keepPlainText) {
        const extra = opts.keepPlainText
        if (extra && !looksLikeLocalPath(extra.trim())) {
          setText((prev) => {
            const next = prev ? `${prev}${extra}` : extra
            onDraftChange(next)
            return next
          })
        }
      }
    },
    [onAttachContextFiles, onDraftChange, workspaceMention],
  )

  /** 桌面端：Tauri WebView 的 paste 事件不暴露剪贴板图片为 File，需走原生命令读取 */
  const readClipboardImagePaste = useCallback(async () => {
    if (!isTauri) return null
    try {
      return await api.readClipboardImage()
    } catch {
      return null
    }
  }, [])

  /** 与首页工作台输入框共用同一套「解析→分发」逻辑（createComposeAttachHandlers），
   *  仅分发回调不同：这里走 applyComposeAttach 把 contextFiles 分派给父级/workspace mention，
   *  blobFiles 进 pendingFiles（图片预览卡片），链接与纯文本回填草稿。 */
  const { handlePaste, handleDrop, handleDragOver } = useMemo(
    () =>
      createComposeAttachHandlers(
        {
          onContextFiles: (files) =>
            applyComposeAttach({
              contextFiles: files,
              blobFiles: [],
              urls: [],
              plainText: '',
              handled: true,
            }),
          onBlobFiles: (files) =>
            applyComposeAttach({
              contextFiles: [],
              blobFiles: files,
              urls: [],
              plainText: '',
              handled: true,
            }),
          onUrls: (urls) =>
            setText((prev) => {
              const next = appendUrlsToDraft(prev, urls)
              onDraftChange(next)
              return next
            }),
          onPlainText: (text) =>
            setText((prev) => {
              const extra = text && !looksLikeLocalPath(text.trim()) ? text : ''
              if (!extra) return prev
              const next = prev ? `${prev}${extra}` : extra
              onDraftChange(next)
              return next
            }),
          onUnhandledPasteSync: (value) => {
            setText((prev) => {
              if (prev === value) return prev
              onDraftChange(value)
              return value
            })
            const ta = textareaRef.current
            if (ta) {
              const pos = ta.selectionStart ?? value.length
              setCursor(pos)
              scheduleEnhanceAnchor()
            }
          },
        },
        { insertUrlsOnDrop: true, readClipboardImage: readClipboardImagePaste },
      ),
    [applyComposeAttach, onDraftChange, scheduleEnhanceAnchor, readClipboardImagePaste],
  )

  function syncCursor() {
    const ta = textareaRef.current
    if (ta) {
      const pos = ta.selectionStart ?? 0
      setCursor(pos)
      if (showEnhanceBtn) scheduleEnhanceAnchor()
    }
  }

  return (
    <footer
      className="react-chat-composer"
      onDrop={handleDrop}
      onDragOver={handleDragOver}
    >
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        multiple
        className="react-chat-file-input"
        onChange={(e) => {
          const list = [...(e.target.files || [])]
          if (list.length) setPendingFiles((p) => [...p, ...list])
          e.target.value = ''
        }}
      />
      <input
        ref={docFileRef}
        type="file"
        multiple
        className="react-chat-file-input"
        onChange={(e) => {
          const list = [...(e.target.files || [])]
          if (list.length) setPendingFiles((p) => [...p, ...list])
          e.target.value = ''
        }}
      />

      {pendingFiles.length > 0 && (
        <div className="react-chat-composer-files">
          {(() => {
            // 图片和非图片分开渲染：图片用大预览卡片，非图片保持小 chip
            const imageIndices = pendingFiles
              .map((f, i) => ({ f, i }))
              .filter(({ f }) => f.type.startsWith('image/'))
            const nonImageIndices = pendingFiles
              .map((f, i) => ({ f, i }))
              .filter(({ f }) => !f.type.startsWith('image/'))

            return (
              <>
                {imageIndices.length > 0 && (
                  <div className="react-chat-image-preview-grid">
                    {imageIndices.map(({ f, i }) => (
                      <div
                        key={`${f.name}-${f.size}-${f.lastModified}-${i}`}
                        className="react-chat-image-preview-card"
                        onClick={() => setImagePreviewIndex(imageIndices.findIndex((x) => x.i === i))}
                        role="button"
                        tabIndex={0}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            setImagePreviewIndex(imageIndices.findIndex((x) => x.i === i))
                          }
                        }}
                      >
                        <ObjectUrlImg file={f} alt={f.name} className="react-chat-image-preview-card-thumb" />
                        <div className="react-chat-image-preview-card-name">{f.name}</div>
                        <button
                          type="button"
                          className="react-chat-image-preview-card-x"
                          onClick={(e) => {
                            e.stopPropagation()
                            setPendingFiles((p) => p.filter((_, j) => j !== i))
                          }}
                          aria-label="移除"
                        >
                          ×
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                {nonImageIndices.map(({ f, i }) => (
                  <span key={`${f.name}-${f.size}-${f.lastModified}-${i}`} className="react-chat-file-chip">
                    <span className="react-chat-file-chip-name">{f.name}</span>
                    <button
                      type="button"
                      className="react-chat-file-chip-x"
                      onClick={() => setPendingFiles((p) => p.filter((_, j) => j !== i))}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </>
            )
          })()}
        </div>
      )}
      {imagePreviewIndex !== null && pendingFiles.some((f) => f.type.startsWith('image/')) ? (
        (() => {
          const imageItems: ImagePreviewItem[] = pendingFiles
            .filter((f) => f.type.startsWith('image/'))
            .map((f) => ({ file: f, name: f.name }))
          const safeIndex = Math.min(imagePreviewIndex, imageItems.length - 1)
          return (
            <ImagePreviewModal
              images={imageItems}
              index={safeIndex}
              onClose={() => setImagePreviewIndex(null)}
              onRemove={(idx) => {
                const imageFileToRemove = pendingFiles.filter((f) => f.type.startsWith('image/'))[idx]
                if (imageFileToRemove) {
                  const realIdx = pendingFiles.indexOf(imageFileToRemove)
                  if (realIdx >= 0) setPendingFiles((p) => p.filter((_, j) => j !== realIdx))
                }
                if (imageItems.length <= 1) setImagePreviewIndex(null)
              }}
            />
          )
        })()
      ) : null}
      {pendingSendQueue.length > 0 ? (
        <div className="react-chat-pending-send" aria-label="等待发送">
          <div className="react-chat-pending-steers__header react-chat-pending-steers__header--queue">
            <span className="react-chat-pending-steers__title">
              回合结束后发送{pendingSendQueue.length > 1 ? `（${pendingSendQueue.length}）` : ''}
            </span>
            <span className="react-chat-pending-steers__hint">Enter 排队 · ↑ / 空 Enter 立即纠偏</span>
          </div>
          {pendingSendQueue.map((item, index) => (
            <div key={item.id} className="react-chat-pending-send__row">
              <span className="react-chat-pending-send__badge">
                排队{pendingSendQueue.length > 1 ? ` ${index + 1}` : ''}
              </span>
              <input
                type="text"
                className="react-chat-pending-send__input"
                value={item.text}
                placeholder="点击修改排队内容…"
                aria-label={`编辑等待发送第 ${index + 1} 条`}
                onChange={(e) => onEditPendingSend?.(item.id, e.target.value)}
                onKeyDown={(e) => {
                  // 编辑中 Enter 只确认改完，不立刻打断发送（避免误触）
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    ;(e.currentTarget as HTMLInputElement).blur()
                  }
                  if (e.key === 'Escape') {
                    e.preventDefault()
                    onCancelPendingSend?.(item.id)
                  }
                }}
              />
              <button
                type="button"
                className="react-chat-pending-send__flush"
                title="立即注入（下次工具前，不打断）"
                aria-label="立即注入当前对话"
                onClick={() => onFlushPendingSend?.(item.id)}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" width="16" height="16" aria-hidden="true">
                  <path d="M12 19V5" strokeLinecap="round" />
                  <path d="M5 12l7-7 7 7" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
              <button
                type="button"
                className="react-chat-pending-send__cancel"
                title="取消"
                aria-label="取消等待发送"
                onClick={() => onCancelPendingSend?.(item.id)}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      ) : null}
      <div className="react-chat-composer-top-row">
        <div className="react-chat-input-wrap">
          <WorkspaceMentionMenu
            open={mentionOpen}
            loading={mentionLoading}
            query={mentionRange?.query ?? ''}
            type={mentionRange?.type ?? null}
            items={mentionItems}
            activeIndex={mentionActive}
            onPick={applyMentionPick}
            onActiveIndexChange={setMentionActive}
          />
          <textarea
            ref={textareaRef}
            className={`react-chat-input${voiceRecording ? ' react-chat-input--dictating' : ''}`}
            rows={2}
            value={text}
            placeholder={
              voiceRecording
                ? '聆听中…再点话筒发送'
                : !engineReady
                  ? 'Agent 引擎加载中，就绪后即可发送…'
                  : streaming || sending
                    ? pendingSendQueue.length
                      ? '已排队 · ↑ 或空 Enter 立即纠偏，有内容再 Enter 继续排队…'
                      : 'Enter 排队，回合结束后自动发送…'
                    : placeholder
            }
            disabled={!sessionReady}
            onFocus={() => onComposerWarmup?.()}
            onChange={(e) => {
              setTextAndNotify(e.target.value)
              const pos = e.target.selectionStart ?? 0
              setCursor(pos)
              scheduleEnhanceAnchor()
            }}
            onInput={(e) => {
              // 粘贴后 DOM 与受控 state 偶发不同步，以 DOM 为准再写回
              const v = e.currentTarget.value
              setText((prev) => {
                if (prev === v) return prev
                onDraftChange(v)
                return v
              })
              const pos = e.currentTarget.selectionStart ?? 0
              setCursor(pos)
              scheduleEnhanceAnchor()
            }}
            onClick={syncCursor}
            onKeyUp={syncCursor}
            onSelect={syncCursor}
            onPaste={handlePaste}
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onKeyDown={(e) => {
              if (mentionOpen && mentionItems.length > 0) {
                if (e.key === 'ArrowDown') {
                  e.preventDefault()
                  setMentionActive((i) => (i + 1) % mentionItems.length)
                  return
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault()
                  setMentionActive((i) => (i - 1 + mentionItems.length) % mentionItems.length)
                  return
                }
                if (e.key === 'Enter' || e.key === 'Tab') {
                  e.preventDefault()
                  const item = mentionItems[mentionActive]
                  if (item) applyMentionPick(item)
                  return
                }
              }
              if (e.key === 'Escape' && mentionOpen) {
                e.preventDefault()
                closeMention()
                return
              }
              // 已排队：↑（光标在开头）→ 提升为下次工具前纠偏
              if (
                e.key === 'ArrowUp' &&
                !mentionOpen &&
                (streaming || sending) &&
                pendingSendQueue[0] &&
                onFlushPendingSend
              ) {
                const ta = textareaRef.current
                const atStart =
                  !ta || (ta.selectionStart === 0 && ta.selectionEnd === 0)
                if (atStart) {
                  e.preventDefault()
                  onFlushPendingSend(pendingSendQueue[0].id)
                  return
                }
              }
              // 兼容：忙时 Tab 仍可排队（与 Enter 相同）
              if (
                e.key === 'Tab' &&
                !e.shiftKey &&
                !mentionOpen &&
                (streaming || sending) &&
                onQueueWhileBusy
              ) {
                e.preventDefault()
                const draft = String(textareaRef.current?.value ?? text).trim()
                if (draft) {
                  onQueueWhileBusy(draft)
                  setTextAndNotify('')
                  closeMention()
                }
                return
              }
              // runtime Esc while running: steers → interrupt+send; else plain interrupt
              if (e.key === 'Escape' && (streaming || sending) && !mentionOpen) {
                e.preventDefault()
                if (pendingSteers.length > 0 && onInterruptAndSendSteers) {
                  onInterruptAndSendSteers()
                } else {
                  void onAbort()
                }
                return
              }
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void handleSend()
              }
            }}
          />
          {showEnhanceBtn && enhanceAnchor ? (
            <button
              type="button"
              className={`react-chat-icon-enhance-btn react-chat-icon-enhance-btn--floating${
                enhancing ? ' react-chat-icon-enhance-btn--loading' : ''
              }`}
              style={{ left: enhanceAnchor.left, top: enhanceAnchor.top }}
              disabled={enhancing}
              onClick={() => void handleEnhancePrompt()}
              title="优化提示词"
              aria-label="优化提示词"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                width="18"
                height="18"
                aria-hidden="true"
              >
                <path d="M15 4V2" />
                <path d="M15 4l2 2" />
                <path d="M15 4l-2 2" />
                <path d="m10.5 9.5-7 7a2.12 2.12 0 1 0 3 3l7-7" />
                <path d="m18 16 1-1" />
                <path d="m21.5 10.5 1-1" />
                <path d="M9 6l1-1" />
              </svg>
            </button>
          ) : null}
        </div>
        <div className="react-chat-composer-actions">
          {speechEnabled && onVoiceTranscribed ? (
            <button
              type="button"
              className={`react-chat-icon-voice-btn${
                voiceRecording ? ' react-chat-icon-voice-btn--recording' : ''
              }${voiceBusy ? ' react-chat-icon-voice-btn--busy' : ''}`}
              disabled={!sessionReady || streaming || sending || voiceBusy}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                if (voiceBusy) return
                if (voiceRecording || isVoiceCaptureActive()) {
                  void stopVoiceRecordingAndSend()
                } else {
                  void startVoiceRecording('mic')
                }
              }}
              title={`${micVoiceHintText()}；${voiceShortcutHintText()}`}
              aria-label="语音输入"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18" aria-hidden="true">
                <path d="M12 1a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                <path d="M19 10v1a7 7 0 0 1-14 0v-1" />
                <line x1="12" y1="19" x2="12" y2="23" />
                <line x1="8" y1="23" x2="16" y2="23" />
              </svg>
            </button>
          ) : null}
          {ttsSpeaking && !voiceRecording && !voiceBusy ? (
            <button
              type="button"
              className="react-chat-icon-stop-tts-btn"
              onClick={() => {
                void import('../../lib/speech-client.js').then(({ stopAllAssistantSpeech }) =>
                  stopAllAssistantSpeech(),
                )
                // 通知持续监听模式恢复 ASR（若 TTS 曾挂起 mic）
                void import('../../lib/background-voice.js').then(({ notifyTTSStopped }) =>
                  notifyTTSStopped(),
                )
              }}
              title="停止播报"
              aria-label="停止播报"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18" aria-hidden="true">
                <path d="M11 5 6 9H2v6h4l5 4V5z" />
                <line x1="22" y1="9" x2="16" y2="15" />
                <line x1="16" y1="9" x2="22" y2="15" />
              </svg>
            </button>
          ) : null}
          {streaming || sending ? (
            <>
              {pendingSendQueue[0] ? (
                <button
                  type="button"
                  className="react-chat-icon-flush-btn"
                  onClick={() => onFlushPendingSend?.(pendingSendQueue[0].id)}
                  title="立即注入排队消息（下次工具前）"
                  aria-label="立即注入排队消息"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" width="18" height="18" aria-hidden="true">
                    <path d="M12 19V5" strokeLinecap="round" />
                    <path d="M5 12l7-7 7 7" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              ) : null}
              <button
                type="button"
                className="react-chat-icon-stop-btn"
                onClick={() => void onAbort()}
                title="停止"
              >
                <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18" aria-hidden="true">
                  <rect x="6" y="6" width="12" height="12" rx="2" />
                </svg>
              </button>
            </>
          ) : (
            <button
              type="button"
              className="react-chat-icon-send-btn"
              disabled={!sessionReady || !engineReady}
              onClick={() => {
                const live = String(textareaRef.current?.value ?? text).trim()
                if (pendingSendQueue[0] && !live && !pendingFiles.length) {
                  onFlushPendingSend?.(pendingSendQueue[0].id)
                  return
                }
                void handleSend()
              }}
              title={engineReady ? '发送（Enter）' : 'Agent 引擎加载中…'}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18" aria-hidden="true">
                <line x1="22" y1="2" x2="11" y2="13" />
                <polygon points="22 2 15 22 11 13 2 9 22 2" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {renderBottomControls ? (
        <div className="react-chat-composer-bottom-row">
          {renderBottomControls({ pickFiles, pickDocFiles, insertText })}
        </div>
      ) : null}
    </footer>
  )
})
