import { Workflow, Bot, Cpu, Wrench, Sparkles, Target, Plus, Trash2, ArrowRight } from 'lucide-react'
import {
  STEP_FIELD_MAP,
  STEP_INSPECTOR_GROUPS,
  type AppWorkflowStep,
  type StepNodeData,
  type OutputSchemaField,
  type OutputSchemaFieldType,
  type InputSchemaDef,
} from '../../lib/app-workflow-plan.ts'
import { START_NODE_ID } from '../../lib/app-workflow-flow.ts'
import WorkflowNodeAvatar from './WorkflowNodeAvatar.tsx'
import { WorkspaceFolderInput } from './WorkspaceFolderInput.tsx'

type Props = {
  selectedId: string | null
  selectedStep: StepNodeData | null
  dependsOn: string[]
  workflowGoal: string
  onWorkflowGoalChange: (goal: string) => void
  onStepChange: (patch: Partial<AppWorkflowStep>) => void
  onOpenAppSettings?: () => void
}

function InspectorField({
  fieldKey,
  value,
  onChange,
}: {
  fieldKey: keyof AppWorkflowStep
  value: string
  onChange: (patch: Partial<AppWorkflowStep>) => void
}) {
  const field = STEP_FIELD_MAP[fieldKey]
  if (!field) return null
  const isName = field.key === 'name'
  const isProjectPath = field.key === 'project_path'
  const inputId = `wf-field-${field.key}`

  return (
    <div className="wf-inspector-field">
      <label className="wf-inspector-label" htmlFor={inputId}>
        {field.label}
        {isName ? <span className="wf-inspector-required">*</span> : null}
      </label>
      {field.multiline ? (
        <textarea
          id={inputId}
          className="wf-inspector-control wf-inspector-control--area"
          rows={3}
          value={value}
          placeholder={field.placeholder}
          onChange={(e) => onChange({ [field.key]: e.target.value })}
        />
      ) : isProjectPath ? (
        <WorkspaceFolderInput
          id={inputId}
          className="wf-inspector-control"
          value={value}
          placeholder={field.placeholder}
          onChange={(next) => onChange({ [field.key]: next })}
        />
      ) : (
        <input
          id={inputId}
          className="wf-inspector-control"
          value={value}
          placeholder={field.placeholder}
          onChange={(e) => onChange({ [field.key]: e.target.value })}
        />
      )}
    </div>
  )
}

// ── Input Bindings Editor ──────────────────────────────────────────────

function InputBindingsEditor({
  bindings,
  onChange,
}: {
  bindings: Record<string, string>
  onChange: (patch: Partial<AppWorkflowStep>) => void
}) {
  const entries = Object.entries(bindings)

  const updateKey = (oldKey: string, newKey: string) => {
    const next: Record<string, string> = {}
    for (const [k, v] of entries) {
      next[k === oldKey ? newKey.trim() : k] = v
    }
    onChange({ input_bindings: next })
  }

  const updateValue = (key: string, newValue: string) => {
    onChange({ input_bindings: { ...bindings, [key]: newValue } })
  }

  const removeEntry = (key: string) => {
    const next = { ...bindings }
    delete next[key]
    onChange({ input_bindings: next })
  }

  const addEntry = () => {
    const baseKey = 'var'
    let key = baseKey
    let i = 1
    while (bindings[key]) {
      key = `${baseKey}${i++}`
    }
    onChange({ input_bindings: { ...bindings, [key]: '' } })
  }

  return (
    <div className="wf-bindings-editor">
      {entries.length === 0 ? (
        <p className="wf-inspector-muted" style={{ marginBottom: 8 }}>
          声明本步从上游步骤或参数获取的结构化数据。留空则自动注入上游报告全文。
        </p>
      ) : null}
      {entries.map(([key, value]) => (
        <div key={key} className="wf-binding-row">
          <input
            className="wf-inspector-control wf-binding-key"
            value={key}
            placeholder="变量名"
            onChange={(e) => updateKey(key, e.target.value)}
          />
          <ArrowRight size={12} className="wf-binding-arrow" />
          <input
            className="wf-inspector-control wf-binding-value"
            value={value}
            placeholder="{{steps.1.output.x}}"
            onChange={(e) => updateValue(key, e.target.value)}
          />
          <button
            type="button"
            className="wf-binding-remove"
            title="删除"
            onClick={() => removeEntry(key)}
          >
            <Trash2 size={12} />
          </button>
        </div>
      ))}
      <button type="button" className="wf-inspector-link-btn" onClick={addEntry}>
        <Plus size={12} style={{ verticalAlign: 'middle' }} /> 添加绑定
      </button>
    </div>
  )
}

