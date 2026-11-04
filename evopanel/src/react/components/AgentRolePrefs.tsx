/**
 * 状态面板「智能体 / 员工」Tab：角色设定条
 * - 思考 / 图片识别：员工写岗位 config；普通会话写本会话 context
 * - 系统提示词 / SOUL / 职责：同一框内 Tab 切换（职责仅员工，可编辑）
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from '../../components/toast.js'
import { toUserFacingError } from '../../lib/user-facing-error.js'
import {
  applyDutyToSystemPrompt,
  coerceDutyLines,
  splitDutyFromSystemPrompt,
} from '../../lib/proactive-role-edit.js'

/** 对外仍兼容旧三态；本面板 UI 只暴露开/关，展示为「生效态」 */
export type ThinkingPref = 'follow' | 'on' | 'off'
export type VisionPref = 'follow' | 'on' | 'off'

export type AgentRolePrefsProps = {
  agentCode?: string
  /** 员工会话：岗位代号（与 agentCode 通常相同） */
  roleCode?: string
  /** 当前聊天 sessionKey；员工改偏好时同步到该会话 */
  sessionKey?: string
  isEmployee?: boolean
  /** 岗位/会话思考偏好；null=跟随默认（展示按模型能力推断生效态） */
  thinkingEnabled?: boolean | null
  /** 岗位/会话识图偏好；null=跟随模型 */
  visionEnabled?: boolean | null
  /** 当前模型是否支持思考（null 未知时，跟随默认按开展示） */
  modelSupportsThinking?: boolean | null
  /** 当前模型是否支持视觉 */
  modelSupportsVision?: boolean | null
  /** 员工：岗位职责条目（可与 system_prompt 内「## 岗位职责」互补） */
  responsibilities?: string[]
  /** 普通会话：改思考 → 同步 session context */
  onApplySessionThinking?: (pref: ThinkingPref) => Promise<void>
  /** 普通会话：改图片识别 → 同步 session context */
  onApplySessionVision?: (pref: VisionPref) => Promise<void>
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

export function effectiveVisionOn(
  pref: boolean | null | undefined,
  modelSupportsVision?: boolean | null,
): boolean {
  if (pref === false) return false
  if (pref === true) return true
  // 跟随：模型能识图则显示开
  return modelSupportsVision === true
}

type PromptDraft = {
  /** 员工：不含「## 岗位职责」的正文；普通会话：完整 system_prompt */
  systemPrompt: string
  soul: string
  /** 员工职责，一行一条 */
  duty: string
  loaded: boolean
  dirty: boolean
}

type PromptTab = 'system' | 'soul' | 'duty'

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
  visionEnabled,
  modelSupportsThinking = null,
  modelSupportsVision = null,
  responsibilities,
  onApplySessionThinking,
  onApplySessionVision,
  onRolePrefsSaved,
}: AgentRolePrefsProps) {
  const code = String(agentCode || roleCode || '').trim()
  const dutyCode = String(roleCode || agentCode || '').trim()
  const sk = String(sessionKey || '').trim()
  const showDutyTab = isEmployee
  const responsibilitiesRef = useRef(responsibilities)
  responsibilitiesRef.current = responsibilities
  const [tab, setTab] = useState<PromptTab>('system')
  const [thinkingOn, setThinkingOn] = useState(() =>
    effectiveThinkingOn(thinkingEnabled, modelSupportsThinking),
  )
  const [visionOn, setVisionOn] = useState(() =>
    effectiveVisionOn(visionEnabled, modelSupportsVision),
  )
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState<PromptDraft>({
    systemPrompt: '',
    soul: '',
    duty: '',
    loaded: false,
    dirty: false,
  })

  useEffect(() => {
    setThinkingOn(effectiveThinkingOn(thinkingEnabled, modelSupportsThinking))
  }, [thinkingEnabled, modelSupportsThinking, dutyCode])

  useEffect(() => {
    setVisionOn(effectiveVisionOn(visionEnabled, modelSupportsVision))
  }, [visionEnabled, modelSupportsVision, dutyCode])

  useEffect(() => {
    setTab('system')
  }, [code, isEmployee])

  useEffect(() => {
    if (!showDutyTab && tab === 'duty') setTab('system')
  }, [showDutyTab, tab])

  const loadPrompt = useCallback(async () => {
    if (!code) return
    try {
      const { api } = await import('../../lib/tauri-api.js')
      const row = await api.getAgent(code)
      const rawSp = String(row?.system_prompt || '')
      const soul = String(row?.soul || '')
      if (isEmployee) {
        const split = splitDutyFromSystemPrompt(rawSp)
        const legacy = coerceDutyLines(responsibilitiesRef.current)
        const duties = split.duties.length ? split.duties : legacy
        setDraft({
          systemPrompt: split.body,
          soul,
          duty: duties.join('\n'),
          loaded: true,
          dirty: false,
        })
      } else {
        setDraft({
          systemPrompt: rawSp,
          soul,
          duty: '',
          loaded: true,
          dirty: false,
        })
      }
    } catch (e) {
      toast(toUserFacingError((e as Error)?.message || e), 'error')
    }
  }, [code, isEmployee])

  useEffect(() => {
    setDraft({ systemPrompt: '', soul: '', duty: '', loaded: false, dirty: false })
    void loadPrompt()
  }, [code, isEmployee, loadPrompt])

  // 面板常驻时 DB 可能已被后端回填清空；未改脏时回前台再拉一次，避免旧「编排职责」稿卡在内存里
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
    async (field: 'thinking_enabled' | 'vision_enabled', on: boolean) => {
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
              : { vision_enabled: on }
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

  const onVisionToggle = useCallback(async () => {
    const next = !visionOn
    const prev = visionOn
    setVisionOn(next)
    setBusy(true)
    try {
      if (isEmployee) {
        await saveRoleBoolPref('vision_enabled', next)
        toast(next ? '已开启图片识别（岗位）' : '已关闭图片识别（岗位）', 'success')
      } else if (onApplySessionVision) {
        await onApplySessionVision(next ? 'on' : 'off')
      } else {
        toast('当前会话无法保存图片识别偏好', 'warning')
        setVisionOn(prev)
      }
    } catch (e) {
      setVisionOn(prev)
      toast(toUserFacingError((e as Error)?.message || e), 'error')
    } finally {
      setBusy(false)
    }
  }, [visionOn, isEmployee, saveRoleBoolPref, onApplySessionVision])

  const savePrompt = useCallback(async () => {
    if (!code || !draft.dirty) return
    setBusy(true)
    try {
      const { api } = await import('../../lib/tauri-api.js')
      const soul = draft.soul
      const dutyLines = coerceDutyLines(draft.duty)
      const system_prompt = isEmployee
        ? applyDutyToSystemPrompt(draft.systemPrompt, dutyLines) || null
        : draft.systemPrompt.trim() || null
      await api.updateAgent(code, { system_prompt, soul })
      if (isEmployee && dutyCode) {
        try {
          // 职责已写入 agent system_prompt；清空岗位遗留字段并镜像 SOUL
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
        systemPrompt: isEmployee ? splitDutyFromSystemPrompt(system_prompt || '').body : d.systemPrompt,
        duty: dutyLines.join('\n'),
        dirty: false,
      }))
      toast(
        isEmployee ? '系统提示词 / SOUL / 职责已保存（绑定本岗位智能体）' : '系统提示词 / SOUL 已保存',
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
  const visionModelHint =
    visionEnabled == null && modelSupportsVision === true
      ? '跟随当前模型（已支持视觉）'
      : modelSupportsVision === true
        ? '当前模型支持视觉'
        : modelSupportsVision === false
          ? '当前模型不支持视觉，开了也会走识图回退'
          : undefined

  const tabs: Array<{ id: PromptTab; label: string }> = [
    { id: 'system', label: '系统提示词' },
    { id: 'soul', label: 'SOUL' },
    ...(showDutyTab ? [{ id: 'duty' as const, label: '职责' }] : []),
  ]

  const panelTabs: PromptTab[] = showDutyTab ? ['system', 'soul', 'duty'] : ['system', 'soul']

  const panelMeta: Record<
    PromptTab,
    { value: string; placeholder: string; aria: string }
  > = {
    system: {
      value: draft.systemPrompt,
      placeholder: isEmployee
        ? '该角色的核心指令与行为规范'
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
    duty: {
      value: draft.duty,
      placeholder:
        '每行一条岗位职责，例如：\n汇总各岗未结 Task\n催办卡住的交接\n把阻塞事项派给对口员工',
      aria: '岗位职责',
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
          label="图片识别"
          on={visionOn}
          disabled={busy}
          onToggle={() => void onVisionToggle()}
          hint={visionModelHint}
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
          {!draft.loaded ? (
            <div className="chat-summary-role-pref-hint">加载中…</div>
          ) : (
            panelTabs.map((id) => {
              const meta = panelMeta[id]
              const active = tab === id
              return (
                <textarea
                  key={`${code}:${id}`}
                  id={`chat-summary-role-pref-${code}-${id}`}
                  className="chat-summary-role-pref-textarea"
                  rows={3}
                  hidden={!active}
                  // 常驻挂载 + hidden：避免 WebView 复用同一 textarea 导致切 Tab 文案不换
                  aria-hidden={!active}
                  value={meta.value}
                  disabled={busy}
                  placeholder={meta.placeholder}
                  aria-label={meta.aria}
                  onChange={(e) => {
                    const value = e.target.value
                    setDraft((d) => {
                      if (id === 'soul') return { ...d, soul: value, dirty: true }
                      if (id === 'duty') return { ...d, duty: value, dirty: true }
                      return { ...d, systemPrompt: value, dirty: true }
                    })
                  }}
                />
              )
            })
          )}
        </div>
      </div>
    </section>
  )
}
