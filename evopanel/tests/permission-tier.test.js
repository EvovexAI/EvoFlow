import { describe, expect, it } from 'vitest'
import {
  PERMISSION_PRESETS,
  PERMISSION_PRESET_DEFAULT,
  PERMISSION_PRESET_FULL_ACCESS,
  PERMISSION_PRESET_READ_ONLY,
  permissionPresetLabel,
  formatPermissionPresetHint,
  resolvePermissionPreset,
} from '../src/lib/permission-tier.js'
import {
  TOOL_APPROVAL_POLICY_GRANT_ALL,
  TOOL_APPROVAL_POLICY_PROMPT,
  TOOL_APPROVAL_POLICY_SESSION,
} from '../src/lib/tool-approval-settings.js'

describe('permission preset', () => {
  it('maps session context to runtime presets', () => {
    expect(resolvePermissionPreset({ permission_preset: PERMISSION_PRESET_FULL_ACCESS })).toBe(
      PERMISSION_PRESET_FULL_ACCESS,
    )
    expect(
      resolvePermissionPreset({
        permission_preset: PERMISSION_PRESET_FULL_ACCESS,
        effective_permission_preset: PERMISSION_PRESET_READ_ONLY,
      }),
    ).toBe(PERMISSION_PRESET_READ_ONLY)
    expect(resolvePermissionPreset({ tool_approval_policy: TOOL_APPROVAL_POLICY_PROMPT })).toBe(
      PERMISSION_PRESET_READ_ONLY,
    )
    expect(resolvePermissionPreset({ effective_tool_approval_policy: TOOL_APPROVAL_POLICY_SESSION })).toBe(
      PERMISSION_PRESET_DEFAULT,
    )
  })

  it('exposes runtime preset labels', () => {
    expect(PERMISSION_PRESETS).toHaveLength(3)
    expect(permissionPresetLabel(PERMISSION_PRESET_READ_ONLY)).toBe('只读')
    expect(PERMISSION_PRESETS.find((p) => p.id === PERMISSION_PRESET_DEFAULT)?.pillLabel).toBe('帮我批准')
    expect(formatPermissionPresetHint(PERMISSION_PRESET_FULL_ACCESS, { enabled: true, profile: 'danger-full-access' })).toContain(
      '不询问',
    )
  })
})
