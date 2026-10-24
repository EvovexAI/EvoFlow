/**
 * 壳层布局变更通知。
 *
 * 原生 browser-embed HWND 不吃 CSS：凡是会改槽位四角的 chrome
 * （侧栏折叠、右栏拖宽、小V 侧栏、界面缩放、主窗几何）都应调用本模块，
 * 让 BrowserPanel 重新量槽位并 setBounds。
 */
export function notifyLayoutChromeChanged(reason = 'layout') {
  try {
    window.dispatchEvent(
      new CustomEvent('evopanel:layout-chrome', {
        detail: { reason: String(reason || 'layout'), at: Date.now() },
      }),
    )
  } catch {
    /* ignore */
  }
}
