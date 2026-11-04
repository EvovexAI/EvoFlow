// @ts-nocheck — mechanical P90 extract.
/**
 * Chat summary / employee / task float panel. Extracted from ChatApp.tsx (P90).
 */
import type { ReactNode } from 'react'
import { ChatSummaryPanel } from '../../components/ChatSummaryPanel.js'
import {
  DeptGroupPane,
  EmployeePane,
  TaskPane,
} from '../../components/ChatWorkspaceInfoRail.js'
import { isDeptChatSessionKey } from '../../lib/dept-chat-session.js'

export type RenderChatSummaryPanelCtx = Record<string, any>

export function renderChatSummaryPanel(
  ctx: RenderChatSummaryPanelCtx,
  mode: 'panel' | 'capsule',
): ReactNode {
  const {
    applySessionThinkingPref,
    applySessionMemoryPref,
    memoryEnabled,
    setMemoryEnabled,
    artifactFocusId,
    assetQuickBusy,
    capabilityPatchBusy,
    currentAgentCapabilities,
    currentRoleAgent,
    currentRoleCodeForUi,
    currentRoleLabel,
    displayContextUsage,
    effectiveModelName,
    effectiveModelSupportsThinking,
    employeeRoleDetail,
    employeeSessionAgentCode,
    getDisplayLabel,
    handleAssetQuickAction,
    handleManualContextCompact,
    handleOpenProcessItem,
    handleStopProcessItem,
    headerTokenTotals,
    isProactiveEmployeeSession,
    isDeptChatSurface,
    liveProcessSnapshot,
    manualContextCompacting,
    modelPillLabel,
    obsEnabled,
    openCurrentAgentEditor,
    openSessionArtifact,
    patchCurrentAgentCapabilities,
    platformFocusEntryId,
    revealSessionArtifact,
    selectedSessionKey,
    selectedThreadId,
    selectedTurnBusy,
    sessionArtifacts,
    sessionPlatformEntries,
    sessionThinkingPref,
    sessions,
    setChatPanelDisplayMode,
    setRoleUiNonce,
    sharedCollabSubtasks,
    sidebarActiveView,
    turnArtifacts,
    turnPlatformEntries,
  } = ctx
  const sessionKey = String(selectedSessionKey || '')
  const deptChat =
    typeof isDeptChatSurface === 'boolean'
      ? isDeptChatSurface
      : isDeptChatSessionKey(sessionKey)
  const refreshRolePrefs = () => {
    if (typeof setRoleUiNonce === 'function') setRoleUiNonce((n) => n + 1)
  }
  return (
    <ChatSummaryPanel
      key={sessionKey}
      displayMode={mode}
      onDisplayModeChange={setChatPanelDisplayMode}
      isRunning={selectedTurnBusy}
      sessionKey={sessionKey}
      sessionTitle={getDisplayLabel(
        selectedSessionKey,
        sessions.find((s) => String(s.sessionKey || '') === sessionKey)?.title,
      )}
      terminalStreams={liveProcessSnapshot.terminalStreams}
      subagentTasks={liveProcessSnapshot.subagentTasks}
      workflowSubtasks={sharedCollabSubtasks}
      backgroundWorks={liveProcessSnapshot.backgroundWorks}
      onOpenProcessItem={handleOpenProcessItem}
      onStopProcessItem={handleStopProcessItem}
      agentLabel={deptChat ? getDisplayLabel(selectedSessionKey, '') : currentRoleLabel}
      modelLabel={modelPillLabel}
      modelName={effectiveModelName}
      agentCode={
        isProactiveEmployeeSession
          ? employeeSessionAgentCode || currentRoleCodeForUi
          : currentRoleCodeForUi
      }
      agentDescription={String(currentRoleAgent?.description || '').trim()}
      agent={currentRoleAgent}
      skillNames={currentAgentCapabilities.skillNames}
      toolNames={currentAgentCapabilities.toolNames}
      mcpServers={currentAgentCapabilities.mcpServers}
      knowledgeVaultIds={
        isProactiveEmployeeSession
          ? employeeRoleDetail?.knowledgeVaultIds || []
          : currentAgentCapabilities.knowledgeVaultIds
      }
      onPatchCapabilities={patchCurrentAgentCapabilities}
      capabilityBusy={capabilityPatchBusy}
      onSwitchAgent={undefined}
      onEditAgent={
        deptChat
          ? undefined
          : currentRoleCodeForUi || employeeSessionAgentCode
            ? openCurrentAgentEditor
            : undefined
      }
      modelSupportsThinking={effectiveModelSupportsThinking}
      sessionThinkingPref={sessionThinkingPref || 'follow'}
      sessionMemoryEnabled={memoryEnabled !== false}
      onApplySessionThinking={applySessionThinkingPref}
      onApplySessionMemory={applySessionMemoryPref}
      onMemoryEnabledChange={setMemoryEnabled}
      onAssetQuickAction={deptChat ? undefined : handleAssetQuickAction}
      assetQuickBusy={assetQuickBusy}
      artifacts={sessionArtifacts}
      recentArtifacts={turnArtifacts}
      artifactFocusId={artifactFocusId}
      platformEntries={sessionPlatformEntries}
      recentPlatformEntries={turnPlatformEntries}
      platformFocusEntryId={platformFocusEntryId}
      onOpenArtifact={openSessionArtifact}
      onRevealArtifact={revealSessionArtifact}
      obsEnabled={obsEnabled}
      threadId={selectedThreadId}
      isEmployeeSession={isProactiveEmployeeSession && !deptChat}
      isDeptChatSession={deptChat}
      deptPane={deptChat && sessionKey ? <DeptGroupPane sessionKey={sessionKey} /> : null}
      employeePane={
        isProactiveEmployeeSession && !deptChat ? (
          <EmployeePane
            employeeInfo={employeeRoleDetail}
            sessionTitle={getDisplayLabel(selectedSessionKey, '')}
            isRunning={selectedTurnBusy}
            agentLabel={currentRoleLabel}
            modelLabel={modelPillLabel}
            agentCode={employeeSessionAgentCode || currentRoleCodeForUi}
            agentDescription={String(currentRoleAgent?.description || '').trim()}
            agent={currentRoleAgent}
            skillNames={currentAgentCapabilities.skillNames}
            toolNames={currentAgentCapabilities.toolNames}
            mcpServers={currentAgentCapabilities.mcpServers}
            knowledgeVaultIds={
              employeeRoleDetail?.knowledgeVaultIds ||
              currentAgentCapabilities.knowledgeVaultIds
            }
            onPatchCapabilities={patchCurrentAgentCapabilities}
            capabilityBusy={capabilityPatchBusy}
            modelName={effectiveModelName}
            contextUsage={displayContextUsage}
            tokenTotals={headerTokenTotals}
            onManualCompact={handleManualContextCompact}
            manualCompactDisabled={manualContextCompacting}
            onEditAgent={openCurrentAgentEditor}
            onAssetQuickAction={handleAssetQuickAction}
            assetQuickBusy={assetQuickBusy}
            modelSupportsThinking={effectiveModelSupportsThinking}
            onRolePrefsSaved={refreshRolePrefs}
            onMemoryEnabledChange={setMemoryEnabled}
            sessionKey={sessionKey}
          />
        ) : null
      }
      taskPane={
        isProactiveEmployeeSession && !deptChat ? (
          <TaskPane
            sessionTitle={getDisplayLabel(selectedSessionKey, '')}
            isRunning={selectedTurnBusy}
            tokenTotals={headerTokenTotals}
            agentCode={employeeSessionAgentCode || currentRoleCodeForUi}
            sessionKey={sessionKey}
            liveTask={sidebarActiveView?.task || null}
          />
        ) : null
      }
    />
  )
}
