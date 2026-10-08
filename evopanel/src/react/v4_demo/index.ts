/**
 * H1 demo: 极简 v4 渲染层入口。
 */

const H1_CSS = `
.h1-mini-session-pane {
  position: fixed;
  right: 16px;
  bottom: 16px;
  width: 420px;
  max-height: 70vh;
  background: #0d1117;
  color: #e6edf3;
  border: 1px solid #30363d;
  border-radius: 8px;
  font-family: 'SF Mono', Menlo, Consolas, monospace;
  font-size: 12px;
  display: flex;
  flex-direction: column;
  z-index: 1000;
  box-shadow: 0 12px 32px rgba(0,0,0,0.4);
}
.h1-mini-session-pane .h1-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid #30363d;
  background: #161b22;
  border-radius: 8px 8px 0 0;
}
.h1-mini-session-pane .h1-header strong { color: #58a6ff; }
.h1-mini-session-pane .h1-status {
  padding: 1px 6px;
  border-radius: 4px;
  background: #1f6feb;
  color: white;
  font-weight: 600;
}
.h1-mini-session-pane[data-h1-status="error"] .h1-status { background: #da3633; }
.h1-mini-session-pane[data-h1-status="closed"] .h1-status { background: #6e7681; }
.h1-mini-session-pane .h1-seq,
.h1-mini-session-pane .h1-rows,
.h1-mini-session-pane .h1-session {
  color: #8b949e;
  font-size: 11px;
}
.h1-mini-session-pane .h1-reset {
  margin-left: auto;
  background: #21262d;
  color: #e6edf3;
  border: 1px solid #30363d;
  padding: 2px 8px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 11px;
}
.h1-mini-session-pane .h1-error {
  background: #4c1d1d;
  color: #ff7b72;
  padding: 6px 12px;
  font-size: 11px;
  border-bottom: 1px solid #f85149;
}
.h1-mini-session-pane .h1-rows-list {
  list-style: none;
  margin: 0;
  padding: 8px 12px;
  overflow-y: auto;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.h1-mini-session-pane .h1-row {
  padding: 6px 8px;
  border: 1px solid #30363d;
  border-radius: 6px;
  background: #0d1117;
}
.h1-mini-session-pane .h1-tag {
  display: inline-block;
  padding: 1px 6px;
  border-radius: 3px;
  background: #1f6feb;
  color: white;
  font-size: 10px;
  font-weight: 600;
  margin-bottom: 4px;
}
.h1-mini-session-pane .h1-turn-header .h1-tag { background: #6e7681; }
.h1-mini-session-pane .h1-user .h1-tag { background: #1f883d; }
.h1-mini-session-pane .h1-reasoning .h1-tag { background: #9e6a03; }
.h1-mini-session-pane .h1-assistant .h1-tag { background: #8957e5; }
.h1-mini-session-pane .h1-tool .h1-tag { background: #db6d28; }
.h1-mini-session-pane .h1-text {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: inherit;
  color: #e6edf3;
}
.h1-mini-session-pane .h1-empty { color: #6e7681; font-style: italic; }
.h1-mini-session-pane .h1-tool-name { color: #58a6ff; margin-left: 4px; }
.h1-mini-session-pane .h1-state { color: #8b949e; margin-left: 6px; }
.h1-mini-session-pane .h1-elapsed { color: #8b949e; margin-left: 6px; font-size: 10px; }
.h1-mini-session-pane .h1-composer {
  display: flex;
  gap: 6px;
  padding: 8px 12px;
  border-top: 1px solid #30363d;
  background: #161b22;
  border-radius: 0 0 8px 8px;
}
.h1-mini-session-pane .h1-composer input {
  flex: 1;
  background: #0d1117;
  border: 1px solid #30363d;
  color: #e6edf3;
  padding: 6px;
  font-family: inherit;
  font-size: 12px;
  border-radius: 4px;
}
.h1-mini-session-pane .h1-composer button {
  background: #238636;
  color: white;
  border: none;
  padding: 6px 12px;
  border-radius: 4px;
  cursor: pointer;
}
.h1-mini-session-pane .h1-composer button:disabled {
  background: #30363d;
  cursor: not-allowed;
}
`

let injected = false
function injectCssOnce() {
  if (injected || typeof document === 'undefined') return
  injected = true
  const style = document.createElement('style')
  style.setAttribute('data-h1-mini-css', 'true')
  style.textContent = H1_CSS
  document.head.appendChild(style)
}

function CssBootstrap() {
  injectCssOnce()
  return null
}

export { MiniSessionPane } from './MiniSessionPane'
export { H1V4Client, h1V4Client } from './client'
export { ConversationProjectionStore } from './projection'
export type {
  AssistantTextRow,
  ConversationDelta,
  ConversationDeltas,
  ConversationFramePayload,
  ConversationRow,
  ConversationSnapshot,
  ConversationTopicFrame,
  ReasoningRow,
  RowKind,
  RowsWindow,
  SessionHandle,
  ToolCallRow,
  TurnHeaderRow,
  UserInputRow,
  V4ConversationSubscribeAck,
  DeltaAppended,
  DeltaRemoved,
  DeltaUpserted,
} from './protocol'
export type { ProjectionSnapshot, ProjectionState, ProjectionStatus } from './projection'

// CSS bootstrap — mounted alongside MiniSessionPane by ChatApp.
export const H1CssBootstrap = CssBootstrap