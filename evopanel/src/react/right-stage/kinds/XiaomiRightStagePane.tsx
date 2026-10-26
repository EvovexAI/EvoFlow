/**
 * 小V = right-stage 普通标签页（与 browser / file / workflow 同级）。
 * 文字形态宿主；「语音」进入全局语音全屏模式（lib/xw-voice-mode.ts，接管整窗布局）。
 */
import { useCallback, useEffect, useState, type FormEvent, type KeyboardEvent } from 'react'
import { XiaomiChatThread } from '../../components/XiaomiChatThread.js'
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
  const [draft, setDraft] = useState(() => String(st0.draft || ''))
  const [streaming, setStreaming] = useState(() => !!st0.streaming)
  const [busy, setBusy] = useState(false)
  const [histOpen, setHistOpen] = useState(false)
  const [sessions, setSessions] = useState<HistRow[]>(() =>
    Array.isArray(st0.xiaomiSessions) ? st0.xiaomiSessions : [],
  )
  const [histLoading, setHistLoading] = useState(false)

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
      setSessionKey(String(s.sessionKey || ''))
      setDraft(String(s.draft || ''))
      setStreaming(!!s.streaming)
      setSessions(Array.isArray(s.xiaomiSessions) ? s.xiaomiSessions : [])
      setHistLoading(!!s.xiaomiSessionsLoading)
    })
    return () => {
      unsub()
    }
  }, [])

  const onDraftChange = useCallback((value: string) => {
    setDraft(value)
    setContactDraft('xiaomi', value, { silent: true })
  }, [])

  const onSend = useCallback(async () => {
    const text = String(draft || '').trim()
    if (!text || streaming || busy) return
    setBusy(true)
    try {
      await sendXiaomiChat(text)
      onDraftChange('')
    } catch (e) {
      toast(String((e as Error)?.message || e || '发送失败'), 'error')
    } finally {
      setBusy(false)
    }
  }, [draft, streaming, busy, onDraftChange])

  const onStop = useCallback(async () => {
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
      onDraftChange('')
      setBusy(true)
      try {
        await sendXiaomiChat(text)
      } catch (e) {
        toast(String((e as Error)?.message || e || '发送失败'), 'error')
      } finally {
        setBusy(false)
      }
    },
    [streaming, busy, onDraftChange],
  )

  const onSubmit = useCallback(
    (e: FormEvent) => {
      e.preventDefault()
      void onSend()
    },
    [onSend],
  )

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        void onSend()
      }
    },
    [onSend],
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
              aria-expanded={histOpen}
            >
              ⏱
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
        <XiaomiChatThread sessionKey={sessionKey} />
      </div>
      <form className="xm-stage-composer" onSubmit={onSubmit}>
        <textarea
          className="xm-stage-composer-input"
          rows={2}
          value={draft}
          placeholder="问进度、查知识、安排任务…"
          onChange={(e) => onDraftChange(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={busy && !streaming}
        />
        <div className="xm-stage-composer-bar">
          <button
            type="button"
            className="xws-composer-mic"
            onClick={() => enterXwVoiceMode()}
            title="语音模式"
            aria-label="进入语音模式"
          >
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" aria-hidden="true">
              <rect x="9" y="3" width="6" height="11" rx="3" fill="currentColor" />
              <path
                d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M9 21h6"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
          </button>
          {streaming ? (
            <button type="button" className="xm-stage-send is-stop" onClick={() => void onStop()}>
              停止
            </button>
          ) : (
            <button type="submit" className="xm-stage-send" disabled={!draft.trim() || busy}>
              发送
            </button>
          )}
        </div>
      </form>
    </div>
  )
}
