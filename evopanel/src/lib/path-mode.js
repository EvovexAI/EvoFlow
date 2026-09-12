import { getPanelSetting, patchPanelSettings } from './panel-settings.js'

export function getUseVirtualPaths() {
  return !!getPanelSetting('useVirtualPaths', false)
}

export function setUseVirtualPaths(enabled) {
  void patchPanelSettings({ useVirtualPaths: !!enabled })
}
