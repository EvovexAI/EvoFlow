/** 添加/编辑模型时的上下文长度默认值（与后端 DEFAULT_CONTEXT_LENGTH 对齐时可改 backend 侧常量） */
export const DEFAULT_MODEL_CONTEXT_WINDOW = 256_000

/** 单次输出 token 上限（固定，不在 UI 暴露；与 backend DEFAULT_MODEL_MAX_OUTPUT_TOKENS 一致） */
export const DEFAULT_MODEL_MAX_OUTPUT_TOKENS = 65536

/** 上下文长度快捷档位（tokens） */
export const MODEL_CONTEXT_TIERS = [
  { label: '8K', tokens: 8_192 },
  { label: '32K', tokens: 32_768 },
  { label: '128K', tokens: 128_000 },
  { label: '256K', tokens: 256_000 },
  { label: '512K', tokens: 512_000 },
  { label: '1M', tokens: 1_000_000 },
]

function escAttr(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function escHtml(s) {
  return escAttr(s)
}

/**
 * @param {{ name?: string, label: string, value?: string | number, hint?: string, placeholder?: string }} opts
 */
export function buildContextWindowFieldHtml(opts) {
  const name = opts.name || 'contextWindow'
  const value = String(opts.value ?? DEFAULT_MODEL_CONTEXT_WINDOW)
  const chips = MODEL_CONTEXT_TIERS.map(({ label, tokens }) => {
    const selected = Number(value) === tokens
    return `<button type="button" class="models-context-tier-chip${selected ? ' selected' : ''}" data-context-tier="${tokens}">${escHtml(label)}</button>`
  }).join('')
  return `
    <div class="form-group models-context-window-field" data-context-window-field>
      <label class="form-label">${escHtml(opts.label)}</label>
      <div class="models-context-tier-row" role="group" aria-label="上下文长度快捷选择">
        ${chips}
      </div>
      <input class="form-input" data-name="${escAttr(name)}" value="${escAttr(value)}" placeholder="${escAttr(opts.placeholder || '如 256000')}">
      ${opts.hint ? `<div class="form-hint">${escHtml(opts.hint)}</div>` : ''}
    </div>`
}

/** @param {ParentNode} root */
export function bindContextWindowPresets(root) {
  root.querySelectorAll('[data-context-window-field]').forEach((field) => {
    const input = field.querySelector('[data-name="contextWindow"]')
    if (!input) return
    const chips = [...field.querySelectorAll('[data-context-tier]')]

    const syncSelected = () => {
      const n = parseInt(input.value, 10)
      chips.forEach((chip) => {
        chip.classList.toggle('selected', Number(chip.dataset.contextTier) === n)
      })
    }

    chips.forEach((chip) => {
      chip.addEventListener('click', () => {
        input.value = chip.dataset.contextTier
        syncSelected()
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
    })
    input.addEventListener('input', syncSelected)
    syncSelected()
  })
}
