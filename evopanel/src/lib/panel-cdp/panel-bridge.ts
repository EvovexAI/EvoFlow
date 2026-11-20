/**
 * ChatApp / shell register handlers so panel CDP can send / select / compose
 * without scraping DOM.
 */

export type PanelChatBridge = {
  sendMessage?: (text: string) => void | Promise<void>
  selectSession?: (sessionKey: string) => void | Promise<void>
  setComposerText?: (text: string) => void
  focusComposer?: () => void
  isStreaming?: () => boolean
}

let bridge: PanelChatBridge = {}

export function registerPanelChatBridge( partial: PanelChatBridge): void {
  bridge = { ...bridge, ...partial }
}

export function clearPanelChatBridge(): void {
  bridge = {}
}

export function getPanelChatBridge(): PanelChatBridge {
  return bridge
}
