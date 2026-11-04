/**
 * 状态面板「智能体 / 员工」Tab：角色设定条
 * - 思考 / 记忆：员工写岗位 config；普通会话写本会话 context
 * - 识图不在此勾选：跟当前模型视觉能力走
 * - 记忆开：注入 memory/assets 上下文，并挂载 assets 工具（与「更多→记忆」同一闸）
 * - 系统提示词 / SOUL：同一框内 Tab 切换
 * - 员工职责已合并进 system_prompt（## 岗位职责），不再单独 Tab
 */
import { useCallback, useEffect, useState } from 'react'
import { toast } from '../../components/toast.js'
import { toUserFacingError } from '../../lib/user-facing-error.js'

/** 对外仍兼容旧三态；本面板 UI 只暴露开/关，展示为「生效态」 */
export type ThinkingPref = 'follow' | 'on' | 'off'
/** @deprecated 识图跟模型能力，面板不再暴露；保留类型以免外部 import 断裂 */
export type VisionPref = 'follow' | 'on' | 'off'
export type MemoryPref = 'follow' | 'on' | 'off'

export type AgentRolePrefsProps = {
  agentCode?: string
  /** 员工会话：岗位代号（与 agentCode 通常相同） */
  roleCode?: string
  /** 当前聊天 sessionKey；员工改偏好时同步到该会话 */
  sessionKey?: string
  isEmployee?: boolean
  /** 岗位/会话思考偏好；null=跟随默认（展示按模型能力推断生效态） */
  thinkingEnabled?: boolean | null
  /** 岗位/会话记忆总闸；null=默认开（注入记忆+资产 + assets 工具） */
  memoryEnabled?: boolean | null
  /** 当前模型是否支持思考（null 未知时，跟随默认按开展示） */
  modelSupportsThinking?: boolean | null
  /** @deprecated 职责已并入系统提示词，忽略 */
  responsibilities?: string[]
  /** 普通会话：改思考 → 同步 session context */
  onApplySessionThinking?: (pref: ThinkingPref) => Promise<void>
  /** 普通会话：改记忆 → 同步 session context（memory_enabled） */
  onApplySessionMemory?: (pref: MemoryPref) => Promise<void>
  /** 本地 memoryEnabled 状态同步（发消息会写回 context，员工/主对话都要） */
  onMemoryEnabledChange?: (on: boolean) => void
  /** 岗位保存后回调（刷新 employeeRoleDetail） */
  onRolePrefsSaved?: () => void
}

/** 开关展示用生效态：显式关→关；显式开→开；跟随则看模型能力 */
export function effectiveThinkingOn(
  pref: boolean | null | undefined,
  modelSupportsThinking?: boolean | null,
): boolean {
  if (pref === false) return false
  if (pref === true) return true
  // auto/跟随：多数模型实际会出思考；仅模型明确不支持时显示关
  return modelSupportsThinking !== false
}

/** @deprecated 识图跟模型能力，面板不再用 */
export function effectiveVisionOn(
  pref: boolean | null | undefined,
  modelSupportsVision?: boolean | null,
): boolean {
  if (pref === false) return false
  if (pref === true) return true
  return modelSupportsVision === true
}

/** 记忆默认开；仅显式 false 为关 */
export function effectiveMemoryOn(pref: boolean | null | undefined): boolean {
  return pref !== false
}

type PromptDraft = {
  systemPrompt: string
  soul: string
  loaded: boolean
  dirty: boolean
}

type PromptTab = 'system' | 'soul'

