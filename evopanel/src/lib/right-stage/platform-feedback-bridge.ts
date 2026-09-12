/** ChatApp registers Info Rail sync; ToolCallList calls requestOpenPlatformFeedbackFromTool. */

import type { PlatformRunEntry } from './platform-feedback.js'
import {
  canOpenPlatformFeedbackFromTool,
  openPlatformFeedbackFromTool,
} from './platform-feedback.js'

export { canOpenPlatformFeedbackFromTool }

type OpenHandler = (tool: Record<string, unknown>, existingEntries: PlatformRunEntry[]) => void

type EntriesProvider = () => PlatformRunEntry[]

let openHandler: OpenHandler | null = null
let entriesProvider: EntriesProvider | null = null

export function registerPlatformFeedbackOpenHandler(
  handler: OpenHandler | null,
  getEntries?: EntriesProvider | null,
): void {
  openHandler = handler
  entriesProvider = getEntries || null
}

export function requestOpenPlatformFeedbackFromTool(tool: Record<string, unknown>): boolean {
  if (!canOpenPlatformFeedbackFromTool(tool)) return false
  const existingEntries = entriesProvider?.() || []
  if (openHandler) {
    openHandler(tool, existingEntries)
    return true
  }
  return Boolean(openPlatformFeedbackFromTool(tool, existingEntries))
}
