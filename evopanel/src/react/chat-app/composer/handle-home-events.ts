/**
 * Home dashboard custom events → chat send / model / memory / voice.
 * Extracted from ChatApp.tsx (P69).
 */
import { flushSync } from 'react-dom'
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
  // 立刻离开工作台表面，避免「发完还停在首页 → 再切会话 → 再出消息」的三段感
  flushSync(() => {
    ctx.setSessionHadContent(true)
    ctx.setPreferHomeDashboard?.(false)
  })
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
    // 先确保会话，再并行写 agent/model（静默，不走带 toast 的角色切换）
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
    if (prep.length) await Promise.all(prep)
    if (homeCtx.length) ctx.attachContextFiles(homeCtx)
    await ctx.handleSend(text, attachments, homeCtx.length ? homeCtx : undefined, {
      skillsOverride: Array.isArray(detail?.skills) ? detail.skills : undefined,
      pluginsOverride: Array.isArray(detail?.plugins) ? detail.plugins : undefined,
    })
  })()
}

export function handleHomeSelectModelEvent(ctx: HandleHomeEventsCtx, event: Event): void {
  const modelName = String(
    (event as CustomEvent<{ modelName?: string }>).detail?.modelName || '',
  ).trim()
  if (!modelName) return
  ctx.setModelName(modelName)
  void (async () => {
    try {
      const sk =
        (ctx.sessionRef.current || '').trim() || (await ctx.ensureChatSessionKey()) || ''
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
