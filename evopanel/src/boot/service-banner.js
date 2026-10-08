/**
 * EvoFlow 全局服务健康 banner（v3.5 阶段 F1 commit 4 抽出）。
 *
 * 设计动机:ChatApp 是按需懒加载(用户在非聊天路由时根本不 mount),
 * 单纯在 ChatApp 里显示 banner 不能覆盖"用户在别的页面"或"ChatApp 加载中"的场景。
 * 这个兜底 banner 始终在 DOM 中,跟随 service-health 状态机同步显示。
 *
 * 视觉差异:ChatApp 内的 banner(受 layout 控制)和本 banner(fixed 顶部)并存,二者 UI
 * 一致但不会冲突;通常 ChatApp mount 后用户视觉上只看到一个。
 *
 * 当前实现:兜底 host 已创建但**不挂 body**(// document.body.appendChild(host) 注释掉)
 * 因为侧栏底部已有小状态点。留 host 元素和 apply 逻辑用于调试可见性,
 * 未来若要恢复全屏 banner,把注释改回即可。
 */
import {
  startServiceHealthPoll,
  onServiceHealthChange,
  triggerServiceHealthCheck,
  ServiceHealthState,
} from '../lib/service-health.js'

let _globalRecoveryBannerInstalled = false

export function installGlobalServiceBanner() {
  if (_globalRecoveryBannerInstalled) return
  if (typeof document === 'undefined' || !document.body) return
  _globalRecoveryBannerInstalled = true

  const host = document.createElement('div')
  host.id = 'evoflow-global-recovery-banner-host'
  host.style.cssText = [
    'position:fixed',
    'top:0',
    'left:0',
    'right:0',
    'z-index:2147483000', // 高于 toast/modal
    'display:none',
    'pointer-events:none',
  ].join(';')

  const bar = document.createElement('div')
  bar.className = 'evoflow-global-recovery-banner'
  bar.setAttribute('role', 'status')
  bar.setAttribute('aria-live', 'polite')

  const dot = document.createElement('span')
  dot.className = 'evoflow-global-recovery-dot'
  const text = document.createElement('span')
  text.className = 'evoflow-global-recovery-text'
  const action = document.createElement('button')
  action.type = 'button'
  action.className = 'evoflow-global-recovery-action'
  action.style.cssText = 'pointer-events:auto;cursor:pointer;background:transparent;border:0;padding:0;font:inherit;color:inherit;text-decoration:underline;text-underline-offset:2px;'
  action.textContent = '点击重试'
  action.addEventListener('click', () => {
    void triggerServiceHealthCheck({ manual: true })
  })

  bar.append(dot, text, action)
  host.appendChild(bar)
  // 侧栏底部已有小状态点，不需要全屏 banner；留 host 用于调试可见性
  // host.style.display = 'none' // 注释掉：完全不挂载，不占 DOM
  // document.body.appendChild(host) // 禁用全屏 banner

  let lastShown = null
  const apply = (state) => {
    if (state === ServiceHealthState.UNAVAILABLE) {
      bar.classList.add('evoflow-global-recovery-banner--unavailable')
      bar.classList.remove('evoflow-global-recovery-banner--degraded')
      text.textContent = '服务未启动或暂时不可用，请检查服务状态'
      action.style.display = ''
      action.disabled = false
      action.textContent = '点击重试'
      host.style.display = 'block'
      lastShown = ServiceHealthState.UNAVAILABLE
    } else if (state === ServiceHealthState.DEGRADED) {
      bar.classList.add('evoflow-global-recovery-banner--degraded')
      bar.classList.remove('evoflow-global-recovery-banner--unavailable')
      text.textContent = '服务正在初始化中，请稍候'
      action.style.display = ''
      action.disabled = true
      action.textContent = '初始化中…'
      host.style.display = 'block'
      lastShown = ServiceHealthState.DEGRADED
    } else {
      host.style.display = 'none'
      lastShown = null
    }
  }

  // 启动轮询 + 订阅
  startServiceHealthPoll()
  onServiceHealthChange((snap) => apply(snap.state))
  void apply(ServiceHealthState.UNKNOWN)
}
