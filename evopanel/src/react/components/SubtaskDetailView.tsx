import type { CollabSubtaskSnapshot, WorkChecklistItem } from '../chat-types.js'
import { useEffect, useRef } from 'react'
import {
  isPreviewableOutput,
  outputFileBasename,
  shortenPath,
  taskOutputsOf,
} from '../../lib/task-summary.js'
import { bindTaskOutputCardActions } from '../../lib/task-output-preview.js'

type OutputItem = {
  type?: string
  key?: string
  value?: string
  label?: string
}

type SubtaskOutcome = {
  task_report?: string
  summary?: string
  evidence_paths?: string[]
  outputs?: OutputItem[]
  status?: string
}

function DetailField({ label, value }: { label: string; value: string }) {
  const lines = String(value || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  if (!lines.length) return null
  return (
    <div className="plan-detail-field plan-detail-field--description">
      <div className="plan-detail-field-label">
        <span className="plan-detail-field-label-text">{label}</span>
      </div>
      <div className="plan-detail-field-value">
        {lines.length > 1 ? (
          <ul className="plan-detail-field-list">
            {lines.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        ) : (
          <p>{lines[0]}</p>
        )}
      </div>
    </div>
  )
}

function isStepOnlyLabel(text: string): boolean {
  const t = String(text || '').trim()
  if (!t) return true
  return /^step\s*\d+[\s:：]/i.test(t) || /^步骤\s*\d+/i.test(t)
}

function resolveTaskDescription(subtask: CollabSubtaskSnapshot | null | undefined): string {
  const desc = String(subtask?.description || '').trim()
  const name = String(subtask?.name || '').trim()
  if (!desc) return ''
  if (desc === name) return ''
  if (isStepOnlyLabel(desc) && desc.length < 80) return ''
  return desc
}

function ChecklistRows({ items }: { items: WorkChecklistItem[] }) {
  if (!items.length) return null
  return (
    <div className="plan-detail-step-fields">
      {items.map((item, i) => {
        const content = String(item.content ?? '').trim() || '—'
        const result = String(item.result ?? '').trim()
        const status = String(item.status ?? '').trim() || 'pending'
        const value = result ? `${content}\n结果：${result}` : content
        return <DetailField key={String(item.id || i)} label={`步骤 ${i + 1} · ${status}`} value={value} />
      })}
    </div>
  )
}

function normalizeOutputs(outcome?: SubtaskOutcome | null): OutputItem[] {
  return taskOutputsOf({
    outputs: outcome?.outputs,
    evidence_paths: outcome?.evidence_paths,
  })
}

function OutputCards({ items }: { items: OutputItem[] }) {
  const rootRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!rootRef.current) return
    bindTaskOutputCardActions(rootRef.current, {})
  }, [items])

  if (!items.length) return null
  return (
    <div className="plan-detail-field plan-detail-field--description" ref={rootRef}>
      <div className="plan-detail-field-label">
        <span className="plan-detail-field-label-text">产出</span>
      </div>
      <div className="plan-detail-field-value">
        <ul className="td-output-list">
          {items.map((item, i) => {
            const value = String(item.value || '')
            const title = String(item.label || outputFileBasename(item) || item.key || '产出')
            const short = shortenPath(value, 72)
            const isUrl = item.type === 'url' || /^https?:\/\//i.test(value)
            const previewable = isPreviewableOutput(item)
            return (
              <li
                key={`${item.key || 'o'}-${i}`}
                className={previewable && !isUrl ? 'td-output-row is-clickable' : 'td-output-row'}
                data-type={item.type || 'file'}
                data-act={previewable && !isUrl ? 'preview-output' : undefined}
                data-path={previewable && !isUrl ? value : undefined}
                data-title={title}
                title={previewable && !isUrl ? '点击预览' : value}
              >
                <div className="td-output-main">
                  <div className="td-output-name">{title}</div>
                  {short ? <div className="td-output-path" title={value}>{short}</div> : null}
                </div>
                <div className="td-output-actions">
                  {isUrl ? (
                    <a className="td-output-action" href={value} target="_blank" rel="noopener noreferrer">
                      打开
                    </a>
                  ) : (
                    <>
                      {previewable ? (
                        <button
                          type="button"
                          className="td-output-action"
                          data-act="preview-output"
                          data-path={value}
                          data-title={title}
                          data-type={item.type || 'file'}
                        >
                          预览
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="td-output-action td-output-action--muted"
                        data-act="copy-path"
                        data-path={value}
                      >
                        复制路径
                      </button>
                      <button
                        type="button"
                        className="td-output-action td-output-action--muted"
                        data-act="reveal-path"
                        data-path={value}
                        title="在本地文件管理器中显示"
                      >
                        打开位置
                      </button>
                    </>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      </div>
    </div>
  )
}

export function SubtaskDetailView({
  subtask,
  outcome,
}: {
  subtask: CollabSubtaskSnapshot | null
  outcome?: SubtaskOutcome | null
}) {
  if (!subtask) {
    return <p className="plan-detail-empty">（暂无子任务详情）</p>
  }

  const description = resolveTaskDescription(subtask)
  const checklist = Array.isArray(subtask.workChecklist) ? subtask.workChecklist : []
  const outputs = normalizeOutputs(outcome)
  const report = String(outcome?.task_report || outcome?.summary || '').trim()
  const hasBody = !!(description || checklist.length || outputs.length || report)

  return (
    <div className="plan-detail-doc plan-detail-subtask-doc">
      <div className="plan-detail-step-panel plan-detail-step-panel--detail-only">
        {hasBody ? (
          <div className="plan-detail-step-fields">
            {description ? <DetailField label="任务说明" value={description} /> : null}
            {checklist.length > 0 ? <ChecklistRows items={checklist} /> : null}
            <OutputCards items={outputs} />
            {report ? <DetailField label="执行结果" value={report} /> : null}
          </div>
        ) : (
          <p className="plan-detail-empty plan-detail-empty--in-panel">（该子任务暂无结构化详情）</p>
        )}
      </div>
    </div>
  )
}
