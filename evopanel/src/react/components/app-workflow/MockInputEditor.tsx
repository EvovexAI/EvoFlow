import { useState } from 'react'
import { Trash2 } from 'lucide-react'

export type MockInput = {
  output: Record<string, unknown>
  summary: string
}

export type MockInputs = Record<string, MockInput>

type Props = {
  /** Step refs of upstream steps that can be mocked. */
  upstreamRefs: string[]
  /** Current mock inputs keyed by step ref. */
  mockInputs: MockInputs
  onChange: (inputs: MockInputs) => void
}

/** Editor for mock upstream step outputs used in debug single-step execution. */
export function MockInputEditor({ upstreamRefs, mockInputs, onChange }: Props) {
  const [expandedRef, setExpandedRef] = useState<string | null>(null)

  const toggleRef = (ref: string) => {
    setExpandedRef(expandedRef === ref ? null : ref)
  }

  const updateOutput = (ref: string, jsonText: string) => {
    let parsed: Record<string, unknown>
    try {
      parsed = jsonText.trim() ? JSON.parse(jsonText) : {}
    } catch {
      // Keep raw text; will show parse error indicator
      parsed = { _raw: jsonText } as Record<string, unknown>
    }
    const existing = mockInputs[ref] || { output: {}, summary: '' }
    onChange({ ...mockInputs, [ref]: { ...existing, output: parsed } })
  }

  const updateSummary = (ref: string, summary: string) => {
    const existing = mockInputs[ref] || { output: {}, summary: '' }
    onChange({ ...mockInputs, [ref]: { ...existing, summary } })
  }

  const removeMock = (ref: string) => {
    const next = { ...mockInputs }
    delete next[ref]
    onChange(next)
  }

  if (upstreamRefs.length === 0) {
    return (
      <p className="wf-inspector-muted" style={{ fontSize: 12 }}>
        本步骤无上游依赖，无需 mock 输入。
      </p>
    )
  }

  return (
    <div className="wf-mock-editor">
      <p className="wf-inspector-muted" style={{ fontSize: 12, marginBottom: 8 }}>
        为上游步骤填写 mock 输出，用于单节点调试。留空则不注入该步骤数据。
      </p>
      {upstreamRefs.map((ref) => {
        const mock = mockInputs[ref]
        const isExpanded = expandedRef === ref || !!mock
        const outputText = mock
          ? JSON.stringify(mock.output, null, 2)
          : ''
        return (
          <div key={ref} className="wf-mock-step">
            <div className="wf-mock-step-head" onClick={() => toggleRef(ref)}>
              <span className="wf-mock-step-ref">#{ref}</span>
              <span className="wf-mock-step-toggle">
                {isExpanded ? '▼' : '▶'}
              </span>
              {mock ? (
                <button
                  type="button"
                  className="wf-binding-remove"
                  title="清除 mock"
                  onClick={(e) => {
                    e.stopPropagation()
                    removeMock(ref)
                  }}
                >
                  <Trash2 size={12} />
                </button>
              ) : null}
            </div>
            {isExpanded ? (
              <div className="wf-mock-step-body">
                <label className="wf-inspector-label" style={{ fontSize: 11 }}>
                  Summary
                </label>
                <input
                  className="wf-inspector-control"
                  style={{ fontSize: 12 }}
                  value={mock?.summary || ''}
                  placeholder="上游步骤的文本摘要"
                  onChange={(e) => updateSummary(ref, e.target.value)}
                />
                <label className="wf-inspector-label" style={{ fontSize: 11, marginTop: 6 }}>
                  Output (JSON)
                </label>
                <textarea
                  className="wf-inspector-control wf-inspector-control--area"
                  style={{ fontSize: 11, fontFamily: 'var(--font-mono, monospace)', minHeight: 60 }}
                  rows={3}
                  value={outputText}
                  placeholder='{"companies": [{"name": "OpenAI"}]}'
                  onChange={(e) => updateOutput(ref, e.target.value)}
                />
              </div>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

export default MockInputEditor
