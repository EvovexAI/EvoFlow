import { Braces } from 'lucide-react'

export type RunVar = {
  name: string
  label: string
  type?: string
  required?: boolean
}

type Props = {
  vars: RunVar[]
  onManage?: () => void
  /** compact for start node canvas */
  compact?: boolean
}

const TYPE_LABEL: Record<string, string> = {
  text: '文本',
  textarea: '多行',
  number: '数字',
  select: '下拉',
}

/** FastGPT-like global variable list (app run parameters). */
export function RunVarsPanel({ vars, onManage, compact }: Props) {
  if (compact) {
    if (!vars.length) {
      return <span className="wf-run-vars-compact-empty">暂无变量 · 在设置中添加</span>
    }
    return (
      <div className="wf-run-vars-compact" title="运行参数（全局变量）">
        {vars.slice(0, 4).map((v) => (
          <span key={v.name} className="wf-run-vars-chip">
            <Braces size={10} />
            {v.label || v.name}
          </span>
        ))}
        {vars.length > 4 ? <span className="wf-run-vars-chip is-more">+{vars.length - 4}</span> : null}
      </div>
    )
  }

  return (
    <div className="wf-run-vars-panel">
      <div className="wf-run-vars-panel-head">
        <span>运行变量（全局）</span>
        {onManage ? (
          <button type="button" className="wf-drawer-text-btn" onClick={onManage}>
            {vars.length ? '管理' : '添加变量'}
          </button>
        ) : null}
      </div>
      <p className="wf-drawer-tip" style={{ margin: '0 0 10px' }}>
        运行页由用户填写；步骤说明里输入 <kbd>/</kbd> 或点芯片插入 {'{{变量名}}'}。
      </p>
      {vars.length ? (
        <ul className="wf-run-vars-list">
          {vars.map((v) => (
            <li key={v.name} className="wf-run-vars-row">
              <div className="wf-run-vars-row-main">
                <span className="wf-run-vars-row-label">{v.label || v.name}</span>
                {v.required !== false ? <span className="wf-run-vars-req">必填</span> : null}
              </div>
              <code className="wf-run-vars-key">{`{{${v.name}}}`}</code>
              <span className="wf-run-vars-type">
                {TYPE_LABEL[String(v.type || 'text')] || String(v.type || 'text')}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="wf-run-vars-empty">还没有变量。添加后会出现在「流程开始」与各步骤的 / 引用列表中。</div>
      )}
    </div>
  )
}
