/**
 * cron.js 编辑弹窗中「智能体」和「模型」两个下拉。
 *
 * 使用原生 <select> + 弹窗已有的 .cron-select 样式：
 * 在 overflow 滚动弹窗内不会出现 Radix Portal 跑到页面底部、被裁切等问题。
 * hidden input 保持与 saveFromForm 兼容（默认仍写空串）。
 */
import * as React from 'react'
import { createRoot, Root } from 'react-dom/client'

/** API / saveFromForm 用空串表示「默认」；原生 select 可用空 value */
const DEFAULT_VALUE = ''

// ── Props ──────────────────────────────────────────

export interface CronSelectsProps {
  agents: Array<{ code: string; name?: string }>
  models: Array<string | { name?: string; id?: string }>
  initialAgentCode?: string
  initialModelName?: string
}

// ── 工具函数 ────────────────────────────────────────

function modelId(m: string | { name?: string; id?: string }): string {
  return typeof m === 'string' ? m : (m.name || m.id || '')
}

function modelLabel(m: string | { name?: string; id?: string }): string {
  const id = modelId(m)
  return typeof m === 'string' ? id : (m.name || m.id || id)
}

function toSelectValue(raw: string | undefined): string {
  return raw && raw.trim() ? raw.trim() : DEFAULT_VALUE
}

function CronNativeSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: string
  options: Array<{ value: string; label: string }>
  onChange: (v: string) => void
}) {
  return (
    <div className="cron-form-group">
      <label className="cron-label">{label}</label>
      <select
        className="cron-select"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map((opt) => (
          <option key={opt.value || '__default__'} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  )
}

// ── 主组件 ──────────────────────────────────────────

function CronSelectsApp({
  agents,
  models,
  initialAgentCode,
  initialModelName,
}: CronSelectsProps) {
  const [agentCode, setAgentCode] = React.useState(() => toSelectValue(initialAgentCode))
  const [modelName, setModelName] = React.useState(() => toSelectValue(initialModelName))

  React.useEffect(() => {
    const el = document.getElementById('fAgentCode')
    if (el) (el as HTMLInputElement).value = agentCode
  }, [agentCode])

  React.useEffect(() => {
    const el = document.getElementById('fModelName')
    if (el) (el as HTMLInputElement).value = modelName
  }, [modelName])

  const agentOptions = [
    { value: DEFAULT_VALUE, label: '默认 (lead_agent)' },
    ...agents
      .filter((a) => a.code && a.code.trim())
      .map((a) => ({
        value: a.code,
        label: a.name || a.code,
      })),
  ]
  if (agentCode && !agentOptions.some((o) => o.value === agentCode)) {
    agentOptions.push({ value: agentCode, label: agentCode })
  }

  const modelOptions = [
    { value: DEFAULT_VALUE, label: '默认模型' },
    ...models
      .map((m) => ({ value: modelId(m), label: modelLabel(m) }))
      .filter((o) => o.value),
  ]
  if (modelName && !modelOptions.some((o) => o.value === modelName)) {
    modelOptions.push({ value: modelName, label: modelName })
  }

  return (
    <>
      <CronNativeSelect
        label="智能体"
        value={agentCode}
        options={agentOptions}
        onChange={setAgentCode}
      />
      <CronNativeSelect
        label="模型"
        value={modelName}
        options={modelOptions}
        onChange={setModelName}
      />
      <input type="hidden" id="fAgentCode" value={agentCode} />
      <input type="hidden" id="fModelName" value={modelName} />
    </>
  )
}

// ── mount / unmount 接口（供 vanilla JS 调用）───────

let _cronRoot: Root | null = null

export function mountCronSelects(
  containerEl: HTMLElement,
  props: CronSelectsProps,
): void {
  if (_cronRoot) {
    _cronRoot.unmount()
    _cronRoot = null
  }
  const root = createRoot(containerEl)
  _cronRoot = root
  root.render(<CronSelectsApp {...props} />)
}

export function unmountCronSelects(): void {
  if (_cronRoot) {
    _cronRoot.unmount()
    _cronRoot = null
  }
}
