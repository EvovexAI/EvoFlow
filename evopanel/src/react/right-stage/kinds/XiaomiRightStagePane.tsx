/**
 * 小V = right-stage 普通标签页（与 browser / file / workflow 同级）。
 * 对话体 + 输入区对齐主聊 / 员工侧栏（V4 + ChatComposer）；
 * 「+」快捷面板复用主聊 PluginQuickPanel；页面上下文 / 语音模式仍是小V 专属。
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react'
import { XiaomiChatThread } from '../../components/XiaomiChatThread.js'
import { ChatComposer } from '../../components/ChatComposer.js'
import { PluginQuickPanel } from '../../components/PluginQuickPanel.js'
import { SkillPickerModal } from '../../components/SkillPickerModal.js'
import { useComposerSkillPluginSelection } from '../../hooks/useComposerSkillPluginSelection.js'
import type { ChatAttachment } from '../../chat-types.js'
import {
  getState,
  subscribe,
  setContactDraft,
  patchState,
} from '../../../components/global-assistant/assistant-store.js'
import {
  ensureXiaomiSession,
  bindXiaomiStreamListener,
  sendXiaomiChat,
  stopXiaomiChat,
  startXiaomiNewRound,
  startXiaomiNewChat,
  refreshXiaomiSessionList,
  switchXiaomiSession,
} from '../../../components/global-assistant/assistant-session.js'
import { enterXwVoiceMode } from '../../../lib/xw-voice-mode.js'
import { toast } from '../../../components/toast.js'
import { navigate } from '../../../router.js'
import './xiaomi-voice-stage.css'

type HistRow = { key: string; title: string; updatedAt?: number; messageCount?: number }

export function XiaomiRightStagePane() {
  const st0 = getState()
  const [sessionKey, setSessionKey] = useState(() => String(st0.sessionKey || ''))
  const [draftVersion, setDraftVersion] = useState(0)
  const [streaming, setStreaming] = useState(() => !!st0.streaming)
  const [busy, setBusy] = useState(false)
  const [histOpen, setHistOpen] = useState(false)
  const [sessions, setSessions] = useState<HistRow[]>(() =>
    Array.isArray(st0.xiaomiSessions) ? st0.xiaomiSessions : [],
  )
  const [histLoading, setHistLoading] = useState(false)
  const [optimisticUserText, setOptimisticUserText] = useState<string | null>(null)
  const draftRef = useRef(String(st0.draft || ''))
  const sessionKeyRef = useRef(sessionKey)
  const moreTriggerRef = useRef<HTMLButtonElement | null>(null)
  const pickFilesRef = useRef<() => void>(() => {})
  const pickDocFilesRef = useRef<() => void>(() => {})

  const plugins = useComposerSkillPluginSelection({ selectedSessionKey: sessionKey })
  const {
    bottomPluginPanelOpen,
    setBottomPluginPanelOpen,
    pluginPanelStyle,
    setPluginPanelStyle,
    pluginList,
    pluginListLoading,
    selectedPlugins,
    setSelectedPlugins,
    persistSelectedPlugins,
    bottomSkillOpen,
    setBottomSkillOpen,
    skillList,
    skillListLoading,
    selectedSkills,
    setSelectedSkills,
    persistSelectedSkills,
  } = plugins

  useEffect(() => {
    void (async () => {
      try {
        // openXiaomiRightStage 已后台 ensure；这里有 key 就别再强制拉历史
        const hasKey = !!String(getState().sessionKey || '').trim()
        await ensureXiaomiSession({ reloadHistory: !hasKey })
        bindXiaomiStreamListener()
      } catch (e) {
        console.warn('[xiaomi-stage] session', e)
      }
    })()
    const unsub = subscribe(() => {
      const s = getState()
      const nextKey = String(s.sessionKey || '')
      const nextDraft = String(s.draft || '')
      if (nextKey !== sessionKeyRef.current) {
        sessionKeyRef.current = nextKey
        setSessionKey(nextKey)
        draftRef.current = nextDraft
        setDraftVersion((v) => v + 1)
        setOptimisticUserText(null)
      } else if (nextDraft !== draftRef.current) {
        // 外部写 draft（快捷 chip 清空等）时同步进 ChatComposer
        draftRef.current = nextDraft
        setDraftVersion((v) => v + 1)
      }
      setStreaming(!!s.streaming)
      setSessions(Array.isArray(s.xiaomiSessions) ? s.xiaomiSessions : [])
      setHistLoading(!!s.xiaomiSessionsLoading)
      if (!s.streaming) {
        setOptimisticUserText(null)
      }
    })
    return () => {
      unsub()
    }
  }, [])

  // 「+」面板定位：锚定加号按钮上方（右栏底栏同主聊）
  useLayoutEffect(() => {
    if (!bottomPluginPanelOpen || typeof window === 'undefined') {
      setPluginPanelStyle(null)
      return
    }
    const update = () => {
      const btn = moreTriggerRef.current
      if (!btn) return
      const r = btn.getBoundingClientRect()
      const gap = 10
      const sidePad = 10
      const width = 420
      const left = Math.max(sidePad, Math.min(r.left, window.innerWidth - sidePad - width))
      const bottom = Math.max(sidePad, window.innerHeight - r.top + gap)
      const maxH = Math.max(160, Math.min(window.innerHeight * 0.62, r.top - gap - sidePad))
      setPluginPanelStyle({
        position: 'fixed',
        left,
        bottom,
        top: 'auto',
        maxHeight: maxH,
        zIndex: 10060,
      } satisfies CSSProperties)
    }
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [bottomPluginPanelOpen, setPluginPanelStyle])

  const onDraftChange = useCallback((value: string) => {
    draftRef.current = value
    setContactDraft('xiaomi', value, { silent: true })
  }, [])

  const insertComposerText = useCallback(
    (text: string) => {
      const cur = String(draftRef.current || '')
      const next = `${cur}${text}`
      draftRef.current = next
      setContactDraft('xiaomi', next, { silent: true })
      setDraftVersion((v) => v + 1)
    },
    [],
  )

  const handleSend = useCallback(
    async (message: string, attachments?: ChatAttachment[]) => {
      const text = String(message || '').trim()
      const files = Array.isArray(attachments) ? attachments : []
      if ((!text && !files.length) || streaming || busy) return
      setBusy(true)
      setOptimisticUserText(text || (files.length ? `（${files.length} 个附件）` : ''))
      try {
        // assistant-session.js：ctx.attachments → chatSend 第三参
        await sendXiaomiChat(text || '请查看附件', { attachments: files } as never)
        draftRef.current = ''
        setContactDraft('xiaomi', '', { silent: true })
        setDraftVersion((v) => v + 1)
      } catch (e) {
        setOptimisticUserText(null)
        toast(String((e as Error)?.message || e || '发送失败'), 'error')
      } finally {
        setBusy(false)
      }
    },
    [streaming, busy],
  )

  const handleAbort = useCallback(async () => {
    try {
      await stopXiaomiChat()
    } catch {
      /* ignore */
    }
  }, [])

  const onNewRound = useCallback(async () => {
    try {
      await startXiaomiNewRound()
      toast('已新开一轮', 'success')
    } catch (e) {
      toast(String((e as Error)?.message || e || '新开一轮失败'), 'error')
    }
  }, [])

  const onNewChat = useCallback(async () => {
    try {
      await startXiaomiNewChat()
      setHistOpen(false)
      toast('已新开对话', 'success')
    } catch (e) {
      toast(String((e as Error)?.message || e || '新开对话失败'), 'error')
    }
  }, [])

  const onToggleHistory = useCallback(async () => {
    const next = !histOpen
    setHistOpen(next)
    patchState({ sessionHistoryOpen: next }, { silent: true })
    if (next) {
      try {
        await refreshXiaomiSessionList()
      } catch {
        /* ignore */
      }
    }
  }, [histOpen])

  const onSelectSession = useCallback(async (key: string) => {
    try {
      await switchXiaomiSession(key)
      setHistOpen(false)
      toast('已切换会话', 'success')
    } catch (e) {
      toast(String((e as Error)?.message || e || '切换失败'), 'error')
    }
  }, [])

  const sendGuide = useCallback(
    async (prompt: string) => {
      const text = String(prompt || '').trim()
      if (!text || streaming || busy) return
      draftRef.current = ''
      setContactDraft('xiaomi', '', { silent: true })
      setDraftVersion((v) => v + 1)
      setBusy(true)
      setOptimisticUserText(text)
      try {
        await sendXiaomiChat(text)
      } catch (e) {
        setOptimisticUserText(null)
        toast(String((e as Error)?.message || e || '发送失败'), 'error')
      } finally {
        setBusy(false)
      }
    },
    [streaming, busy],
  )

  const turnBusy = streaming || busy

  const composerDock = useMemo(
    () => (
      <div
        className="v4-xiaomi-composer border-t border-border bg-card px-2 pb-2 pt-1"
        data-v4-xiaomi-composer-host="true"
      >
        <ChatComposer
          // sendXiaomiChat 内会 ensureSession；勿因 key 尚未回写而锁死输入
          sessionReady
          engineReady
          initialDraft={draftRef.current}
          draftVersion={draftVersion}
          onDraftChange={onDraftChange}
          sending={turnBusy}
          streaming={turnBusy}
          onSend={handleSend}
          onAbort={handleAbort}
          placeholder="问进度、查知识、安排任务…"
          speechEnabled={false}
          bottomMoreTriggerRef={moreTriggerRef}
          onOpenAttachmentMenu={() => {
            setBottomPluginPanelOpen((prev) => !prev)
          }}
          renderBottomControls={({ pickFiles, pickDocFiles }) => {
            pickFilesRef.current = pickFiles
            pickDocFilesRef.current = pickDocFiles
            return null
          }}
          renderTrailingControls={() => (
            <button
              type="button"
              className="react-chat-icon-attach-btn"
              onClick={() => enterXwVoiceMode()}
              title="进入语音模式"
              aria-label="进入语音模式"
            >
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden="true">
                <rect x="9" y="3" width="6" height="11" rx="3" fill="currentColor" />
                <path
                  d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M9 21h6"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          )}
        />
      </div>
    ),
    [
      draftVersion,
      onDraftChange,
      turnBusy,
      handleSend,
      handleAbort,
      setBottomPluginPanelOpen,
    ],
  )

  return (
    <div className="xm-stage-pane" data-stage-kind-body="xiaomi">
      <div className="xm-stage-toolbar" role="toolbar" aria-label="小V 操作">
        <div className="xm-stage-toolbar-chips">
          <button
            type="button"
            className="xm-stage-chip is-voice-enter"
            onClick={() => enterXwVoiceMode()}
            title="进入语音模式（接管整窗）"
          >
            语音模式
          </button>
          <button
            type="button"
            className="xm-stage-chip"
            onClick={() => void sendGuide('帮我看看员工进度，谁在忙、谁空闲')}
            title="问进度"
          >
            问进度
          </button>
          <button
            type="button"
            className="xm-stage-chip"
            onClick={() => void sendGuide('我想派一个任务给合适的员工')}
            title="派活"
          >
            派活
          </button>
          <button
            type="button"
            className="xm-stage-chip"
            onClick={() => navigate('/knowledge')}
            title="知识库"
          >
            知识库
          </button>
        </div>
        <div className="xm-stage-toolbar-actions">
          <div className={`xm-stage-hist${histOpen ? ' is-open' : ''}`}>
            <button
              type="button"
              className="xm-stage-icon-btn"
              onClick={() => void onToggleHistory()}
              title="历史对话"
              aria-label="历史对话"
              aria-expanded={histOpen}
            >
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                <path d="M3 3v5h5" />
                <path d="M12 7v5l4 2" />
              </svg>
            </button>
            {histOpen ? (
              <div className="xm-stage-hist-menu" role="menu">
                <div className="xm-stage-hist-head">历史对话</div>
                {histLoading ? (
                  <div className="xm-stage-hist-empty">加载中…</div>
                ) : sessions.length ? (
                  sessions.map((s) => (
                    <button
                      key={s.key}
                      type="button"
                      role="menuitem"
                      className={`xm-stage-hist-item${s.key === sessionKey ? ' is-active' : ''}`}
                      onClick={() => void onSelectSession(s.key)}
                    >
                      <span className="xm-stage-hist-title">{s.title || '未命名'}</span>
                      {s.messageCount ? (
                        <span className="xm-stage-hist-meta">{s.messageCount} 条</span>
                      ) : null}
                    </button>
                  ))
                ) : (
                  <div className="xm-stage-hist-empty">暂无历史对话</div>
                )}
              </div>
            ) : null}
          </div>
          <button type="button" className="xm-stage-icon-btn" onClick={() => void onNewChat()} title="新开对话">
            ＋
          </button>
          <button type="button" className="xm-stage-chip" onClick={() => void onNewRound()} title="新开一轮">
            新一轮
          </button>
        </div>
      </div>
      <div className="xm-stage-thread">
        <XiaomiChatThread
          sessionKey={sessionKey}
          optimisticUserText={optimisticUserText}
          bottomDock={composerDock}
          sessionBusy={turnBusy}
        />
      </div>

      <PluginQuickPanel
        open={bottomPluginPanelOpen}
        onClose={() => setBottomPluginPanelOpen(false)}
        style={pluginPanelStyle}
        plugins={pluginList}
        loading={pluginListLoading}
        selected={selectedPlugins}
        onToggle={(item) => {
          setSelectedPlugins((prev) => {
            const next = prev.some((p) => p.id === item.id)
              ? prev.filter((p) => p.id !== item.id)
              : [
                  ...prev,
                  {
                    id: item.id,
                    label: item.label || item.name,
                    iconUrl: item.iconUrl,
                  },
                ]
            void persistSelectedPlugins(String(sessionKey || ''), next)
            return next
          })
        }}
        onPickDocs={() => {
          setBottomPluginPanelOpen(false)
          pickDocFilesRef.current?.()
        }}
        onPickImages={() => {
          setBottomPluginPanelOpen(false)
          pickFilesRef.current?.()
        }}
        onOpenSkillPicker={() => {
          setBottomPluginPanelOpen(false)
          setBottomSkillOpen(true)
        }}
        onOpenGoal={() => {
          setBottomPluginPanelOpen(false)
          window.dispatchEvent(new CustomEvent('evopanel:open-goal-panel', { detail: { open: true } }))
        }}
        onOpenLegacyMenu={() => setBottomPluginPanelOpen(false)}
        onInsertText={(text) => insertComposerText(text)}
        showVoice
        voiceOn={false}
        onToggleVoice={() => {
          setBottomPluginPanelOpen(false)
          enterXwVoiceMode()
        }}
        showLegacyMenu={false}
        showHintBar={false}
        onPickEmployee={() => {
          setBottomPluginPanelOpen(false)
          navigate('/proactive')
          toast('其他 Agent 请在智能体员工里对话', 'info')
        }}
      />

      <SkillPickerModal
        open={bottomSkillOpen}
        onClose={() => setBottomSkillOpen(false)}
        skills={skillList}
        loading={skillListLoading}
        selected={selectedSkills}
        onConfirm={(next) => {
          setSelectedSkills(next)
          void persistSelectedSkills(String(sessionKey || ''), next)
          setBottomSkillOpen(false)
        }}
      />
    </div>
  )
}
