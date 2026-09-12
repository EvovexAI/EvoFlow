import { getPanelSetting, patchPanelSettings } from './panel-settings.js'

export function getWorkspaceIndexWatchEnabled() {
  return !!getPanelSetting('workspaceIndexWatchEnabled', false)
}

export function setWorkspaceIndexWatchEnabled(enabled) {
  void patchPanelSettings({ workspaceIndexWatchEnabled: !!enabled })
}