// ── Output Schema Editor ───────────────────────────────────────────────

const SCHEMA_FIELD_TYPES: OutputSchemaFieldType[] = ['string', 'number', 'boolean', 'object', 'array']

function OutputSchemaEditor({
  schema,
  onChange,
}: {
  schema: { fields: OutputSchemaField[] } | undefined
  onChange: (patch: Partial<AppWorkflowStep>) => void
}) {
  const fields = schema?.fields || []

  const updateField = (index: number, patch: Partial<OutputSchemaField>) => {
    const next = fields.map((f, i) => (i === index ? { ...f, ...patch } : f))
    onChange({ output_schema: { fields: next } })
  }

  const removeField = (index: number) => {
    const next = fields.filter((_, i) => i !== index)
    onChange({ output_schema: next.length ? { fields: next } : undefined })
  }

  const addField = () => {
    const baseName = 'field'
    let name = baseName
    let i = 1
    while (fields.some((f) => f.name === name)) {
      name = `${baseName}${i++}`
    }
    onChange({ output_schema: { fields: [...fields, { name, type: 'string' }] } })
  }

  return (
    <div className="wf-schema-editor">
      {fields.length === 0 ? (
        <p className="wf-inspector-muted" style={{ marginBottom: 8 }}>
          声明本步产出的结构化字段，供下游步骤通过 input_bindings 引用。
        </p>
      ) : null}
      {fields.map((field, index) => (
        <div key={index} className="wf-schema-field-row">
          <div className="wf-schema-field-top">
            <input
              className="wf-inspector-control wf-schema-field-name"
              value={field.name}
              placeholder="字段名"
              onChange={(e) => updateField(index, { name: e.target.value })}
            />
            <select
              className="wf-inspector-control wf-schema-field-type"
              value={field.type}
              onChange={(e) => updateField(index, { type: e.target.value as OutputSchemaFieldType })}
            >
              {SCHEMA_FIELD_TYPES.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
            <label className="wf-schema-field-required">
              <input
                type="checkbox"
                checked={!!field.required}
                onChange={(e) => updateField(index, { required: e.target.checked })}
              />
              <span>必填</span>
            </label>
            <button
              type="button"
              className="wf-binding-remove"
              title="删除字段"
              onClick={() => removeField(index)}
            >
              <Trash2 size={12} />
            </button>
          </div>
          <input
            className="wf-inspector-control wf-schema-field-desc"
            value={field.description || ''}
            placeholder="描述（可选）"
            onChange={(e) => updateField(index, { description: e.target.value })}
          />
        </div>
      ))}
      <button type="button" className="wf-inspector-link-btn" onClick={addField}>
        <Plus size={12} style={{ verticalAlign: 'middle' }} /> 添加字段
      </button>
    </div>
  )
}

// ── Input Schema Editor ────────────────────────────────────────────────

function InputSchemaEditor({
  schema,
  onChange,
}: {
  schema: InputSchemaDef | undefined
  onChange: (patch: Partial<AppWorkflowStep>) => void
}) {
  const fields = schema?.fields || []

  const updateField = (index: number, patch: Partial<OutputSchemaField>) => {
    const next = fields.map((f, i) => (i === index ? { ...f, ...patch } : f))
    onChange({ input_schema: { fields: next } })
  }

  const removeField = (index: number) => {
    const next = fields.filter((_, i) => i !== index)
    onChange({ input_schema: next.length ? { fields: next } : undefined })
  }

  const addField = () => {
    const baseName = 'field'
    let name = baseName
    let i = 1
    while (fields.some((f) => f.name === name)) {
      name = `${baseName}${i++}`
    }
    onChange({ input_schema: { fields: [...fields, { name, type: 'string' }] } })
  }

  return (
    <div className="wf-schema-editor">
      {fields.length === 0 ? (
        <p className="wf-inspector-muted" style={{ marginBottom: 8 }}>
          声明本步输入绑定的预期类型（类型契约）。留空则不做输入类型校验。
        </p>
      ) : null}
      {fields.map((field, index) => (
        <div key={index} className="wf-schema-field-row">
          <div className="wf-schema-field-top">
            <input
              className="wf-inspector-control wf-schema-field-name"
              value={field.name}
              placeholder="字段名"
              onChange={(e) => updateField(index, { name: e.target.value })}
            />
            <select
              className="wf-inspector-control wf-schema-field-type"
              value={field.type}
              onChange={(e) => updateField(index, { type: e.target.value as OutputSchemaFieldType })}
            >
              {SCHEMA_FIELD_TYPES.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
            <label className="wf-schema-field-required">
              <input
                type="checkbox"
                checked={!!field.required}
                onChange={(e) => updateField(index, { required: e.target.checked })}
              />
              <span>必填</span>
            </label>
            <button
              type="button"
              className="wf-binding-remove"
              title="删除字段"
              onClick={() => removeField(index)}
            >
              <Trash2 size={12} />
            </button>
          </div>
          <input
            className="wf-inspector-control wf-schema-field-desc"
            value={field.description || ''}
            placeholder="描述（可选）"
            onChange={(e) => updateField(index, { description: e.target.value })}
          />
        </div>
      ))}
      <button type="button" className="wf-inspector-link-btn" onClick={addField}>
        <Plus size={12} style={{ verticalAlign: 'middle' }} /> 添加字段
      </button>
    </div>
  )
}

// ── Main Inspector ─────────────────────────────────────────────────────

export function WorkflowNodeInspector({
  selectedId,
  selectedStep,
  dependsOn,
  workflowGoal,
  onWorkflowGoalChange,
  onStepChange,
  onOpenAppSettings,
}: Props) {
  const isStart = selectedId === START_NODE_ID
  const isStep = !!selectedStep && !isStart

  return (
    <aside className="app-wf-sidebar app-wf-sidebar--right">
      {isStep && selectedStep ? (
        <div className="wf-inspector-node-head">
          <WorkflowNodeAvatar tone={selectedStep.assigned_agent ? 'action' : 'trigger'}>
            <Workflow size={16} strokeWidth={2.2} />
          </WorkflowNodeAvatar>
          <div className="wf-inspector-node-head-copy">
            <div className="wf-inspector-node-name">{selectedStep.name || `步骤 ${selectedStep.ref}`}</div>
            <div className="wf-inspector-node-id">#{selectedStep.ref}</div>
            {/* Meta chips: agent / model / tools / skills */}
            <div className="wf-inspector-node-meta">
              {selectedStep.assigned_agent ? (
                <span className="wf-inspector-meta-chip wf-inspector-meta-chip--agent">
                  <Bot size={11} /> {selectedStep.assigned_agent}
                </span>
              ) : (
                <span className="wf-inspector-meta-chip wf-inspector-meta-chip--muted">
                  <Bot size={11} /> 未选择智能体
                </span>
              )}
              {selectedStep.model ? (
                <span className="wf-inspector-meta-chip">
                  <Cpu size={11} /> {selectedStep.model}
                </span>
              ) : null}
              {selectedStep.tools ? (
                <span className="wf-inspector-meta-chip">
                  <Wrench size={11} /> {selectedStep.tools.split(',').filter(Boolean).length} 工具
                </span>
              ) : null}
              {selectedStep.skills ? (
                <span className="wf-inspector-meta-chip">
                  <Sparkles size={11} /> {selectedStep.skills.split(',').filter(Boolean).length} 技能
                </span>
              ) : null}
            </div>
            {/* Goal / description snippet */}
            {(selectedStep.goal || selectedStep.description) ? (
              <p className="wf-inspector-node-snippet">
                <Target size={11} style={{ flexShrink: 0, marginTop: 2 }} />
                <span>{(selectedStep.goal || selectedStep.description).slice(0, 80)}{((selectedStep.goal || selectedStep.description).length > 80) ? '…' : ''}</span>
              </p>
            ) : null}
          </div>
        </div>
      ) : (
        <div className="app-wf-sidebar-head">
          <h3>{isStart ? '流程开始' : '工作流配置'}</h3>
        </div>
      )}

      <div className="app-wf-inspector-body">
        {!selectedId ? (
          <div className="wf-inspector-tip">
            选中画布节点后，在此配置参数
          </div>
        ) : null}

        {(isStart || !selectedId) && (
          <section className="wf-inspector-block">
            <h4 className="wf-inspector-block-title">工作流目标</h4>
            <textarea
              id="wf-inspector-goal"
              className="wf-inspector-control wf-inspector-control--area"
              rows={3}
              value={workflowGoal}
              placeholder="描述此工作流要达成的总体目标…"
              onChange={(e) => onWorkflowGoalChange(e.target.value)}
            />
            {onOpenAppSettings ? (
              <button type="button" className="wf-inspector-link-btn" onClick={onOpenAppSettings}>
                工作流设置
              </button>
            ) : null}
          </section>
        )}

        {isStart ? (
          <section className="wf-inspector-block">
            <p className="wf-inspector-muted">
              用户运行工作流时从此节点触发。将输出连到第一个智能体步骤即可开始编排。
            </p>
          </section>
        ) : null}

        {isStep && selectedStep ? (
          <>
            {dependsOn.length > 0 ? (
              <section className="wf-inspector-block">
                <h4 className="wf-inspector-block-title">前置依赖</h4>
                <div className="wf-inspector-tags">
                  {dependsOn.map((d) => (
                    <span key={d} className="wf-inspector-tag">
                      #{d}
                    </span>
                  ))}
                </div>
              </section>
            ) : null}

            {STEP_INSPECTOR_GROUPS.map((group) => (
              <section key={group.id} className="wf-inspector-block">
                <h4 className="wf-inspector-block-title">{group.label}</h4>
                <div className="wf-inspector-fields">
                  {group.keys.map((key) => (
                    <InspectorField
                      key={key}
                      fieldKey={key}
                      value={String(selectedStep[key as keyof StepNodeData] ?? '')}
                      onChange={onStepChange}
                    />
                  ))}
                </div>
              </section>
            ))}

            {/* ── Data Bindings: input_schema + input_bindings + output_schema + schema_enforcement ── */}
            <section className="wf-inspector-block">
              <h4 className="wf-inspector-block-title">数据绑定</h4>

              <div className="wf-inspector-subsection">
                <label className="wf-inspector-label">输入 (Input)</label>

                <div className="wf-inspector-subsection" style={{ marginTop: 8 }}>
                  <label className="wf-inspector-label">Input Schema</label>
                  <InputSchemaEditor
                    schema={selectedStep.input_schema}
                    onChange={onStepChange}
                  />
                </div>

                <div className="wf-inspector-subsection" style={{ marginTop: 12 }}>
                  <label className="wf-inspector-label">Input Bindings</label>
                  <InputBindingsEditor
                    bindings={selectedStep.input_bindings || {}}
                    onChange={onStepChange}
                  />
                </div>
              </div>

              <div className="wf-inspector-subsection" style={{ marginTop: 16 }}>
                <label className="wf-inspector-label">输出 (Output)</label>

                <div className="wf-inspector-subsection" style={{ marginTop: 8 }}>
                  <label className="wf-inspector-label">Output Schema</label>
                  <OutputSchemaEditor
                    schema={selectedStep.output_schema}
                    onChange={onStepChange}
                  />
                </div>

                <div className="wf-inspector-subsection" style={{ marginTop: 12 }}>
                  <label className="wf-inspector-label" htmlFor="wf-schema-enforcement">
                    Schema Policy
                  </label>
                  <select
                    id="wf-schema-enforcement"
                    className="wf-inspector-control"
                    value={selectedStep.schema_enforcement || ''}
                    onChange={(e) =>
                      onStepChange({ schema_enforcement: e.target.value as '' | 'strict' | 'warn' | 'ignore' })
                    }
                  >
                    <option value="">默认（跟随工作流设置）</option>
                    <option value="strict">strict（校验失败阻断）</option>
                    <option value="warn">warn（校验失败警告）</option>
                    <option value="ignore">ignore（不校验）</option>
                  </select>
                </div>
              </div>
            </section>
          </>
        ) : null}
      </div>
    </aside>
  )
}
