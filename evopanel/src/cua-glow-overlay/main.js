/**
 * Windows CUA 顶部操作提示 — 对齐 ZCode windowsCuaOperationIndicatorContent。
 * 「EvoFlow 正在操作电脑」+ 三点呼吸；点击穿透 / 截图排除由宿主窗口负责。
 */

const isZh =
  typeof navigator !== 'undefined' &&
  /^zh\b/i.test(String(navigator.language || navigator.languages?.[0] || ''))

const text = isZh ? 'EvoFlow 正在操作电脑' : 'EvoFlow is controlling your computer'

const style = document.createElement('style')
style.textContent = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  html, body {
    width: 100%; height: 100%; margin: 0; overflow: hidden;
    background: transparent !important; pointer-events: none; user-select: none;
  }
  body {
    display: flex; align-items: center; justify-content: center;
    padding: 6px 8px 12px;
    font-family: "Segoe UI Variable", "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  }
  .indicator {
    display: flex; align-items: center; justify-content: center; gap: 10px;
    width: 100%; height: 38px; padding: 0 18px;
    color: #202124; background: rgba(255, 255, 255, 0.96);
    border: 1px solid rgba(15, 23, 42, 0.14); border-radius: 12px;
    box-shadow: 0 1px 2px rgba(15, 23, 42, 0.08), 0 6px 12px -6px rgba(15, 23, 42, 0.18);
    font-size: 13px; font-weight: 600; line-height: 1; white-space: nowrap;
    opacity: 1; transform: translateY(0);
    transition: opacity 120ms ease, transform 120ms ease;
    animation: enter 140ms ease-out both;
  }
  .dots { display: flex; align-items: center; gap: 3px; }
  .dot {
    width: 4px; height: 4px; border-radius: 50%; background: #64748b;
    animation: pulse 1.2s ease-in-out infinite;
  }
  .dot:nth-child(2) { animation-delay: 120ms; }
  .dot:nth-child(3) { animation-delay: 240ms; }
  html[data-state="leaving"] .indicator { opacity: 0; transform: translateY(-6px); }
  @keyframes enter {
    from { opacity: 0; transform: translateY(-6px); }
    to { opacity: 1; transform: translateY(0); }
  }
  @keyframes pulse {
    0%, 70%, 100% { opacity: .35; transform: scale(.8); }
    35% { opacity: 1; transform: scale(1); }
  }
  @media (prefers-color-scheme: dark) {
    .indicator {
      color: #f8fafc; background: rgba(35, 38, 43, 0.96);
      border-color: rgba(255, 255, 255, 0.14);
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.18), 0 6px 12px -6px rgba(0, 0, 0, 0.28);
    }
    .dot { background: #a8b3c4; }
  }
  @media (prefers-reduced-motion: reduce) {
    .indicator, .dot { animation: none; transition: opacity 1ms linear; transform: none; }
    html[data-state="leaving"] .indicator { transform: none; }
  }
`
document.head.appendChild(style)
document.documentElement.dataset.state = 'active'
document.documentElement.lang = isZh ? 'zh-CN' : 'en'

const root = document.createElement('div')
root.className = 'indicator'
root.setAttribute('role', 'status')
root.setAttribute('aria-live', 'polite')
root.innerHTML =
  '<span class="dots" aria-hidden="true"><span class="dot"></span><span class="dot"></span><span class="dot"></span></span>' +
  `<span>${text}</span>`
document.body.appendChild(root)

window.__cuaGlowOverlay = {
  setActive() {
    document.documentElement.dataset.state = 'active'
  },
  setLeaving() {
    document.documentElement.dataset.state = 'leaving'
  },
}
