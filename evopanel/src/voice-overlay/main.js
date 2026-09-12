import { VoiceVisualizer, createVoiceHudElement, VOICE_VISUALIZER_STYLES } from '../lib/voice-visualizer.js'

const style = document.createElement('style')
style.textContent = `
  * { margin: 0; padding: 0; box-sizing: border-box; border: none; outline: none; }
  html, body {
    width: 100%; height: 100%;
    background: transparent !important;
    overflow: hidden;
    user-select: none;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
  }
  .container {
    width: auto;
    height: auto;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    background: transparent;
    border: none;
    box-shadow: none;
  }
  .voice-orb-panel__transcript { display: none !important; }
  ${VOICE_VISUALIZER_STYLES}
`
document.head.appendChild(style)

const mount = document.createElement('div')
mount.className = 'container'
const hud = createVoiceHudElement({ standalone: true })
mount.appendChild(hud)
document.body.appendChild(mount)

const viz = new VoiceVisualizer(hud)
viz.start()

window.__voiceOverlay = {
  setProcessing() {
    viz.setState('processing')
  },
  reset() {
    viz.reset()
  },
}
