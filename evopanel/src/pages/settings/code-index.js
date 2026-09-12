/**
 * 设置：代码索引图谱（独立菜单，复用观测页 CodeIndexGraph）
 */
import { mountUsageCodeIndexPanel, unmountUsageCodeIndexPanel } from './UsageCodeIndexPanel.tsx'

/**
 * @param {HTMLElement} container
 */
export async function mountCodeIndexInto(container) {
  container.classList.add('settings-modal-pane--code-index')
  container.innerHTML = `
    <div class="settings-code-index-page">
      <div class="settings-code-index-head">
        <h2 class="settings-usage-title">代码索引图谱</h2>
        <p class="settings-usage-desc">查看工作空间的导入关系、引用链与类型继承（与运维观测同源）。</p>
      </div>
      <div class="settings-usage-card su-code-index-card">
        <div id="settings-code-index-host" class="su-code-index-host"></div>
      </div>
    </div>
  `
  const host = container.querySelector('#settings-code-index-host')
  if (host) mountUsageCodeIndexPanel(host)
}

export function cleanup() {
  unmountUsageCodeIndexPanel()
}
