/**
 * Computer Use safety chrome — blue breathing screen-edge glow + status pill.
 * Window is click-through / content-protected on the Tauri side.
 */

const style = document.createElement('style')
style.textContent = `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body {
    width: 100%;
    height: 100%;
    overflow: hidden;
    background: transparent !important;
    pointer-events: none;
    user-select: none;
    font-family: "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  }
  .glow {
    position: fixed;
    inset: 0;
    pointer-events: none;
    border-radius: 0;
    box-shadow:
      inset 0 0 0 3px rgba(59, 130, 246, 0.92),
      inset 0 0 28px 10px rgba(59, 130, 246, 0.45),
      inset 0 0 72px 28px rgba(37, 99, 235, 0.22);
    animation: cua-glow-breathe 2.2s ease-in-out infinite;
  }
  .pill {
    position: fixed;
    top: 18px;
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 16px;
    border-radius: 999px;
    background: rgba(15, 23, 42, 0.78);
    color: #f8fafc;
    font-size: 13px;
    font-weight: 600;
    letter-spacing: 0.01em;
    backdrop-filter: blur(10px);
    box-shadow:
      0 0 0 1px rgba(59, 130, 246, 0.55),
      0 8px 28px rgba(15, 23, 42, 0.35);
    white-space: nowrap;
    animation: cua-pill-breathe 2.2s ease-in-out infinite;
  }
  .pill-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #60a5fa;
    box-shadow: 0 0 10px 2px rgba(96, 165, 250, 0.85);
  }
  @keyframes cua-glow-breathe {
    0%, 100% {
      opacity: 0.78;
      box-shadow:
        inset 0 0 0 3px rgba(59, 130, 246, 0.88),
        inset 0 0 24px 8px rgba(59, 130, 246, 0.38),
        inset 0 0 64px 24px rgba(37, 99, 235, 0.18);
    }
    50% {
      opacity: 1;
      box-shadow:
        inset 0 0 0 4px rgba(96, 165, 250, 1),
        inset 0 0 36px 14px rgba(59, 130, 246, 0.55),
        inset 0 0 88px 36px rgba(37, 99, 235, 0.28);
    }
  }
  @keyframes cua-pill-breathe {
    0%, 100% { opacity: 0.9; }
    50% { opacity: 1; }
  }
`
document.head.appendChild(style)

const glow = document.createElement('div')
glow.className = 'glow'
glow.setAttribute('aria-hidden', 'true')
document.body.appendChild(glow)

const isZh =
  typeof navigator !== 'undefined' &&
  /^zh\b/i.test(String(navigator.language || navigator.languages?.[0] || ''))

const pill = document.createElement('div')
pill.className = 'pill'
pill.setAttribute('role', 'status')
pill.setAttribute('aria-live', 'polite')
pill.innerHTML = `<span class="pill-dot" aria-hidden="true"></span><span>${
  isZh ? 'EvoFlow 正在控制此电脑' : 'EvoFlow is using your computer'
}</span>`
document.body.appendChild(pill)