function ToggleSwitch({
  label,
  on,
  disabled,
  onToggle,
  hint,
}: {
  label: string
  on: boolean
  disabled?: boolean
  onToggle: () => void
  hint?: string
}) {
  return (
    <div className="chat-summary-role-pref-toggle" title={hint || undefined}>
      <span className="chat-summary-role-pref-toggle-label">{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={`${label}${on ? '已开' : '已关'}`}
        className={`chat-summary-role-pref-switch${on ? ' is-on' : ''}`}
        disabled={disabled}
        onClick={onToggle}
      >
        <span className="chat-summary-role-pref-switch-knob" aria-hidden />
      </button>
    </div>
  )
}

export function AgentRolePrefs({
  agentCode,
  roleCode,
  sessionKey = '',
  isEmployee = false,
  thinkingEnabled,
  memoryEnabled,
  modelSupportsThinking = null,
  onApplySessionThinking,
  onApplySessionMemory,
  onMemoryEnabledChange,
  onRolePrefsSaved,
}: AgentRolePrefsProps) {
  const code = String(agentCode || roleCode || '').trim()
  const dutyCode = String(roleCode || agentCode || '').trim()
  const sk = String(sessionKey || '').trim()
  const [tab, setTab] = useState<PromptTab>('system')
  const [thinkingOn, setThinkingOn] = useState(() =>
    effectiveThinkingOn(thinkingEnabled, modelSupportsThinking),
  )
  const [memoryOn, setMemoryOn] = useState(() => effectiveMemoryOn(memoryEnabled))
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState<PromptDraft>({
    systemPrompt: '',
    soul: '',
    loaded: false,
    dirty: false,
  })

  useEffect(() => {
    setThinkingOn(effectiveThinkingOn(thinkingEnabled, modelSupportsThinking))
  }, [thinkingEnabled, modelSupportsThinking, dutyCode])

  useEffect(() => {
    setMemoryOn(effectiveMemoryOn(memoryEnabled))
  }, [memoryEnabled, dutyCode])

  useEffect(() => {
    setTab('system')
  }, [code, isEmployee])

  const loadPrompt = useCallback(async () => {
    if (!code) return
    try {
      const { api } = await import('../../lib/tauri-api.js')
      const row = await api.getAgent(code)
      const rawSp = String(row?.system_prompt || '')
      const soul = String(row?.soul || '')
      // 员工：整段 system_prompt（含已合并的 ## 岗位职责）一起编辑
      setDraft({
        systemPrompt: rawSp,
        soul,
        loaded: true,
        dirty: false,
      })
    } catch (e) {
      toast(toUserFacingError((e as Error)?.message || e), 'error')
    }
  }, [code])

  useEffect(() => {
    setDraft({ systemPrompt: '', soul: '', loaded: false, dirty: false })
    void loadPrompt()
  }, [code, isEmployee, loadPrompt])

  // 面板常驻时 DB 可能已被后端回填清空；未改脏时回前台再拉一次
  useEffect(() => {
    const refreshIfClean = () => {
      if (document.visibilityState !== 'visible') return
      setDraft((d) => {
        if (d.dirty) return d
        void loadPrompt()
        return d
      })
    }
    document.addEventListener('visibilitychange', refreshIfClean)
    window.addEventListener('focus', refreshIfClean)
    return () => {
      document.removeEventListener('visibilitychange', refreshIfClean)
      window.removeEventListener('focus', refreshIfClean)
    }
  }, [loadPrompt])

  const saveRoleBoolPref = useCallback(
    async (field: 'thinking_enabled' | 'memory_enabled', on: boolean) => {
      if (!dutyCode) return
      const { api } = await import('../../lib/tauri-api.js')
      const { wsClient } = await import('../../lib/ws-client.js')
      await api.proactiveUpdateRole(dutyCode, { [field]: on })
      if (sk) {
        try {
          const patch =
            field === 'thinking_enabled'
              ? {
                  thinking_enabled: on,
                  thinking_type: 'manual',
                  reasoning_effort: on ? 'medium' : 'minimum',
                }
              : { memory_enabled: on }
          wsClient.updateSessionContext(sk, patch)
          await api.chatUpdateContext(sk, patch).catch(() => {})
        } catch {
          /* role 已存 */
        }
      }
      onRolePrefsSaved?.()
    },
    [dutyCode, sk, onRolePrefsSaved],
  )

  const onThinkingToggle = useCallback(async () => {
    const next = !thinkingOn
    const prev = thinkingOn
    setThinkingOn(next)
    setBusy(true)
    try {
      if (isEmployee) {
        await saveRoleBoolPref('thinking_enabled', next)
        toast(next ? '已启用思考（岗位）' : '已关闭思考（岗位）', 'success')
      } else if (onApplySessionThinking) {
        await onApplySessionThinking(next ? 'on' : 'off')
      } else {
        toast('当前会话无法保存思考偏好', 'warning')
        setThinkingOn(prev)
      }
    } catch (e) {
      setThinkingOn(prev)
      toast(toUserFacingError((e as Error)?.message || e), 'error')
    } finally {
      setBusy(false)
    }
  }, [thinkingOn, isEmployee, saveRoleBoolPref, onApplySessionThinking])

  const onMemoryToggle = useCallback(async () => {
    const next = !memoryOn
    const prev = memoryOn
    setMemoryOn(next)
    setBusy(true)
    try {
      if (isEmployee) {
        await saveRoleBoolPref('memory_enabled', next)
        onMemoryEnabledChange?.(next)
        toast(next ? '已开启记忆（岗位）' : '已关闭记忆（岗位）', 'success')
      } else if (onApplySessionMemory) {
        await onApplySessionMemory(next ? 'on' : 'off')
        onMemoryEnabledChange?.(next)
      } else {
        toast('当前会话无法保存记忆偏好', 'warning')
        setMemoryOn(prev)
      }
    } catch (e) {
      setMemoryOn(prev)
      toast(toUserFacingError((e as Error)?.message || e), 'error')
    } finally {
      setBusy(false)
    }
  }, [memoryOn, isEmployee, saveRoleBoolPref, onApplySessionMemory, onMemoryEnabledChange])

  const savePrompt = useCallback(async () => {
    if (!code || !draft.dirty) return
    setBusy(true)
    try {
      const { api } = await import('../../lib/tauri-api.js')
      const soul = draft.soul
      const system_prompt = draft.systemPrompt.trim() || null
      await api.updateAgent(code, { system_prompt, soul })
      if (isEmployee && dutyCode) {
        try {
          // 职责已在 system_prompt 内；清空岗位遗留 responsibilities 并镜像 SOUL
          await api.proactiveUpdateRole(dutyCode, {
            soul_md: soul,
            responsibilities: [],
          })
        } catch {
          /* agent 已保存；岗位镜像失败不回滚 */
        }
        onRolePrefsSaved?.()
      }
      setDraft((d) => ({
        ...d,
        dirty: false,
      }))
      toast(
        isEmployee ? '系统提示词 / SOUL 已保存（绑定本岗位智能体）' : '系统提示词 / SOUL 已保存',
        'success',
      )
    } catch (e) {
      toast(toUserFacingError((e as Error)?.message || e), 'error')
    } finally {
      setBusy(false)
    }
  }, [code, draft, isEmployee, dutyCode, onRolePrefsSaved])

  if (!code) return null

  const thinkingHint = isEmployee
    ? thinkingEnabled == null
      ? '跟随岗位默认（当前生效中）'
      : '写入本岗位'
    : thinkingEnabled == null
      ? '跟随会话默认（当前生效中）'
      : '仅本会话'
  const memoryHint = isEmployee
    ? '注入记忆/资产上下文，并挂载资产工具（写入本岗位）'
    : '注入记忆/资产上下文，并挂载资产工具（仅本会话）'

  const tabs: Array<{ id: PromptTab; label: string }> = [
    { id: 'system', label: '系统提示词' },
    { id: 'soul', label: 'SOUL' },
  ]

  const panelMeta: Record<
    PromptTab,
    { value: string; placeholder: string; aria: string }
  > = {
    system: {
      value: draft.systemPrompt,
      placeholder: isEmployee
        ? '该角色的核心指令与行为规范（含岗位职责可写在文末 ## 岗位职责）'
        : '可选，默认留空。有额外硬性要求再写；勿与 SOUL 重复，派岗/分诊交给小V',
      aria: '系统提示词',
    },
    soul: {
      value: draft.soul,
      placeholder: isEmployee
        ? '个性、边界与输出风格'
        : '个性、边界与输出风格（气质习惯即可，不要写编排/派岗）',
      aria: 'SOUL',
    },
  }

  return (
    <section className="chat-summary-role-prefs" aria-label="角色设定">
      <div className="chat-summary-role-pref-toggles">
        <ToggleSwitch
          label="思考"
          on={thinkingOn}
          disabled={busy}
          onToggle={() => void onThinkingToggle()}
          hint={thinkingHint}
        />
        <ToggleSwitch
          label="记忆"
          on={memoryOn}
          disabled={busy}
          onToggle={() => void onMemoryToggle()}
          hint={memoryHint}
        />
      </div>

      <div className="chat-summary-role-pref-box">
        <div className="chat-summary-role-pref-box-head">
          <div className="chat-summary-role-pref-tabs" role="tablist" aria-label="提示词分区">
            {tabs.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={tab === t.id}
                className={`chat-summary-role-pref-tab${tab === t.id ? ' is-on' : ''}`}
                disabled={busy}
                onClick={() => setTab(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div className="chat-summary-role-pref-actions">
            <button
              type="button"
              className="chat-summary-role-pref-link"
              disabled={busy}
              onClick={() => {
                setDraft((d) => ({ ...d, dirty: false, loaded: false }))
                void loadPrompt()
              }}
            >
              刷新
            </button>
            <button
              type="button"
              className="chat-summary-role-pref-link"
              disabled={busy || !draft.dirty}
              onClick={() => void savePrompt()}
            >
              保存
            </button>
          </div>
        </div>
        <div className="chat-summary-role-pref-box-body">
          {tabs.map((t) => {
            const meta = panelMeta[t.id]
            return (
              <textarea
                key={t.id}
                className="chat-summary-role-pref-textarea"
                hidden={tab !== t.id}
                value={meta.value}
                placeholder={meta.placeholder}
                aria-label={meta.aria}
                disabled={busy || !draft.loaded}
                onChange={(e) => {
                  const v = e.target.value
                  setDraft((d) =>
                    t.id === 'system'
                      ? { ...d, systemPrompt: v, dirty: true }
                      : { ...d, soul: v, dirty: true },
                  )
                }}
              />
            )
          })}
        </div>
      </div>
    </section>
  )
}
