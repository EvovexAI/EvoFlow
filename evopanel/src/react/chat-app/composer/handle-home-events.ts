/**
 * Home dashboard custom events → chat send / model / memory / voice.
 * Extracted from ChatApp.tsx (P69).
 */
import { patchPanelSettings } from '../../../lib/panel-settings.js'
import { STORAGE_MODEL_KEY } from '../utils/storage.js'
import type { ChatAttachment } from '../../chat-types.js'
import type { ContextFileEntry } from '../../components/WorkspaceFileTree.js'

export type HomeSkillSelection = { name?: string; [k: string]: unknown }
export type HomePluginSelection = { id?: string; [k: string]: unknown }

export type HandleHomeEventsCtx = {
  sessionRef: { current: string }
  setSessionHadContent: (v: boolean) => void
  setPreferHomeDashboard?: (v: boolean) => void
  setSelectedSkills: (skills: HomeSkillSelection[]) => void
  setSelectedPlugins: (plugins: HomePluginSelection[]) => void
  setModelName: (name: string) => void
  setMemoryEnabled: (enabled: boolean) => void
  setVoiceReplyEnabled: (enabled: boolean) => void
  ensureChatSessionKey: () => Promise<string | null>
  attachContextFiles: (files: ContextFileEntry[]) => void
  updateSessionContext: (
    sessionKey: string,
    patch: Record<string, unknown>,
  ) => Promise<unknown>
  handleSend: (
    text: string,
    attachments?: ChatAttachment[],
    ctxFiles?: ContextFileEntry[],
    opts?: {
      skillsOverride?: HomeSkillSelection[]
      pluginsOverride?: HomePluginSelection[]
      leaveHomeOnPaint?: boolean
      beforeWire?: () => Promise<unknown>
    },
  ) => Promise<unknown> | unknown
}

type HomeSendDetail = {
  text?: string
  agentCode?: string
  skills?: HomeSkillSelection[]
  plugins?: HomePluginSelection[]
  modelName?: string
  attachments?: ChatAttachment[]
  contextFiles?: ContextFileEntry[]
}

export function handleHomeSendEvent(ctx: HandleHomeEventsCtx, event: Event): void {
  const detail = (event as CustomEvent<HomeSendDetail>).detail
  const text = String(detail?.text || '').trim()
  const attachments = Array.isArray(detail?.attachments) ? detail.attachments : undefined
  const homeCtx = Array.isArray(detail?.contextFiles)
    ? detail.contextFiles.filter((f) => String(f?.path || '').trim())
    : []
  if (!text && !attachments?.length && !homeCtx.length) return
  // 离开首页与画出用户气泡在 handleSend 同帧（leaveHomeOnPaint）；
  // agent/model 写入放到 beforeWire，先看见气泡再等上下文，避免「停在首页干等」。
  void (async () => {
    if (Array.isArray(detail?.skills)) ctx.setSelectedSkills(detail.skills)
    if (Array.isArray(detail?.plugins)) ctx.setSelectedPlugins(detail.plugins)
    const modelName = String(detail?.modelName || '').trim()
    if (modelName) {
      ctx.setModelName(modelName)
      try {
        localStorage.setItem(STORAGE_MODEL_KEY, modelName)
      } catch {
        /* ignore */
      }
      void patchPanelSettings({ lastSelectedModel: modelName })
    }
    // 先确保会话；agent/model 与发送并行准备，等乐观气泡后再 await（beforeWire）
    const sk =
      (ctx.sessionRef.current || '').trim() || (await ctx.ensureChatSessionKey()) || ''
    const code = String(detail?.agentCode || '').trim().toLowerCase()
    const prep: Promise<unknown>[] = []
    if (sk && code) {
      prep.push(
        (async () => {
          try {
            const { api } = await import('../../../lib/tauri-api.js')
            if (code === 'claude-code') {
              await api.chatUpdateContext(sk, {
                use_claude_code_chat: true,
                agent_name: 'claude-code',
                collab_phase: 'idle',
                collab_task_id: null,
              })
            } else if (code === 'main') {
              await api.chatUpdateContext(sk, {
                use_claude_code_chat: false,
                agent_name: 'main',
                agent_id: 'main',
                collab_phase: 'idle',
                collab_task_id: null,
              })
            } else {
              await api.chatUpdateContext(sk, {
                use_claude_code_chat: false,
                agent_name: code,
                agent_id: code,
                collab_phase: 'idle',
                collab_task_id: null,
              })
            }
          } catch {
            /* ignore — still send */
          }
        })(),
      )
    }
    if (sk && modelName) {
      prep.push(ctx.updateSessionContext(sk, { model_name: modelName }).catch(() => undefined))
    }
    if (homeCtx.length) ctx.attachContextFiles(homeCtx)
    const prepAll = prep.length ? Promise.all(prep) : Promise.resolve()
    await ctx.handleSend(text, attachments, homeCtx.length ? homeCtx : undefined, {
      skillsOverride: Array.isArray(detail?.skills) ? detail.skills : undefined,
      pluginsOverride: Array.isArray(detail?.plugins) ? detail.plugins : undefined,
      leaveHomeOnPaint: true,
      beforeWire: () => prepAll,
    })
  })()
}

export function handleHomeSelectModelEvent(ctx: HandleHomeEventsCtx, event: Event): void {
  const modelName = String(
    (event as CustomEvent<{ modelName?: string }>).detail?.modelName || '',
  ).trim()
  if (!modelName) return
  ctx.setModelName(modelName)
  // 仅当已有会话时写回 context；工作台空草稿不 createSession（发消息时再建）。
  void (async () => {
    try {
      const sk = (ctx.sessionRef.current || '').trim()
      if (sk) await ctx.updateSessionContext(sk, { model_name: modelName })
    } catch {
      /* ignore */
    }
  })()
}

export function handleHomeSetMemoryEvent(ctx: HandleHomeEventsCtx, event: Event): void {
  const enabled = (event as CustomEvent<{ enabled?: boolean }>).detail?.enabled
  if (typeof enabled !== 'boolean') return
  ctx.setMemoryEnabled(enabled)
}

export function handleHomeSetVoiceReplyEvent(ctx: HandleHomeEventsCtx, event: Event): void {
  const enabled = (event as CustomEvent<{ enabled?: boolean }>).detail?.enabled
  if (typeof enabled !== 'boolean') return
  ctx.setVoiceReplyEnabled(enabled)
}
