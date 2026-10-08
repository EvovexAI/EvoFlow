/* eslint-disable max-lines -- host process 服务注册和启动装配需要集中维护，拆散后会更难追踪依赖注入顺序 */
// Node.js service implementations — NOT safe to import in browser code
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  createNodeProviderRuntimePathEnv,
  NodeModelSelectionConfigRepository,
  PERSONAL_PROVIDER_CONFIG_FILE_NAME,
} from "@zcode/provider-node";
import { getAppConfigDir as resolveAppConfigDir } from "./paths.js";
import {
  buildLocalMediaPreviewUrl,
  isProviderProvisioningAccountCredentialKey,
  type ProviderProvisioningTrigger,
} from "@zcode/shared";

export {
  materializeZCodeBuiltinProviderConfig,
  ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV,
} from "@zcode/provider-node";

export { createFileService } from "./file/fileService.js";
export {
  attributeHostProcessTree,
  createProcessResourceSampler,
  createProcessResourceTableReader,
  type HostResourceUsageAgent,
  type ProcessResourceSample,
  type ProcessResourceSampler,
} from "./process/processResourceSampler.js";
export { createMediaPreviewService } from "./media-preview/mediaPreview.js";
export type { CreateFileServiceOptions } from "./file/fileService.js";
export {
  defaultWorkspaceFileSearchFilter,
  type WorkspaceFileSearchDecision,
  type WorkspaceFileSearchEntry,
  type WorkspaceFileSearchFilter,
} from "./file/workspaceFileMentionFilter.js";
export {
  createFsFaultInjector,
  getProcessFsFaultInjector,
  maybeThrowInjectedFsFault,
  parseFsFaultRulesFromEnvValue,
  resetProcessFsFaultInjectorForTests,
  setFsFaultInjectorForTests,
  ZCODE_E2E_FS_FAULTS_ALLOW_ENV,
  ZCODE_E2E_FS_FAULTS_ENV,
} from "./fs/fsFaultInjection.js";
export type {
  FsFaultCheckInput,
  FsFaultHit,
  FsFaultInjector,
  FsFaultOperation,
  FsFaultRuleConfig,
  InjectedFsFaultError,
} from "./fs/fsFaultInjection.js";
export {
  setDataBaseDir,
  getDataBaseDir,
  getZCodeDataRootDir,
  getConversationWorkspaceDir,
  getAppConfigDir,
  getExportLogStageDir,
  getExportLogDir,
  getFeedbackRootDir,
  getFeedbackAttachmentDir,
  getFeedbackLogArchiveDir,
  getGitCheckpointIndexRootDir,
  copyDataDirectory,
  validateDataBaseDirTarget,
  ZCODE_WINDOWS_APP_INSTALL_DIR_ENV,
} from "./paths.js";
export { createGitService } from "./git/gitService.js";
export { GitCommitMessageGenerator } from "./git/gitCommitMessageGenerator.js";
export { createGitCheckpointService } from "./git/gitCheckpointService.js";
export { createSystemService } from "./system/systemService.js";
export { listSSHConfigAliasesFromLocalConfig } from "./system/sshConfigAlias.js";
export { createTerminalService } from "./terminal/terminalService.js";
export {
  createSettingService,
  createSettingServiceWithMigrations,
} from "./setting/settingService.js";
export { createCredentialService } from "./credential/credentialService.js";
export { createBroadcastService } from "./broadcast/broadcastService.js";
export { createZCodeAgentService } from "./zcode-agent/zcodeAgentService.js";
export { createZCodeTaskServiceAdapter } from "./zcode-agent/zcodeTaskServiceAdapter.js";
export { createZCodeSessionService } from "./zcode-session/zcodeSessionService.js";
export {
  resolveDefaultZCodeAgentCommand,
  ZCodeAgentProcessManager,
} from "./zcode-agent/zcodeAgentProcessManager.js";
export type {
  ZCodeAgentCommand,
  ZCodeAgentCommandResolver,
  ZCodeAgentCommandResolverContext,
  ZCodeAgentProcessManagerOptions,
} from "./zcode-agent/zcodeAgentProcessManager.js";
export { ZCodeProtocolClient } from "./zcode-agent/zcodeProtocolClient.js";
export type { ZCodeProtocolTransport } from "./zcode-agent/zcodeProtocolTransport.js";
export { ZCodeStdioTransport } from "./zcode-agent/zcodeStdioTransport.js";
export {
  getZCodeStdioTapDevLogDir,
  readZCodeStdioTapDevState,
  setZCodeStdioTapDevEnabled,
} from "./zcode-agent/zcodeStdioTapDevConfig.js";
export type { ZCodeStdioTapDevState } from "@zcode/shared";
export {
  createCuaHelperInstaller,
  requestHelperAccessibilityPermissionViaLaunchServices,
  requestHelperScreenRecordingPermissionViaLaunchServices,
} from "./cua-permission-broker/index.js";
export {
  canonicalizeCuaHelperInstallerOptions,
  createCanonicalCuaHelperInstaller,
  normalizeCuaHelperArch,
  normalizeCuaHelperArchs,
} from "./cua-permission-broker/cuaHelperInstaller.js";
export type {
  CuaHelperInstaller,
  CuaHelperInstallerOptions,
} from "./cua-permission-broker/index.js";
export { createBotsService } from "./bots/botsService.js";
export { createFileWatcherService } from "./fileWatcher/fileWatcherService.js";
export { createOAuthService } from "./oauth/oauthService.js";
export { createOAuthProviderLogoutHandler } from "./oauth/oauthProviderLogout.js";
export { OAuthCredentialRepo } from "./oauth/repo/oauthCredentialRepo.js";
export { ensureDeviceMid } from "./device/deviceMid.js";
export type { EnsureDeviceMidOptions } from "./device/deviceMid.js";
export { createTelemetryCore, ensureTelemetryDeviceMid } from "./telemetry/telemetryCore.js";
export type { EnsureTelemetryDeviceMidOptions } from "./telemetry/telemetryCore.js";
export type { AccountRequestAuthResolver } from "./model-provider/accountProviderRequestAuthService.js";
export { createAccountProviderCredentialStore } from "./model-provider/accountProviderCredentialStore.js";
export type {
  AccountProviderCredentialStore,
  AccountProviderCredentialStoreOptions,
} from "./model-provider/accountProviderCredentialStore.js";
export { importLegacyPersonalProviderConfig } from "./model-provider/legacyPersonalProviderConfigImporter.js";
export {
  createAccountProviderConfigSource,
  createAccountProviderConnectionResolver,
  createCodingPlanFamilyAvailabilityResolver,
  resolveCurrentAccountAccess,
} from "./model-provider/accountProviderConnectionResolver.js";
export { bindAccountProviderInvalidation } from "./model-provider/accountProviderInvalidation.js";
export type {
  AccountProviderConfigSourceOptions,
  AccountProviderConnectionResolverOptions,
  AccountProviderConnectionSettings,
  AccountProviderFamilyAvailabilityInput,
  AccountProviderFamilyAvailabilityResolver,
  CodingPlanFamilyAvailabilityResolverOptions,
} from "./model-provider/accountProviderConnectionResolver.js";
export {
  createProviderConfigRuntime,
  ProviderConfigRuntime,
} from "./model-provider/providerConfigRuntime.js";
export type { ProviderConfigRuntimeOptions } from "./model-provider/providerConfigRuntime.js";
export {
  createProviderRuntime,
  createProviderRuntimeFromConfigRuntime,
  EmptyAccountProviderConfigSource,
  ProviderRuntime,
} from "./model-provider/providerRuntime.js";
export type {
  ProviderRuntimeDependencies,
  ProviderRuntimeOptions,
} from "./model-provider/providerRuntime.js";
export {
  createProviderProvisioningSource,
  listProviderProvisioningCredentialKeys,
  resolveCredentialFilePath,
  type ProviderProvisioningSource,
  type ProviderProvisioningSourceOptions,
} from "./model-provider/providerProvisioningSource.js";
export {
  createProviderProvisioningTarget,
  type ProviderProvisioningTargetOptions,
} from "./model-provider/providerProvisioningTarget.js";
export {
  createModelSelectionService,
  createProviderSettingsService,
  IModelSelectionService,
  IProviderSettingsService,
} from "./model-provider/providerFacadeServices.js";
export { createAccountRequestAuthService } from "./model-provider/accountRequestAuthService.js";
export type { IAccountRequestAuthService } from "./model-provider/accountRequestAuthService.js";
export { createAccountProviderRequestAuthService } from "./model-provider/accountProviderRequestAuthService.js";
export { resolveAccountTeamPlanRuntimeApiKey } from "./model-provider/accountProviderTeamPlanRequestKey.js";
export { createAccountProviderCredentialService } from "./model-provider/accountProviderCredentialService.js";
export { createUsageStatsService } from "./usage-stats/usageStatsService.js";
// Storage：service 与 adapters 工厂；desktop host 负责组装（Worker runner 在 desktop 包内）
export { createStorageService } from "./storage/app/storageService.js";
export type {
  FsCleanerPort as StorageFsCleanerPort,
  RootsResolverPort as StorageRootsResolverPort,
  ScanRunnerPort as StorageScanRunnerPort,
  StorageScanProgress,
  StorageScanRunRequest,
} from "./storage/app/ports.js";
export { createFsStorageCleaner } from "./storage/adapters/fsCleaner.js";
export {
  createStorageRootsResolver,
  resolveStorageRoots,
} from "./storage/adapters/rootsResolver.js";
export { createFsVolumeProbe } from "./storage/adapters/volumeProbe.js";
export { runStorageScan } from "./storage/adapters/inProcessScanRunner.js";
export { createCodingPlanSubscriptionService } from "./coding-plan-subscription/codingPlanSubscriptionService.js";
export { createClientConfigService } from "./client-config/clientConfigService.js";
export { createClientScenesService } from "./client-scenes/clientScenesService.js";
export { createSkillsService } from "./skills/skillsService.js";
export { createSkillSyncService } from "./skill-sync/skillSyncService.js";
export { createMcpSyncService } from "./mcp-sync/mcpSyncService.js";
export { createPluginSyncService } from "./plugin-sync/pluginSyncService.js";
export { createPluginsService } from "./plugins/pluginsService.js";
export { createPluginManagementService } from "./plugins/pluginManagementService.js";
export { createSubagentsService } from "./subagents/subagentsService.js";
export { createCommandsService } from "./commands/commandsService.js";
export { createHooksService } from "./hooks/hooksService.js";
export { createMemoryService } from "./memory/memoryService.js";
export { createSettingsSyncService } from "./settings-sync/settingsSyncService.js";
export { createFeedbackDiagnosticArchive } from "./feedback/feedbackLogArchive.js";
export { createFeedbackService } from "./feedback/feedbackService.js";
export type { CreateFeedbackServiceOptions } from "./feedback/feedbackService.js";
export { createLocalPromptAttachmentTransferService } from "./prompt-attachment-transfer/promptAttachmentTransferService.js";
export {
  createLocalConversationShareArtifactSource,
  createRemoteConversationShareArtifactSource,
} from "./conversation-share/conversationShareArtifactSource.js";
export { createNodeApiClient, NodeApiClient } from "./providers/api/nodeApiClient.js";
export {
  createHostApiNetworkTransport,
  type HostApiNetworkTransport,
} from "./providers/api/nodeApiNetwork.js";
export {
  buildRuntimeProcessEnvPatch,
  captureLoginShellEnvSnapshot,
  normalizeRuntimeProcessEnv,
  prepareRuntimeProcessEnvPatch,
} from "./runtime-tools/runtimeCommandEnv.js";

// 定时任务管理与 scheduler 共用同一套 node-only 存储和 cron 语义。
export {
  AutomationRepo,
  DISPATCH_RETRY_BASE_MS,
  DISPATCH_RETRY_CAP_MS,
  DISPATCH_MAX_ATTEMPTS,
  CLAIM_STALE_MS,
  computeRetryAt,
} from "./session/automationRepo.js";
export { AutomationService, InvalidCronExprError } from "./session/automationService.js";
// 闲时任务与 automation 同库不同表；类型/常量全独立。
export { OffPeakTaskRepo, OFF_PEAK_CLAIM_STALE_MS } from "./session/offPeakTaskRepo.js";
// host 域终态回填 files_changed 复用现有 task diff 汇总。
export { buildTaskChangeSummary } from "./session/taskChangeSummary.js";
export { OffPeakTaskService } from "./session/offPeakTaskService.js";
export { IOffPeakTaskService } from "./session/offPeakTask.js";
export { createOffPeakServerClient, OffPeakServerError } from "./session/offPeakServerClient.js";
export { isOffPeakMockEnabled, startOffPeakMockGateway } from "./session/offPeakMockGateway.js";
export {
  buildOffPeakRequestAuth,
  createOffPeakOriginResolver,
  resolveOffPeakCredentials,
  resolveOffPeakCodingPlanSupport,
  resolveOffPeakMockUpstream,
  OffPeakCodingPlanUnavailableError,
  OffPeakCredentialsUnavailableError,
  OffPeakModelUnavailableError,
  OffPeakPermanentDispatchError,
} from "./session/offPeakRuntimeModel.js";
export { createServiceLogger } from "./logger/serviceLogger.js";
export {
  buildOfficialMcpAuthHeaders,
  createOfficialMcpAuthHeadersResolver,
  resolveOfficialMcpCredentials,
} from "./official-mcp/officialMcpCredentials.js";
export {
  computeAutomationNextRunAt,
  computeNextRunAt,
  computeScheduleRuleNextRunAt,
  isOneShotAutomation,
  isValidCronExpr,
} from "./session/automationCron.js";

import { ServiceCollection } from "./collection.js";
import { IFileService } from "./file/file.js";
import { IMediaPreviewService } from "./media-preview/mediaPreview.js";
import { IGitService } from "./git/git.js";
import { IGitCheckpointService } from "./git/gitCheckpoint.js";
import { ISystemService } from "./system/system.js";
import { ITerminalService } from "./terminal/terminal.js";
import { ISettingService } from "./setting/setting.js";
import { IOnboardingRecordService } from "./onboarding/onboardingRecord.js";
import { ICredentialService } from "./credential/credential.js";
import { IBroadcastService } from "./broadcast/broadcast.js";
import { IZCodeTaskService } from "./session/zcodeTaskService.js";
import { IZCodeAgentService } from "./zcode-agent/zcodeAgent.js";
import type { CuaOperationStateReporter } from "./zcode-agent/cuaOperationTurnTracker.js";
import { IZCodeSessionService } from "./zcode-session/zcodeSession.js";
import {
  createUnsupportedConversationShareService,
  IConversationShareService,
  type IConversationShareService as IConversationShareServiceType,
} from "./conversation-share/conversationShare.js";
import {
  ConversationShareService,
  conversationShareConnectionScopeFactory,
} from "./conversation-share/conversationShareService.js";
import { createLocalConversationShareArtifactSource } from "./conversation-share/conversationShareArtifactSource.js";
import { ConversationShareHttpClient } from "./conversation-share/conversationShareHttpClient.js";
import { IBotsService } from "./bots/bots.js";
import { IFileWatcherService } from "./fileWatcher/fileWatcher.js";
import { IOAuthService } from "./oauth/oauth.js";
import { IUsageStatsService } from "./usage-stats/usageStats.js";
import { ICodingPlanSubscriptionService } from "./coding-plan-subscription/codingPlanSubscription.js";
import { IClientScenesService } from "./client-scenes/clientScenes.js";
import { ISkillsService } from "./skills/skills.js";
import { ISkillSyncService } from "./skill-sync/skillSync.js";
import { IMcpSyncService } from "./mcp-sync/mcpSync.js";
import { IPluginSyncService } from "./plugin-sync/pluginSync.js";
import { IPluginsService } from "./plugins/plugins.js";
import { IPluginManagementService } from "./plugins/pluginManagement.js";
import { ISubagentsService } from "./subagents/subagents.js";
import { ICommandsService } from "./commands/commands.js";
import { IHooksService } from "./hooks/hooks.js";
import { IMemoryService } from "./memory/memory.js";
import { ISettingsSyncService } from "./settings-sync/settingsSync.js";
import { IFeedbackService } from "./feedback/feedback.js";
import { IPromptAttachmentTransferService } from "./prompt-attachment-transfer/promptAttachmentTransfer.js";
import { createFileService } from "./file/fileService.js";
import { createMediaPreviewService } from "./media-preview/mediaPreview.js";
import type { WorkspaceFileSearchFilter } from "./file/workspaceFileMentionFilter.js";
import { createGitService } from "./git/gitService.js";
import { GitCommitMessageGenerator } from "./git/gitCommitMessageGenerator.js";
import { createGitCheckpointService } from "./git/gitCheckpointService.js";
import { createSystemService } from "./system/systemService.js";
import { createTerminalService } from "./terminal/terminalService.js";
import { createSettingServiceWithMigrations } from "./setting/settingService.js";
import { createOnboardingRecordService } from "./onboarding/onboardingRecordService.js";
import { createLegacyTeamOrganizationResolver } from "./model-provider/legacyTeamOrganizationResolver.js";
import { createObservableSettingService } from "./setting/observableSettingService.js";
import { createCredentialService } from "./credential/credentialService.js";
import { createBroadcastService } from "./broadcast/broadcastService.js";
import { createZCodeAgentService } from "./zcode-agent/zcodeAgentService.js";
import type { ZCodeAgentCommandResolver } from "./zcode-agent/zcodeAgentProcessManager.js";
import { buildAgentTelemetrySpawnEnv } from "./zcode-agent/agentTelemetryEnv.js";
import { resolveZCodeAgentPresentationSurface } from "./zcode-agent/zcodeAgentPresentationSurface.js";
import { createZCodeTaskServiceAdapter } from "./zcode-agent/zcodeTaskServiceAdapter.js";
import { createZCodeSessionService } from "./zcode-session/zcodeSessionService.js";
import { createZCodeTaskIndexSyncer } from "./zcode-agent/zcodeTaskIndexSyncer.js";
import { TaskIndexRepo } from "./session/taskIndexRepo.js";
import { createBotsService } from "./bots/botsService.js";
import { createBotRemoteWorkspaceService } from "./bots/botRemoteWorkspaceBridge.js";
import type { SessionMessageSendRequested } from "#src/session/sessionMailbox.js";
import { createFileWatcherService } from "./fileWatcher/fileWatcherService.js";
import { createOAuthService } from "./oauth/oauthService.js";
import { isCurrentOAuthCredentialRequest } from "#src/oauth/oauthUnauthorizedRequest.js";
import { createOAuthProviderLogoutHandler } from "./oauth/oauthProviderLogout.js";
import { OAuthCredentialRepo } from "./oauth/repo/oauthCredentialRepo.js";
import { readLegacyZCodeConfigProviders } from "./model-provider/legacyZCodeConfigProviderReader.js";
import { resolveAccountTeamPlanRuntimeApiKey } from "./model-provider/accountProviderTeamPlanRequestKey.js";
import { createAccountProviderCredentialStore } from "./model-provider/accountProviderCredentialStore.js";
import { createAccountProviderCredentialService } from "./model-provider/accountProviderCredentialService.js";
import { createAccountProviderRequestAuthService } from "./model-provider/accountProviderRequestAuthService.js";
import {
  createAccountProviderConfigSource,
  createCodingPlanFamilyAvailabilityResolver,
  resolveCurrentAccountAccess,
} from "./model-provider/accountProviderConnectionResolver.js";
import { bindAccountProviderInvalidation } from "./model-provider/accountProviderInvalidation.js";
import { AccountProviderApiClient } from "./model-provider/accountProviderApiClient.js";
import { AccountProviderApiKeyResolver } from "./model-provider/accountProviderApiKeyResolver.js";
import { createProviderConfigRuntime } from "./model-provider/providerConfigRuntime.js";
import { fetchZCodeBuiltinRemoteRelease } from "./model-provider/zcodeBuiltinRemoteConfig.js";
import {
  createProviderRuntimeFromConfigRuntime,
  type ProviderRuntime,
} from "./model-provider/providerRuntime.js";
import {
  IModelSelectionService,
  IProviderSettingsService,
} from "./model-provider/providerFacadeServices.js";
import { createProviderSettingsConnectivityTester } from "./model-provider/providerSettingsConnectivity.js";
import {
  createProviderProvisioningSource,
  listProviderProvisioningCredentialKeys,
  PROVIDER_PROVISIONING_OAUTH_CREDENTIAL_KEYS,
  resolveCredentialFilePath,
  type ProviderProvisioningSource,
} from "./model-provider/providerProvisioningSource.js";
import { createProviderProvisioningTarget } from "./model-provider/providerProvisioningTarget.js";
import { IProviderProvisioningTargetService } from "./model-provider/providerProvisioning.js";
import { buildOffPeakModelSelectionView } from "./model-provider/offPeakModelSelectionView.js";
import { resolveClientConfigPlatform } from "./runtime-tools/clientPlatform.js";
import {
  createAccountRequestAuthService,
  type IAccountRequestAuthService,
} from "./model-provider/accountRequestAuthService.js";
import { createUsageStatsService } from "./usage-stats/usageStatsService.js";
import { createCodingPlanSubscriptionService } from "./coding-plan-subscription/codingPlanSubscriptionService.js";
import { createClientConfigService } from "./client-config/clientConfigService.js";
import { IClientConfigService } from "./client-config/clientConfig.js";
import { createClientScenesService } from "./client-scenes/clientScenesService.js";
import { createSkillsService } from "./skills/skillsService.js";
import { createSkillSyncService } from "./skill-sync/skillSyncService.js";
import { createMcpSyncService } from "./mcp-sync/mcpSyncService.js";
import { createPluginSyncService } from "./plugin-sync/pluginSyncService.js";
import { createPluginsService } from "./plugins/pluginsService.js";
import { createPluginManagementService } from "./plugins/pluginManagementService.js";
import { createSubagentsService } from "./subagents/subagentsService.js";
import { createCommandsService } from "./commands/commandsService.js";
import { createHooksService } from "./hooks/hooksService.js";
import { createMemoryService } from "./memory/memoryService.js";
import { createSettingsSyncService } from "./settings-sync/settingsSyncService.js";
import {
  createFeedbackService,
  type CreateFeedbackServiceOptions,
} from "./feedback/feedbackService.js";
import { createLocalPromptAttachmentTransferService } from "./prompt-attachment-transfer/promptAttachmentTransferService.js";
import { createNodeApiClient } from "./providers/api/nodeApiClient.js";
import {
  createHostApiNetworkTransport,
  type HostApiNetworkTransport,
} from "./providers/api/nodeApiNetwork.js";
import type {
  RuntimeProcessLifecycleReporter,
  RuntimeTaskReporter,
} from "#src/process/runtimeProcessLifecycle.js";
import { initializeRuntimeProcessEnv } from "./runtime-tools/runtimeCommandEnv.js";
import {
  buildAgentEndpointOriginEnv,
  buildAgentRuntimeEnv,
} from "./runtime-tools/agentProxyEnv.js";
import { ensureAppCaCert } from "./runtime-tools/appCaCert.js";
import { buildHelperOpenArgs, isCuaLocalDevelopmentRuntime } from "@zcode/zcode-cua/broker/server";
import { createServiceLogger, type ServiceLogger } from "#src/logger/serviceLogger.js";
import { IOffPeakTaskService } from "./session/offPeakTask.js";
import { OffPeakTaskService } from "./session/offPeakTaskService.js";
import { OffPeakTaskRepo } from "./session/offPeakTaskRepo.js";
import { createOffPeakServerClient } from "./session/offPeakServerClient.js";
import {
  buildOffPeakRequestAuth,
  createOffPeakOriginResolver,
  resolveOffPeakCredentials,
  resolveOffPeakCodingPlanSupport,
  resolveOffPeakMockUpstream,
} from "./session/offPeakRuntimeModel.js";
import {
  createOfficialMcpAuthHeadersResolver,
  resolveOfficialMcpCredentials,
} from "./official-mcp/officialMcpCredentials.js";
import {
  createOfficialMcpTrustedOriginRegistry,
  OFFICIAL_MCP_DEV_TRUSTED_ORIGINS_ENV,
} from "@zcode/shared";
import {
  BROKER_SOCKET_ENV,
  BROKER_UNAVAILABLE_ENV,
  clearCuaProductHelperAgentEnvUnavailable,
  createCuaPipSessionService,
  createCuaProductMcpServerResolver,
  createProductCuaHelperHost,
  CuaHelperLifecycleManager,
  CuaProductHelperWorkspaceRegistry,
  hasCuaProductHelperAgentEnvUnavailable,
  ICuaPermissionService,
  ICuaPipSessionService,
  isCuaHelperError,
  isOfficialCuaPluginEnabledForWorkspace,
  isPotentialZCodeCuaAgentMcpServer,
  isScreenCaptureProbeSuccess,
  markCuaProductHelperAgentEnvUnavailable,
  reapOrphanedHelpers,
  shouldRunCuaScreenCaptureProbe,
  waitForCuaHelperStartup,
  type CuaHelperHost,
  type CuaHelperTransportHandle,
  type CuaHelperTransportRestartOptions,
  type CuaHelperTransportRestartResult,
  type ManagedCuaProductHelperHost,
  type CuaProductMcpServerResolver,
  type CuaProductMcpServerResolverContext,
  type CuaPermissionRestartOptions,
  type CuaPermissionRestartResult,
  type CuaPermissionState,
  type CuaPermissionStatusQueryOptions,
  type CuaPermissionStatusResult,
} from "#src/cua-permission-broker/index.js";
import {
  resolveWindowsCuaRuntime,
  WindowsCuaDevRuntimeResolutionError,
  type WindowsCuaRuntime,
} from "#src/cua-permission-broker/windowsCuaDevRuntime.js";
import { createCanonicalCuaHelperInstaller } from "./cua-permission-broker/cuaHelperInstaller.js";
import { WindowsCuaHelperHost } from "#src/cua-permission-broker/windowsCuaDevHelperHost.js";
import { DEV_HELPER_APP_NAME, HELPER_APP_NAME } from "@zcode/zcode-cua/broker/helperConstants";
import { resolveBrokerSocketPath } from "@zcode/zcode-cua/broker/socketPath";
import {
  DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY,
  resolveSafeEndpointHostname,
  ZCODE_JWT_INVALID_BROADCAST_CHANNEL,
  formatLogPrefix,
  isCredentialDecryptError,
  isStartPlanModelProviderId,
  OFF_PEAK_PROVIDER_IDS,
  BIGMODEL_PROVIDER_ID,
  type ProviderFamilyDomain,
  type ServiceAuthorityMode,
  resolveRuntimeZCodeEndpointOrigin,
  type BrowserBackendDescriptor,
  type BrowserClientMode,
  type BrowserCommand,
  isZCodeCuaMcpCommand,
  isZCodeCuaMcpPackageArg,
  isZCodeCuaInternalFeatureEnabled,
  ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY,
  type ZCodeAutomation,
  type ZCodeAutomationRun,
  getCapturedZCodeAgentTelemetryEnv,
  ZCODE_DESKTOP_CONTEXT_PROMPT_ENABLED_ENV,
  ZAI_PROVIDER_ID,
  zcodeAccountAccessSchema,
  zcodeProviderAccountAccessSchema,
  ZCODE_VERSION,
  ZCODE_ENV,
  buildRuntimeZCodeApiUrl,
} from "@zcode/shared";

// 这些 conversation-share 实现依赖 Node 文件系统；仅通过 @zcode/services/node 暴露，
// 防止 browser-safe 根入口把 node:* 依赖带进 renderer。
export {
  ConversationShareService,
  ConversationShareHttpClient,
  conversationShareConnectionScopeFactory,
};

interface ServiceWithDisposeAll {
  disposeAll: () => void;
}

interface ServiceWithDisposeAllAndWait {
  disposeAllAndWait: () => Promise<void>;
}

const CUA_PRODUCT_HELPER_AGENT_ENV_RETRY_MS = 30_000;
// Cold-start budget: the Helper's first cold launch (large Node SEA + first-time Gatekeeper/notarization
// assessment) routinely exceeds the old 5s health budget; warm it is <1s. Give the cold path
// plenty of headroom. Runs off the agent-spawn critical path (see buildCuaProductHelperAgentEnv).
const CUA_HELPER_HEALTH_TIMEOUT_MS = 30_000;
// 有界 spawn grace：给正常的签名 Helper 冷启动一个短暂但现实的就绪窗口。实机上
// Gatekeeper + SEA 启动通常需要 300–500ms，旧 250ms 会把健康首启误判为 BROKER_UNAVAILABLE。
// 1s 后仍未就绪才 fail-closed，后台 startup 继续收敛；不会等待完整的 30s health budget。
// helper 随后 ready 时由 reconcileRecoveredHelper 只清理后续 spawn admission marker，绝不触碰
// 已有 Agent。绝不照搬 feat 的 10s caller wait。
const CUA_PRODUCT_HELPER_SPAWN_READY_DEADLINE_MS = 1_000;

type DefaultCuaProductHelper = {
  host: ManagedCuaProductHelperHost;
  macPermissionHost?: CuaHelperHost;
  resolver: CuaProductMcpServerResolver;
};

type ManagedDefaultCuaProductHelper = {
  helper: DefaultCuaProductHelper;
  seedContext?: CuaProductMcpServerResolverContext;
};

const cuaProductHelperAgentEnvRetryAt = new WeakMap<Pick<CuaHelperHost, "start">, number>();
const cuaProductHelperTrackedStart = new WeakMap<Pick<CuaHelperHost, "start">, Promise<unknown>>();
/**
 * 本次 startup 期间有 agent 消费过 reservation（拿了 Helper 尚未就绪时预留的 tuple）。
 *
 * 撤销路径不可省：那些 spawn 是**成功返回**的，从未进过 catch，所以 startup 最终失败时
 * 没有任何既有机制会把它们标记为需要重新 spawn。这里补上 mark，让后续 spawn 在 Helper
 * 不可用时继续 fail-closed；Helper ready 后只清理 marker，不回收已有 Agent。
 */
const cuaProductHelperReservedSpawns = new WeakSet<Pick<CuaHelperHost, "start">>();
/** Agent 已消费 Windows transport_ready tuple；full startup 后续失败时仍保留既有 Agent。 */
const cuaProductHelperTransportSpawns = new WeakSet<Pick<CuaHelperHost, "start">>();

function trackCuaProductHelperStartup(
  host: Pick<CuaHelperHost, "start">,
  startup: Promise<unknown>,
): void {
  if (cuaProductHelperTrackedStart.get(host) === startup) return;
  cuaProductHelperTrackedStart.set(host, startup);
  void startup.then(
    () => {
      cuaProductHelperAgentEnvRetryAt.delete(host);
      cuaProductHelperReservedSpawns.delete(host);
      cuaProductHelperTransportSpawns.delete(host);
      if (cuaProductHelperTrackedStart.get(host) === startup) {
        cuaProductHelperTrackedStart.delete(host);
      }
    },
    () => {
      // The caller may already have timed out while the shared 30s startup continued. Its eventual
      // failure must still establish backoff; otherwise every new task immediately repeats install/
      // launch/health work during a persistent failure.
      cuaProductHelperAgentEnvRetryAt.set(host, Date.now() + CUA_PRODUCT_HELPER_AGENT_ENV_RETRY_MS);
      if (cuaProductHelperReservedSpawns.delete(host)) {
        // 有 Agent 拿着预留 tuple 而 Helper 最终没起来 → 仅标记后续 spawn fail-closed，
        // 不反向销毁已有 Agent。
        markCuaProductHelperAgentEnvUnavailable(host);
      }
      if (cuaProductHelperTransportSpawns.delete(host)) {
        markCuaProductHelperAgentEnvUnavailable(host);
      }
      if (cuaProductHelperTrackedStart.get(host) === startup) {
        cuaProductHelperTrackedStart.delete(host);
      }
    },
  );
}

function hasDisposeAll(instance: unknown): instance is ServiceWithDisposeAll {
  return (
    typeof instance === "object" &&
    instance !== null &&
    "disposeAll" in instance &&
    typeof (instance as { disposeAll?: unknown }).disposeAll === "function"
  );
}

function hasDisposeAllAndWait(instance: unknown): instance is ServiceWithDisposeAllAndWait {
  return (
    typeof instance === "object" &&
    instance !== null &&
    typeof (instance as { disposeAllAndWait?: unknown }).disposeAllAndWait === "function"
  );
}

interface ManagedCuaHelperHostDispose {
  stop(): Promise<void>;
}

// 默认 Computer Use Helper 是长生命周期的独立 TCC 授权进程（持 broker socket + Accessibility/Screen Recording）。
// 它不是 IPC 服务，不进 ServiceCollection 的 disposeAll 列表，但 host 释放时必须显式终止它，否则会以
// 已授权主体常驻、甚至在 services 重建时再起一个 → 多实例/孤儿/权限主体泄漏。用与 ServiceCollection 绑定
// 的 WeakMap 侧表登记，dispose 时统一终止（best-effort，不阻断其它资源回收）。
const managedCuaHelperHosts = new WeakMap<ServiceCollection, ManagedCuaHelperHostDispose>();
const providerRuntimes = new WeakMap<ServiceCollection, ProviderRuntime>();
const providerProvisioningSources = new WeakMap<ServiceCollection, ProviderProvisioningSource>();
const providerProvisioningTriggerDisposers = new WeakMap<
  ServiceCollection,
  readonly (() => void)[]
>();
// TaskIndexRepo / OffPeakTaskRepo 等各自持有 tasks-index.sqlite 的连接句柄；
// dispose 链必须统一关闭：Windows 上句柄悬着会让宿主回收后临时目录 rm 撞 EBUSY
// （stdioDesktopPresentationSurface 单测稳定复现），Linux 的 unlink-while-open 语义掩盖了泄漏。
// 与其它侧表一样按 ServiceCollection 登记并在 dispose 时统一 close。
const sharedSqliteRepos = new WeakMap<ServiceCollection, ReadonlyArray<{ close(): void }>>();
const accountRequestAuthServices = new WeakMap<ServiceCollection, IAccountRequestAuthService>();
export type OffPeakRequestAuthBuilder = (
  ticketId: string,
) => Promise<{ apiKey: string; headers: Record<string, string> }>;
const offPeakRequestAuthBuilders = new WeakMap<ServiceCollection, OffPeakRequestAuthBuilder>();

/** Local Host 进程内能力；不会随 ServiceCollection 暴露到通用 RPC Channel。 */
export function getAccountRequestAuthService(
  services: ServiceCollection,
): IAccountRequestAuthService | undefined {
  return accountRequestAuthServices.get(services);
}

/** Local Host 进程内的 Provisioning Source；不会把凭据通过通用 RPC 暴露给 Renderer。 */
export function getProviderProvisioningSource(
  services: ServiceCollection,
): ProviderProvisioningSource | undefined {
  return providerProvisioningSources.get(services);
}

/** Local Host 私有的闲时请求鉴权装配；复用正式 Registry/Account Access 解析，不进入 RPC。 */
export function getOffPeakRequestAuthBuilder(
  services: ServiceCollection,
): OffPeakRequestAuthBuilder | undefined {
  return offPeakRequestAuthBuilders.get(services);
}
const managedHostApiNetworkTransports = new WeakMap<ServiceCollection, HostApiNetworkTransport>();

export function registerManagedCuaHelperHostForDispose(
  services: ServiceCollection,
  host: ManagedCuaHelperHostDispose,
): void {
  managedCuaHelperHosts.set(services, host);
}

export function registerHostApiNetworkTransportForDispose(
  services: ServiceCollection,
  transport: HostApiNetworkTransport,
): void {
  managedHostApiNetworkTransports.set(services, transport);
}

export function shouldEnableDefaultCuaProductHelper(
  options: {
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
  } = {},
): boolean {
  // CUA 已随正式版默认开启（isZCodeCuaInternalFeatureEnabled 默认 ON，仅显式 0/false/off 关闭；2026-08 注释更正——旧注释称默认关闭已过期）。显式开启后 macOS 使用既有产品 Helper，Windows 使用安装包内 runtime；
  // 两端都保持按需启动。关闭时不创建 host、不探测资源、不产生子进程或权限提示。
  const env = options.env ?? process.env;
  if (!isZCodeCuaInternalFeatureEnabled(env)) return false;
  const platform = options.platform ?? process.platform;
  return platform === "darwin" || platform === "win32";
}

/**
 * 是否在当前 host 创建默认 CUA product Helper。Computer Use Helper 只能由**桌面本地** authority 创建：
 * - desktop-attached-remote 与 standalone-server 都绝不自动创建，避免远端 workspace 在错误的
 *   host 上启动 Helper，破坏 shared-host attachment 与权限边界；
 * - 已显式注入 resolver 时不重复创建。
 * 平台/环境层面的启用与否另由 shouldEnableDefaultCuaProductHelper 决定。
 */
export function shouldCreateDefaultCuaProductHelper(opts: {
  serviceAuthorityMode?: ServiceAuthorityMode;
  hasRemoteWorkspaceIdentity?: boolean;
  hasInjectedResolver: boolean;
  hasBuiltInCuaPlugin: boolean;
}): boolean {
  return (
    opts.hasBuiltInCuaPlugin &&
    opts.serviceAuthorityMode === "desktop-local" &&
    !opts.hasRemoteWorkspaceIdentity &&
    !opts.hasInjectedResolver
  );
}

export function shouldUseCuaPermissionService(opts: {
  platform?: NodeJS.Platform;
  cuaEnabled: boolean;
}): boolean {
  return (opts.platform ?? process.platform) === "darwin" && opts.cuaEnabled;
}

export function shouldRetainDefaultCuaProductHelper(): boolean {
  // CUA 开关只门控后续 Agent admission；已创建的 Helper 只在 Host/App dispose 时停止。
  return true;
}

export function shouldEnableCuaOperationStateReporter(opts: {
  serviceAuthorityMode?: ServiceAuthorityMode;
  hasReporter: boolean;
}): boolean {
  // CUA 操作状态属于物理桌面投影；远端 workspace/server 不得把自己的 turn 投影到本机屏幕。
  return opts.hasReporter && opts.serviceAuthorityMode === "desktop-local";
}

export async function runCuaScreenCaptureReadinessProbe(
  host: Pick<CuaHelperHost, "queryScreenCaptureProbe">,
  screenRecording: "granted" | "denied" | "unknown",
  queryOptions?: CuaPermissionStatusQueryOptions,
): Promise<boolean> {
  if (!shouldRunCuaScreenCaptureProbe(screenRecording, queryOptions)) {
    return false;
  }
  try {
    return isScreenCaptureProbeSuccess(await host.queryScreenCaptureProbe());
  } catch {
    return false;
  }
}

/**
 * Screen Recording 的展示态取值：优先短命 Helper 读到的 TCC 真值，拿不到才沿用常驻 Helper 的报告。
 *
 * 为什么不能直接信常驻 Helper：macOS 撤销 Screen Recording 对**已运行进程**不生效 ——
 * 进程在退出前保留已获得的录屏能力，`CGPreflightScreenCaptureAccess()` 也继续返回撤销前的值。
 * 于是用户在系统设置里关掉授权后，常驻 broker Helper 会一直报 granted 直到它自己重启，
 * 设置页跟着显示「已授权」；而下一次 Helper 重启 CUA 就真的不可用了。
 * 授予方向同样陈旧：刚授权完常驻 Helper 仍可能报 denied。
 *
 * fail-open 是刻意的：预检失败（open 失败 / 超时 / 结果不合法）时沿用报告值，
 * 不比不做预检更糟。硬报 denied 会把已授权用户推进一次无意义的授权引导。
 */
export async function resolveCuaScreenRecordingState(
  host: Pick<CuaHelperHost, "queryScreenRecordingPreflight">,
  reported: "granted" | "denied" | "unknown",
): Promise<"granted" | "denied" | "unknown"> {
  // unknown 表示连 CGPreflight 符号都没拿到（macOS 10.15 前）。预检跑的是同一个 native 调用，
  // 换个进程也只会得到 unknown，不值得花一次 LaunchServices 冷启。
  if (reported === "unknown") return reported;
  try {
    return (await host.queryScreenRecordingPreflight()) ?? reported;
  } catch {
    return reported;
  }
}

export function createDynamicCuaProductMcpServerResolver(options: {
  isPluginEnabled: (context?: CuaProductMcpServerResolverContext) => boolean;
  getResolver: (
    context?: CuaProductMcpServerResolverContext,
  ) => CuaProductMcpServerResolver | undefined | Promise<CuaProductMcpServerResolver | undefined>;
  isResolverCurrent?: (
    resolver: CuaProductMcpServerResolver,
    context?: CuaProductMcpServerResolverContext,
  ) => boolean;
}): CuaProductMcpServerResolver {
  return {
    async resolveMcpServers(servers, context) {
      if (!options.isPluginEnabled(context)) return servers;
      const resolver = await options.getResolver(context);
      if (!resolver) return servers;
      const resolved = await resolver.resolveMcpServers(servers, context);
      // delegate 可能跨过 Helper start/health await；dispose 在等待中置 terminal 时，不能把旧代际
      // 刚注入的 socket/token 交给晚到 Agent。移除 CUA candidate，保持其它 MCP 原样。
      return options.isResolverCurrent?.(resolver, context) === false
        ? servers?.filter((server) => !isPotentialZCodeCuaAgentMcpServer(server))
        : resolved;
    },
    async restart() {
      // 委托到底层真实 resolver（由 ICuaPermissionService.restartHelper 经此调用）。
      const resolver = await options.getResolver();
      if (!resolver) {
        throw new Error("ZCode Computer Use is not enabled (plugin off or not product mode).");
      }
      await resolver.restart();
    },
    async restartAfterPermissionGrant(onboardingSessionId) {
      // 授权完成后的 restart 必须保留 session id，才能复用底层的幂等与时序保障。
      const resolver = await options.getResolver();
      if (!resolver) {
        throw new Error("ZCode Computer Use is not enabled (plugin off or not product mode).");
      }
      await resolver.restartAfterPermissionGrant(onboardingSessionId);
    },
  };
}

let orphanHelperReaperHasRun = false;

type CreateDefaultCuaProductHelperOptions = {
  // 转发给 resolver，restart 前用来判断是否有活跃 turn（见 cuaProductMcpResolver.ts）。
  // desktop-local agent service 会提供真实的 CUA turn 状态；其他调用方没有该状态时才回退为 false。
  hasActiveTurn?: () => boolean;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  resourcesPath?: string;
  arch?: NodeJS.Architecture;
  electronVersion?: string;
  resolveWindowsRuntime?: () => Promise<WindowsCuaRuntime>;
  createMacHost?: () => CuaHelperHost;
  createWindowsHost?: (runtime: WindowsCuaRuntime) => ManagedCuaProductHelperHost;
};

/**
 * Windows 侧 Helper 宿主的懒解析包装：把「解析安装包运行时」推迟到首次 start()/checkHealth()，
 * 并把解析结果缓存（含 rejection）。
 *
 * resolveWindowsCuaRuntime 可能因 missing-native-addon、artifact-integrity-mismatch、
 * incompatible-runtime-manifest 等原因失败。若只向调用方抛错而没有诊断记录，设置页的
 * 「未加载」状态无法说明具体原因。因此在这里记录一条带 reason 的
 * error 日志，且因为 rejection 被缓存、日志挂在同一条 promise 链上，重复 start() 不会刷屏。
 * 载荷只有 reason/artifact/errorName/message：解析发生在 mint token 与命名管道之前，天然不含密钥。
 */
export function createWindowsCuaHelperHost(options: {
  resolveRuntime: () => Promise<WindowsCuaRuntime>;
  createHost: (runtime: WindowsCuaRuntime) => ManagedCuaProductHelperHost;
  logger?: ServiceLogger;
}): ManagedCuaProductHelperHost {
  let host: ManagedCuaProductHelperHost | undefined;
  let resolving: Promise<ManagedCuaProductHelperHost> | undefined;
  let stopped = false;
  let lifecycleEpoch = 0;
  let stopDrain: Promise<void> | undefined;
  const logResolutionFailure = (error: unknown): void => {
    if (!options.logger) return;
    const resolutionError =
      error instanceof WindowsCuaDevRuntimeResolutionError ? error : undefined;
    const artifact = resolutionError?.artifact;
    options.logger.error(undefined, "Windows CUA Helper runtime resolution failed", {
      reason: resolutionError?.reason ?? "unknown",
      ...(artifact ? { artifact } : {}),
      errorName: error instanceof Error ? error.name : typeof error,
      message: error instanceof Error ? error.message : String(error),
    });
  };
  const assertActive = (epoch: number): void => {
    if (stopped || epoch !== lifecycleEpoch) {
      throw new Error("Windows Computer Use Helper startup stopped");
    }
  };
  const getHost = async (epoch: number): Promise<ManagedCuaProductHelperHost> => {
    assertActive(epoch);
    if (host) return host;
    resolving ??= options
      .resolveRuntime()
      // catch 只包住 resolveRuntime 本身：下面 then 里的 assertActive 抛出是 stop() 竞态，不是解析失败，
      // 不能混进同一条诊断日志。
      .catch((error: unknown) => {
        logResolutionFailure(error);
        throw error;
      })
      .then((runtime) => {
        // stop() 会同步推进 epoch。运行时解析完成后必须再次检查，防止 dispose 返回后才构造并启动孤儿 Helper。
        assertActive(epoch);
        const nextHost = options.createHost(runtime);
        assertActive(epoch);
        host = nextHost;
        return nextHost;
      });
    const resolvedHost = await resolving;
    assertActive(epoch);
    return resolvedHost;
  };
  const withActiveHost = async <T>(
    operation: (activeHost: ManagedCuaProductHelperHost) => Promise<T>,
  ): Promise<T> => {
    const epoch = lifecycleEpoch;
    const activeHost = await getHost(epoch);
    assertActive(epoch);
    return operation(activeHost);
  };
  return {
    get running() {
      return host?.running ?? false;
    },
    get socketPath() {
      return host?.socketPath ?? null;
    },
    get pluginAuthority() {
      return host?.pluginAuthority ?? null;
    },
    async start() {
      return withActiveHost((activeHost) => activeHost.start());
    },
    async checkHealth(timeoutMs?: number) {
      return withActiveHost((activeHost) => activeHost.checkHealth(timeoutMs));
    },
    async waitForTransport(timeoutMs?: number) {
      return withActiveHost((activeHost) => {
        if (!activeHost.waitForTransport) {
          // 兼容旧注入 Host：没有两阶段接口时，完整 start handle 就是唯一可用 tuple。
          return activeHost.start().then((handle) => ({
            socketPath: handle.socketPath,
            pluginAuthority: handle.pluginAuthority,
          }));
        }
        return activeHost.waitForTransport(timeoutMs);
      });
    },
    async restart() {
      return withActiveHost((activeHost) => activeHost.restart());
    },
    async restartAfterCurrentStart() {
      return withActiveHost((activeHost) => activeHost.restartAfterCurrentStart());
    },
    async restartAfterCurrentStartPreservingTransport(
      restartOptions?: CuaHelperTransportRestartOptions,
    ): Promise<CuaHelperTransportRestartResult> {
      return withActiveHost((activeHost) => {
        if (activeHost.restartAfterCurrentStartPreservingTransport) {
          return activeHost.restartAfterCurrentStartPreservingTransport(restartOptions);
        }
        // 兼容旧注入 Host：wrapper 一旦暴露 preserving 接口，就必须代为提交 fresh-start
        // marker；否则 producer 会在新 tuple 已启动后判定 fail-closed 契约被破坏。
        restartOptions?.beforeFreshStart?.();
        return activeHost.restartAfterCurrentStart().then((handle) => ({ handle, reused: false }));
      });
    },
    async stop() {
      if (stopDrain) return stopDrain;
      stopped = true;
      lifecycleEpoch += 1;
      const pendingResolution = resolving;
      stopDrain = (async () => {
        // 等待已开始的解析落定，确保它观察到 terminal epoch；否则 dispose 之后仍可能晚到地启动 Helper。
        await pendingResolution?.catch(() => undefined);
        await host?.stop();
      })();
      return stopDrain;
    },
  };
}

export function createDefaultCuaProductHelper(
  options: CreateDefaultCuaProductHelperOptions,
): DefaultCuaProductHelper | undefined {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  if (!shouldEnableDefaultCuaProductHelper({ platform, env })) {
    return undefined;
  }
  const logger = createServiceLogger("cua-product-helper");
  // Best-effort, once per process: reap Helpers orphaned by prior sessions before minting a
  // fresh one. Complements the per-Helper launcher-pid watchdog (helperMain); the reaper never
  // throws, so it cannot block startup.
  if (platform === "darwin" && !orphanHelperReaperHasRun) {
    orphanHelperReaperHasRun = true;
    reapOrphanedHelpers({ logger, env });
  }
  let macPermissionHost: CuaHelperHost | undefined;
  let host: ManagedCuaProductHelperHost;
  if (platform === "darwin") {
    const bundledHelperAppPath = resolveBundledCuaHelperAppPath();
    if (!bundledHelperAppPath) {
      logger.error(
        undefined,
        "CUA product Helper is unavailable: packaged Resources path was not resolved",
      );
      return undefined;
    }
    macPermissionHost =
      options.createMacHost?.() ??
      createProductCuaHelperHost({
        logger,
        env: process.env,
        helperInstaller: createCanonicalCuaHelperInstaller({
          logger,
          env: process.env,
          bundledAppPath: bundledHelperAppPath,
        }),
        // 冲突解决原则：macOS 继续严格消费应用内置 Helper，不能退回下载源；
        // Windows 才走下方独立的安装包 runtime 解析链路。
        bundledHelperAppPath,
        // tolerate the Helper's cold first-launch instead of the 5s default.
        healthTimeoutMs: CUA_HELPER_HEALTH_TIMEOUT_MS,
        // producer product factory 统一固定 ghost cursor/PiP=true、background=false。
        // consumer 不再传伪动态 getter，避免两个仓库各保存一份产品策略。
      });
    host = macPermissionHost;
  } else {
    host = createWindowsCuaHelperHost({
      resolveRuntime:
        options.resolveWindowsRuntime ??
        (() =>
          resolveWindowsCuaRuntime({
            platform,
            env,
            resourcesPath: options.resourcesPath,
            arch: options.arch,
            electronVersion: options.electronVersion,
          })),
      createHost:
        options.createWindowsHost ??
        ((runtime) =>
          new WindowsCuaHelperHost({
            runtime,
            logger,
          })),
      logger,
    });
  }
  const resolver = createCuaProductMcpServerResolver(host, {
    hasActiveTurn: options.hasActiveTurn,
  });
  return {
    host,
    ...(macPermissionHost ? { macPermissionHost } : {}),
    resolver,
  };
}

export const ZCODE_CUA_BUNDLED_HELPER_APP_PATH_ENV = "ZCODE_CUA_BUNDLED_HELPER_APP_PATH";

export function resolveBundledCuaHelperAppPath(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const injectedPath = env[ZCODE_CUA_BUNDLED_HELPER_APP_PATH_ENV]?.trim();
  if (injectedPath) {
    return injectedPath;
  }
  const resourcesPath = (
    process as NodeJS.Process & { resourcesPath?: string }
  ).resourcesPath?.trim();
  return resourcesPath ? join(resourcesPath, "cua-helper", HELPER_APP_NAME) : undefined;
}

export { isOfficialCuaPluginEnabledForWorkspace };

export function hasGlobalCliZCodeCuaServer(env: NodeJS.ProcessEnv = process.env): boolean {
  const home = env.HOME?.trim() || homedir();
  const configPath = join(home, ".zcode", "cli", "config.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    return false;
  }
  if (!isRecord(parsed)) return false;
  if (isRecord(parsed.features) && parsed.features.mcp === false) return false;
  if (!isRecord(parsed.mcp) || !isRecord(parsed.mcp.servers)) return false;
  return Object.entries(parsed.mcp.servers).some(([name, config]) =>
    isGlobalCliZCodeCuaServer(name, config),
  );
}

function isGlobalCliZCodeCuaServer(name: string, config: unknown): boolean {
  if (!isRecord(config)) return false;
  if (config.enabled === false) return false;
  if (typeof config.type === "string" && config.type !== "stdio") return false;
  if (name === "computer-use") return true;
  // 与 desktop/services resolver 和 CLI bootstrap 共用 @zcode/shared 的单一事实源，避免第三处
  // 判定漂移：git/.git/本地路径形态的 zcode-cua 若这里漏判，全局 CLI env 注入不会带 broker
  // socket/token，agent 会回退成 Python/uvx 自己持有 macOS TCC（违反 product broker 边界）。
  if (typeof config.command === "string" && isZCodeCuaMcpCommand(config.command)) {
    return true;
  }
  return (
    Array.isArray(config.args) &&
    config.args.some((arg) => typeof arg === "string" && isZCodeCuaMcpPackageArg(arg))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function buildCuaProductHelperAgentEnv(
  host:
    | (Pick<CuaHelperHost, "start"> &
        Partial<
          Pick<CuaHelperHost, "running" | "checkHealth" | "reservedTransport"> & {
            waitForTransport(timeoutMs?: number): Promise<CuaHelperTransportHandle>;
          }
        >)
    | undefined,
  logger = createServiceLogger("cua-product-helper"),
): Promise<Record<string, string>> {
  if (!host) return {};
  if (hasCuaProductHelperAgentEnvUnavailable(host)) {
    // marker 可能已过时：权限授予或后台冷启动完成后，Helper 已恢复，但内置插件尚未加载，
    // 没有新的 resolver 调用来清理 marker。历史上这会让第二次打开应用仍显示 0 tools。
    // 只做一次有界短探针：健康时清 marker 并下发当前 live tuple，否则立即 fail-closed。
    // 此处和 reconcileRecoveredHelper 都只收敛后续 spawn 的 admission，不回收已有 Agent。
    if (host.running && host.checkHealth) {
      try {
        await host.checkHealth(CUA_PRODUCT_HELPER_SPAWN_READY_DEADLINE_MS);
        clearCuaProductHelperAgentEnvUnavailable(host);
      } catch {
        // helper 仍在恢复（冷启动 / 轮换在途）——不阻塞，交给下一次 demand boundary。
      }
    }
    if (hasCuaProductHelperAgentEnvUnavailable(host)) {
      return {
        [BROKER_UNAVAILABLE_ENV]:
          "broker_unavailable: recovered Helper credentials are waiting for a future spawn",
      };
    }
  }
  const retryAt = cuaProductHelperAgentEnvRetryAt.get(host);
  // 非阻塞设计（用户硬约束）：spawn 绝不卡在冷启动上。warm helper（host.running）走快速
  // checkHealth（1s 上限，健康 helper 毫秒级返回；只有病态 helper 才吃满，可接受）；cold helper
  // 已有安全预留时立即返回，否则走有界 1s deadline race，超时且无预留才 fail-closed 到
  // BROKER_UNAVAILABLE，后台共享 startup 继续收敛。resolver 会在后续 request boundary
  // 只收敛后续 spawn admission，再开放 broker tuple；
  // 绝不从后台 completion 异步打断首个 session，也绝不让 spawn 等 10s。
  //
  // fail-closed 理由：CLI 全局配置里存在 zcode-cua 时，返回空 env 会让 agent 按原始
  // 无 broker 凭据启动 MCP 子进程会绕过已获授权的 Helper broker，让 Python
  // MCP 成为实际 TCC 执行主体。broker 未就绪时必须返回 BROKER_UNAVAILABLE，绝不返回空 env。
  try {
    if (host.running && host.checkHealth) {
      // start() intentionally returns an existing handle without probing. Never spawn a new agent
      // with a dead Helper's stale tuple; the session resolver owns on-demand Helper restart,
      // while this lower-level spawn path fails closed until that recovery completes.
      await host.checkHealth(1000);
      // A successful resolver rotation may have recovered the same host while an earlier spawn
      // failure left a retry marker. Healthy live credentials always supersede stale backoff.
      cuaProductHelperAgentEnvRetryAt.delete(host);
      if (hasCuaProductHelperAgentEnvUnavailable(host)) {
        return {
          [BROKER_UNAVAILABLE_ENV]:
            "broker_unavailable: recovered Helper credentials are waiting for a future spawn",
        };
      }
    } else if (retryAt && Date.now() < retryAt) {
      return {
        [BROKER_UNAVAILABLE_ENV]: "broker_unavailable: helper startup retry is deferred",
      };
    }
    const startup = host.start();
    trackCuaProductHelperStartup(host, startup);
    if (host.waitForTransport) {
      // Windows named pipes cannot reserve/rename a final socket. The Helper sends
      // transport_ready once the pipe is bound; use that tuple while full health
      // (native/UIA initialization) continues in the shared startup promise.
      const transport = await waitForCuaHelperStartup(
        host.waitForTransport(CUA_PRODUCT_HELPER_SPAWN_READY_DEADLINE_MS),
        CUA_PRODUCT_HELPER_SPAWN_READY_DEADLINE_MS,
      );
      if (hasCuaProductHelperAgentEnvUnavailable(host)) {
        return {
          [BROKER_UNAVAILABLE_ENV]:
            "broker_unavailable: recovered Helper credentials are waiting for a future spawn",
        };
      }
      cuaProductHelperTransportSpawns.add(host);
      cuaProductHelperAgentEnvRetryAt.delete(host);
      return {
        [BROKER_SOCKET_ENV]: transport.socketPath,
        [ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY]: transport.pluginAuthority,
      };
    }
    // 原来只在 1s 超时后读取预留 tuple，Host 已安全占住 socket 时也会白等。
    // 复用原准入条件提前返回；完整 startup 的失败仍由上面的 tracker 收敛。
    const reserved = host.reservedTransport;
    if (reserved && !hasCuaProductHelperAgentEnvUnavailable(host)) {
      cuaProductHelperReservedSpawns.add(host);
      cuaProductHelperAgentEnvRetryAt.delete(host);
      // 这条 reserved 分支不再下发 BROKER_TOKEN_ENV：broker
      // token 鉴权已整体删除（连接门是代码签名身份）。凭据只剩 socket + authority。
      return {
        [BROKER_SOCKET_ENV]: reserved.socketPath,
        [ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY]: reserved.pluginAuthority,
      };
    }
    // 有界 deadline race：cold launch 没在 1s 内 ready 且无预留才 fail-closed。waitForCuaHelperStartup
    // 超时抛 caller_timeout（被下面 catch 当作"后台仍在跑"，不额外设 retryAt）。
    const handle = await waitForCuaHelperStartup(
      startup,
      CUA_PRODUCT_HELPER_SPAWN_READY_DEADLINE_MS,
    );
    // Another concurrent spawn may have timed out while this caller was waiting on the shared
    // startup. Never expose the recovered tuple while the resolver still has a pending admission marker.
    if (hasCuaProductHelperAgentEnvUnavailable(host)) {
      return {
        [BROKER_UNAVAILABLE_ENV]:
          "broker_unavailable: recovered Helper credentials are waiting for a future spawn",
      };
    }
    cuaProductHelperAgentEnvRetryAt.delete(host);
    return {
      [BROKER_SOCKET_ENV]: handle.socketPath,
      [ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY]: handle.pluginAuthority,
    };
  } catch (error) {
    // caller_timeout 仅表示共享的 30s startup 仍在后台运行；trackCuaProductHelperStartup 会在其
    // 真正失败时建立 backoff。这里提前退避会让已经 ready 的 Helper 仍被后续 Agent 错误禁用。
    const isCallerTimeout = isCuaHelperError(error) && error.code === "caller_timeout";
    if (isCallerTimeout) {
      // 冷启动 rendezvous：Helper 还在起，但 host 已经占住 final socket 并预留了 tuple。
      // 此时下发的凭据是**可用**的——final 上是 host 占位，未验签的 Helper 绑在 .pending
      // 上够不到它；client 连上占位会被立刻 destroy 并按 broker_unavailable 退避重试，
      // Helper 验证通过后 host 原子 rename 让渡，重试自然落到真 Helper 上。
      //
      // 这条分支存在的意义：Helper 未 ready 时只拒绝本次 Agent 的 CUA MCP admission；
      // Helper ready 后仍只影响后续 Agent spawn，不能通过 lifecycle 操作连带冲掉已有会话。
      const reserved = host.reservedTransport;
      if (reserved && !hasCuaProductHelperAgentEnvUnavailable(host)) {
        // 上面的 unavailable marker 检查优先：未完成 admission 收敛时不放出 tuple。
        cuaProductHelperReservedSpawns.add(host);
        cuaProductHelperAgentEnvRetryAt.delete(host);
        return {
          [BROKER_SOCKET_ENV]: reserved.socketPath,
          [ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY]: reserved.pluginAuthority,
        };
      }
    }
    markCuaProductHelperAgentEnvUnavailable(host);
    if (!isCallerTimeout) {
      cuaProductHelperAgentEnvRetryAt.set(host, Date.now() + CUA_PRODUCT_HELPER_AGENT_ENV_RETRY_MS);
    }
    logger.warn(
      undefined,
      `Computer Use Helper broker_unavailable; disabling workspace zcode-cua MCP server for this agent spawn (${cuaHelperStartErrorDetail(error)})`,
    );
    return {
      [BROKER_UNAVAILABLE_ENV]: isCallerTimeout
        ? // 冷启动仍在后台跑——"warming up"，reconcileRecoveredHelper 会在 helper ready 后
          // 只清理后续 spawn marker。
          "broker_unavailable: helper broker warming up"
        : `broker_unavailable: ${cuaHelperStartErrorDetail(error)}`,
    };
  }
}

function cuaHelperStartErrorDetail(error: unknown): string {
  return isCuaHelperError(error)
    ? `${error.code}: ${error.message}`
    : error instanceof Error
      ? error.message
      : String(error);
}

/**
 * 创建包含所有本地服务的 ServiceCollection
 *
 * @param options.parentPort - Electron host process 的 parentPort，
 *        用于 BroadcastService 跨窗口中转。传 null 则广播为空操作。
 */
export function createLocalServices(options: {
  parentPort?: Parameters<typeof createBroadcastService>[0];
  /** Host 装配层注入的设置权威；与网络 transport 必须来自同一 Window Host 生命周期。 */
  settingService?: ISettingService;
  /** 与注入的本地 Setting 共用写队列；外部远端 Setting 不传，由其权威 Host 完成迁移。 */
  prepareLegacyAccountConnections?: ReturnType<
    typeof createSettingServiceWithMigrations
  >["prepareLegacyAccountConnections"];
  /** 注入后由 ServiceCollection 接管释放，并供 Host 其它 app-managed 下载复用。 */
  hostApiNetworkTransport?: HostApiNetworkTransport;
  /** Desktop Host 请求 Main 登记 Agent 已授权的精确本地视频路径。 */
  authorizeLocalMediaPreviewPath?: (path: string) => Promise<string>;
  feedback?: Partial<
    Omit<CreateFeedbackServiceOptions, "apiClient" | "credentialService" | "oauthService">
  >;
  processLifecycleReporter?: RuntimeProcessLifecycleReporter;
  taskRuntimeReporter?: RuntimeTaskReporter;
  /** workspace 文件搜索默认使用内置过滤器；后续规则来源只需在 Host 装配时注入最终实现。 */
  workspaceFileSearchFilter?: WorkspaceFileSearchFilter;
  forwardSessionMessageSendRequested?: (
    request: SessionMessageSendRequested,
  ) => Promise<void> | void;
  /** desktop local host 在 manual run 落库后直接派发，不经过 scheduler 正常路径。 */
  onAutomationManualRunRequested?: (params: {
    automation: ZCodeAutomation;
    run: ZCodeAutomationRun;
  }) => Promise<void>;
  /** 闲时任务翻 schedulable 后请求宿主立即唤醒 scheduler（desktop host 注入 parentPort 转发）。 */
  onOffPeakSchedulerWakeRequested?: () => void;
  // 注入点：默认 resolver 已能覆盖 dev/桌面/SSH 远端三类形态；
  // 测试或特殊宿主想强制走自定义 binary/参数时从这里注入。
  zcodeAgentCommandResolver?: ZCodeAgentCommandResolver;
  /** Desktop Main 提前异步采集的本机 runtime 环境；Local Host 注入后不再同步启动 login shell。 */
  runtimeProcessEnvPatch?: Record<string, string>;
  /** 本地桌面上次 workspace 缺失时，仅用于 Agent 子进程 spawn.cwd 兜底。 */
  zcodeAgentSpawnFallbackCwd?: string;
  /** desktop-attached remote server 从 Desktop Host 收到的一次性 Agent 网络配置。 */
  remoteAgentNetwork?: {
    httpProxy?: string;
    noProxy?: string;
  };
  /** 所属 Environment 的 ZCode Built-in Provider Config 物理路径。 */
  zcodeBuiltinProviderConfigFilePath: string;
  /** HTTP Server 只有在调用方明确配置认证时才暴露跨 Environment Provisioning target。 */
  providerProvisioningTargetEnabled?: boolean;
  /** Desktop Host 私有通知；只在 Source 成功持久化后请求 Main 调度远端镜像。 */
  onProviderProvisioningSourceChanged?: (
    trigger: Exclude<ProviderProvisioningTrigger, "environment-online">,
  ) => void;
  serviceAuthorityMode?: ServiceAuthorityMode;
  cuaProductMcpServerResolver?: CuaProductMcpServerResolver;
  agentRuntimeContext?: {
    getDeviceMid?: () => string | undefined;
    runtimeSurface?: "desktop_local_host" | "remote_workspace_host";
  };
  /** browser-use 执行桥（host→main WebContentsView+CDP）；desktop host 注入，缺省则 browser 不可用。 */
  browserControlExecutor?: {
    list(input: {
      requestId: string;
      sessionId: string;
      turnId?: string;
      workspaceKey: string;
      workspacePath: string;
      workspaceIdentity?: string;
      remoteSessionId?: string;
      clientMode: BrowserClientMode;
      sessionContext: "live" | "cached";
    }): Promise<BrowserBackendDescriptor[]>;
    execute(input: {
      requestId: string;
      browserId?: string;
      browserGeneration?: number;
      sessionId: string;
      turnId?: string;
      workspaceKey: string;
      workspacePath: string;
      workspaceIdentity?: string;
      remoteSessionId?: string;
      clientMode: BrowserClientMode;
      sessionContext: "live" | "cached";
      command: BrowserCommand;
    }): Promise<{ ok: boolean; [k: string]: unknown }>;
  };
  /** Windows desktop-local Host 的 CUA turn 状态投影；其它 authority 会在装配层拒绝。 */
  cuaOperationStateReporter?: CuaOperationStateReporter;
}): ServiceCollection {
  const isDesktopAttachedRemote = options?.serviceAuthorityMode === "desktop-attached-remote";
  // host / remote server 以前直接沿用当前进程环境启动后续服务。
  // GUI 启动的 desktop、SSH/WSL/Docker 拉起的 remote server 往往拿不到用户 login shell 里的 PATH，
  // 导致 bun 这类只在 shell profile 里追加的命令在 ZCode Agent/终端里不可见。
  // 这里在所有本地服务启动前统一修正运行时环境，并顺带把内置 rg 注入 PATH，
  // 让 ZCode Agent、终端、认证 runtime 共用同一套命令解析结果。
  initializeRuntimeProcessEnv(options?.runtimeProcessEnvPatch);

  const desktopContextPromptEnabledRaw =
    process.env[ZCODE_DESKTOP_CONTEXT_PROMPT_ENABLED_ENV]?.trim();
  const desktopContextPromptEnabled =
    desktopContextPromptEnabledRaw === "1"
      ? true
      : desktopContextPromptEnabledRaw === "0"
        ? false
        : undefined;

  // app 自签 CA：首次启动生成一份根 CA（幂等），供 agent 子进程经 NODE_EXTRA_CA_CERTS 信任、
  // 出口代理用其私钥重签。生成失败不应阻断启动（例如只读文件系统），仅记录日志后继续。
  try {
    ensureAppCaCert();
  } catch (error) {
    console.error(formatLogPrefix("appCaCert", process.pid), "ensure app CA cert failed:", error);
  }

  const localSettings = options?.settingService ? null : createSettingServiceWithMigrations();
  const settingService = createObservableSettingService(
    options?.settingService ?? localSettings!.service,
  );
  const resolveCurrentZCodeEndpointOrigin = async () =>
    resolveRuntimeZCodeEndpointOrigin(process.env, {
      overrideOrigin: (await settingService.get()).zcodeEndpointOrigin,
    });
  const provisioningOAuthKeys = new Set<string>(PROVIDER_PROVISIONING_OAUTH_CREDENTIAL_KEYS);
  const credentialService = createCredentialService({
    onDidMutate: ({ key }) => {
      if (provisioningOAuthKeys.has(key) || isProviderProvisioningAccountCredentialKey(key)) {
        options.onProviderProvisioningSourceChanged?.("credential");
      }
    },
  });
  const accountProviderCredentialStore = createAccountProviderCredentialStore({
    credentialService,
  });
  const broadcastService = createBroadcastService(options?.parentPort ?? null);
  const gitCheckpointService = createGitCheckpointService();
  const hostApiNetworkTransport =
    options?.hostApiNetworkTransport ??
    createHostApiNetworkTransport(async () => {
      const settings = await settingService.get();
      return {
        httpProxy: settings.httpProxy,
        noProxy: settings.httpProxyNoProxy,
        caCertPath: settings.httpProxyCaCertPath,
      };
    });
  const zcodeJwtLogoutHandlerRef: {
    current: ((input: string | URL, headers: Headers) => void) | null;
  } = { current: null };
  const apiClient = createNodeApiClient({
    fetchImpl: hostApiNetworkTransport.fetch,
    onZcodeJwtInvalid: (input, headers) => zcodeJwtLogoutHandlerRef.current?.(input, headers),
    isZcodeJwtRequest: (input, headers) =>
      isCurrentOAuthCredentialRequest({ input, headers, credentialService }),
    resolveZCodeEndpointOrigin: resolveCurrentZCodeEndpointOrigin,
  });
  const systemService = createSystemService();
  // onboarding 资格与任务列表共用同一份全局 tasks-index；repo 懒加载数据库，提前构造不会
  // 增加启动 I/O，后续 session syncer 也继续复用这一实例。
  const taskIndexRepo = new TaskIndexRepo();
  // onboarding 完成记录：userId 由登录态补全（apikey/未登录为 null）。
  const onboardingRecordService = createOnboardingRecordService({
    loadUserId: async () => (await oauthCredentialRepo.loadActiveUserProfile())?.id ?? null,
    hasExistingLocalTask: async () => (await taskIndexRepo.listTaskMetas({})).length > 0,
  });
  let handleOAuthProviderLogout: ReturnType<typeof createOAuthProviderLogoutHandler> | null = null;
  const oauthCredentialRepo = new OAuthCredentialRepo(credentialService, {
    onCorruptOAuthSessionCleared: async (providers) => {
      // telemetry 之外的后台路径可能先读到损坏 OAuth 凭据。
      // 这类恢复也必须等价于 logout，复用同一 handler 清理派生模型 provider key。
      await Promise.all(
        providers.map((provider) => handleOAuthProviderLogout?.(provider) ?? Promise.resolve()),
      );
    },
  });
  const accountProviderApiKeyRemoteClient = new AccountProviderApiClient(apiClient);
  const accountProviderApiKeyResolver = new AccountProviderApiKeyResolver(
    accountProviderApiKeyRemoteClient.fetchRemoteData.bind(accountProviderApiKeyRemoteClient),
  );
  const accountProviderCredentialService = createAccountProviderCredentialService({
    credentialStore: accountProviderCredentialStore,
    async loadOAuthAccessToken(family) {
      const oauthProviderId = family === "zai" ? ZAI_PROVIDER_ID : BIGMODEL_PROVIDER_ID;
      return (await oauthCredentialRepo.loadTokenSet(oauthProviderId))?.accessToken ?? null;
    },
    resolveProviderApiKey: (family, accessToken) =>
      accountProviderApiKeyResolver.resolveProviderApiKey(
        family === "zai" ? ZAI_PROVIDER_ID : BIGMODEL_PROVIDER_ID,
        accessToken,
      ),
  });
  const resolveLegacyTeamOrganization = createLegacyTeamOrganizationResolver({
    apiClient,
    loadOAuthTokenSet: (family) =>
      oauthCredentialRepo.loadTokenSet(family === "zai" ? ZAI_PROVIDER_ID : BIGMODEL_PROVIDER_ID),
  });
  const readAccountProviderSettings = async () => {
    // 迁移只在账号事实入口协调。ApiClient 的代理/端点仍读普通 Setting，不递归等待迁移。
    // 外部注入的 Setting（远端 attachment）由其所属 Host 管理，不读取本机旧文件。
    const prepare =
      options?.prepareLegacyAccountConnections ?? localSettings?.prepareLegacyAccountConnections;
    const unresolvedFamilies = (await prepare?.(resolveLegacyTeamOrganization)) ?? [];
    const settings = await settingService.get();
    return {
      providerFamilyDomain: settings.providerFamilyDomain ?? null,
      selections: settings.providerFamilyConnectionSelections ?? {},
      unresolvedFamilies,
    };
  };
  const loadAccountIdentity = async (family: ProviderFamilyDomain) => {
    const oauthProviderId = family === "zai" ? ZAI_PROVIDER_ID : BIGMODEL_PROVIDER_ID;
    return (await oauthCredentialRepo.loadUserProfile(oauthProviderId))?.id ?? null;
  };
  const accountRequestAuthService = createAccountRequestAuthService(
    createAccountProviderRequestAuthService({
      resolveCurrentAccountAccess: (access) =>
        resolveCurrentAccountAccess({
          access,
          readSettings: readAccountProviderSettings,
          loadAccountIdentity,
        }),
      loadOAuthTokenSet: (providerId) => oauthCredentialRepo.loadTokenSet(providerId),
      async loadIndividualPlanApiKey(providerId, family) {
        const oauthProviderId = family === "zai" ? ZAI_PROVIDER_ID : BIGMODEL_PROVIDER_ID;
        const accountIdentity = (await oauthCredentialRepo.loadUserProfile(oauthProviderId))?.id;
        if (!accountIdentity) return null;
        return accountProviderCredentialService.loadCodingPlanApiKey({
          providerId,
          family,
          accountIdentity,
        });
      },
      resolveTeamPlanApiKey: (access) =>
        resolveAccountTeamPlanRuntimeApiKey({ apiClient, credentialService, access }),
    }),
  );
  const providerConfigLog = createServiceLogger("provider-config");
  const clientConfigPlatform = resolveClientConfigPlatform();
  const providerConfigRuntime = createProviderConfigRuntime({
    zcodeBuiltinFilePath: options.zcodeBuiltinProviderConfigFilePath,
    zcodeBuiltinEnvironment: {
      environmentConfigRoot: resolveAppConfigDir(),
      platform: clientConfigPlatform,
      appVersion: ZCODE_VERSION,
      resolveEndpointOrigin: resolveCurrentZCodeEndpointOrigin,
      onRefreshResult: (event) => {
        if (event.result === "updated")
          providerConfigLog.info(undefined, "ZCode Built-in CDN 配置已更新", event);
        else providerConfigLog.debug(undefined, "ZCode Built-in 刷新检查", event);
      },
      fetchRelease: (endpointOrigin, signal) =>
        fetchZCodeBuiltinRemoteRelease({
          apiClient,
          endpointOrigin,
          signal,
          appVersion: ZCODE_VERSION,
          platform: clientConfigPlatform,
        }),
    },
    onZCodeBuiltinRefreshError: (error) => {
      providerConfigLog.warn(undefined, "ZCode Built-in Config 远端刷新失败", { error });
    },
    onPersonalConfigRecovery: (event) => {
      providerConfigLog.warn(
        undefined,
        "Personal Provider Config 加载失败，已保留磁盘状态并以内存空配置降级",
        {
          error: event.error,
        },
      );
    },
    onPersonalConfigPollingError: (error) => {
      // 轮询错误只在进入失败状态时回调一次；下一轮仍会自行重试，避免持续故障刷盘。
      providerConfigLog.warn(undefined, "Personal Provider Config 轮询暂时失败，将继续重试", {
        error,
      });
    },
    // 已发布 config.json 保存的是 ZCode 用户配置；清理第三方 ACP 不能移除这条升级路径。
    // Repository 仅在新 Personal 配置不存在时导入，并保留旧文件以便回滚。
    readLegacyProviders: () => readLegacyZCodeConfigProviders(),
  });
  const accountProviderConfigSource = createAccountProviderConfigSource({
    configSource: providerConfigRuntime.configService,
    readSettings: readAccountProviderSettings,
    async loadCodingPlanApiKey(providerId, family, accountIdentity, forceRefresh) {
      if (isStartPlanModelProviderId(providerId)) return null;
      return accountProviderCredentialService.loadCodingPlanApiKey({
        providerId,
        family,
        accountIdentity,
        forceRefresh,
      });
    },
    loadAccountIdentity,
    resolveFamilyAvailability: createCodingPlanFamilyAvailabilityResolver({
      apiClient,
      credentialService,
    }),
  });
  const accountProviderRuntimeLog = createServiceLogger("account-provider-runtime");
  const modelSelectionConfiguredDefaultSource = new NodeModelSelectionConfigRepository({
    personalRepository: providerConfigRuntime.personalRepository,
  });
  const providerProvisioningSource = createProviderProvisioningSource({
    personalRepository: providerConfigRuntime.personalRepository,
    settingService,
    credentialFilePath: resolveCredentialFilePath(resolveAppConfigDir()),
    personalConfigFilePath: join(resolveAppConfigDir(), PERSONAL_PROVIDER_CONFIG_FILE_NAME),
  });
  const providerProvisioningDisposers = [
    providerConfigRuntime.configService.onDidChange((reason) => {
      // 每个 Window Host 都会轮询同一文件；只把本进程成功提交的 updated
      // 作为同步触发，避免其它 Host 的 poll-changed 把一次保存重复计入多个代际。
      if (reason === "personal:updated") {
        options.onProviderProvisioningSourceChanged?.("personal-config");
      }
    }),
    settingService.onDidUpdate((event) => {
      if (
        event.keys.includes("providerFamilyDomain") ||
        event.keys.includes("providerFamilyConnectionSelections")
      ) {
        options.onProviderProvisioningSourceChanged?.("account-settings");
      }
    }),
  ];
  const disposeAccountProviderInvalidation = bindAccountProviderInvalidation({
    onDidUpdateSetting: (listener) => settingService.onDidUpdate(listener),
    refresh: (reason) => accountProviderConfigSource.refresh(reason),
  });
  const accountProviderRefreshErrorDispose = accountProviderConfigSource.onDidRefreshError(
    (event) => {
      accountProviderRuntimeLog.warn(undefined, "account provider source refresh failed", {
        error: event.error,
        reasons: event.reasons,
      });
    },
  );
  let providerConnectivityAgentService:
    | Pick<IZCodeAgentService, "testModelConnectivity">
    | undefined;
  const providerRuntime = createProviderRuntimeFromConfigRuntime({
    configRuntime: providerConfigRuntime,
    accountSource: accountProviderConfigSource,
    modelSelectionConfiguredDefaultSource,
    disposeModelSelectionConfiguredDefaultSource: () =>
      modelSelectionConfiguredDefaultSource.dispose(),
    testConnectivity: createProviderSettingsConnectivityTester({
      testModelConnectivity: async (input) => {
        if (!providerConnectivityAgentService) {
          throw new Error("Agent Service 尚未完成模型连通性测试装配");
        }
        return providerConnectivityAgentService.testModelConnectivity(input);
      },
    }),
    disposeAccountSource: () => {
      disposeAccountProviderInvalidation();
      accountProviderRefreshErrorDispose();
      accountProviderConfigSource.dispose();
    },
  });
  handleOAuthProviderLogout = createOAuthProviderLogoutHandler({
    accountProviderCredentialStore,
    refreshAccountProviders: (reason: string) => accountProviderConfigSource.refresh(reason),
  });
  // 官方 Server MCP 的凭证解析源。MCP 调用的身份头与 MCP 额度查询（/api/v1/mcp/usage）
  // 必须共用这一份实现，否则两处对"当前选中的 Coding Plan 连接"的判定会分叉。
  // 额度侧注入的是凭证解析而非 resolveHeaders：归属校验需要 providerFamily，
  // 而身份头里没有 family；身份头仍由同一个 buildOfficialMcpAuthHeaders 构造。
  const officialMcpCredentialSource = {
    resolve: () =>
      resolveOfficialMcpCredentials({
        accountRequestAuthService,
        credentialService,
        modelSelectionService: providerRuntime.modelSelection,
      }),
  };
  // mcpSync/hooks 里引用 zcodeAgentService 的闭包是惰性调用，声明顺序不影响初始化。
  const skillsService = createSkillsService({ isDesktopRuntime: true });
  const mcpSyncService = createMcpSyncService({
    // mcp/list 的 host 消费点收拢到 mcpSync 服务；真实状态检查仍在 agent 进程。
    listMcpServerStatuses: (params) => zcodeAgentService.listMcpServerStatuses(params),
  });
  const pluginSyncService = createPluginSyncService();
  const subagentsService = createSubagentsService({
    isDesktopRuntime: true,
  });
  const commandsService = createCommandsService({ isDesktopRuntime: true });
  const hooksService = createHooksService({
    grantWorkspaceHookTrust: (params) => zcodeAgentService.grantWorkspaceHookTrust(params),
  });
  const memoryService = createMemoryService();
  // 只要当前进程已经装配 Provider Runtime，就由该 Environment 自己的 Selection View
  // 决定执行就绪状态。Desktop-attached remote 也读取远端自己的 Config/Account Facts。
  const modelSelectionReadinessSource = providerRuntime.modelSelection;
  const agentAccountProviderConfigSource = accountProviderConfigSource;
  // ===== Computer Use Helper lifecycle 层（port 自 feat）=====
  // 根因修复：app 启动时预 spawn 的 agent 早于 broker ready → buildCuaProductHelperAgentEnv 在
  // 1s grace 内拿不到 ready helper → 返回 BROKER_UNAVAILABLE → 那些 agent 的 computer-use MCP
  // server fail-closed。之后开对话复用这些 Agent 时，Helper lifecycle 不得触发 Agent 重建。
  // 约束：① 有界 spawn grace（1s 后 fail-closed，不等待完整 health budget）；② lifecycle coordinator 懒获取 +
  // 代际 fence（dispose 仅来自显式 workspace 生命周期）；③ 不创建定时健康探测，checkHealth 只在
  // CUA spawn/resolve 等按需边界执行；④ Helper restart 尽可能复用 host transport，既有 Agent
  // 的 session、进程与 MCP stream 保持不变。
  const cuaProductHelperWorkspaceRegistry = new CuaProductHelperWorkspaceRegistry();
  // createDefaultCuaProductHelper() 在 zcodeAgentService 存在之前就要组装 resolver，
  // 但"是否有活跃 turn"这个信号只有 zcodeAgentService 建好之后才能查询。用前向引用占位——resolver 真正
  // 调用 hasActiveTurn() 发生在后续某次 resolveMcpServers（异步），那时 hasActiveTurnRef 早已被赋值。
  // 先用前向引用连接 agent service 的 CUA turn tracker，避免在活跃 CUA 请求中途重启 Helper；
  // service 创建完成后再赋值。Helper recovery 始终不能回收 Agent。
  let hasActiveTurnRef: (() => boolean) | undefined;
  const isCuaEnabledForContext = (context?: CuaProductMcpServerResolverContext): boolean =>
    // 保留 main 原有 gate 行为（避免回归）：dev/internal 特性开启时（ZCODE_CUA_DEV_MODE=1 或
    // ZCODE_CUA_PRODUCT_HELPER=1）即视为启用，不依赖 config.json 显式 enable——main 的 bootstrap
    // 用 isZCodeCuaInternalFeatureEnabled 门控 bundled plugin，与 feat 的 workspace enablement 不同。
    // 生产路径（dev mode off）回落到官方插件 workspace enablement 判定（与 feat 一致）。
    isZCodeCuaInternalFeatureEnabled(process.env) ||
    isOfficialCuaPluginEnabledForWorkspace({
      env: process.env,
      workingDirectory: context?.workspacePath,
    });
  const defaultCuaProductHelperLifecycle =
    new CuaHelperLifecycleManager<ManagedDefaultCuaProductHelper>(async (managed) => {
      await managed.helper.host.stop();
    });
  const createManagedDefaultCuaProductHelper = (
    context?: CuaProductMcpServerResolverContext,
  ): ManagedDefaultCuaProductHelper | undefined => {
    const helper = createDefaultCuaProductHelper({
      // 转发活跃-turn 查询（前向引用，zcodeAgentService 建好后赋值）。
      hasActiveTurn: () => hasActiveTurnRef?.() ?? false,
    });
    if (!helper) return undefined;

    // 历史默认装配启动 10 秒周期 watchdog；空闲期一次 broker_info 超时就会在后台
    // 调用 resolver.restart()。Helper 不是 Agent runtime owner，且无需在没有 CUA 需求时自愈；
    // 健康检查保留在 spawn env / resolver request boundary，避免后台 timer 干扰其他模块。
    return {
      helper,
      ...(context ? { seedContext: context } : {}),
    };
  };
  const getOrCreateDefaultCuaProductHelper = async (
    context?: CuaProductMcpServerResolverContext,
  ): Promise<DefaultCuaProductHelper | undefined> => {
    const managed = await defaultCuaProductHelperLifecycle.acquire({
      isAdmitted: () =>
        shouldCreateDefaultCuaProductHelper({
          serviceAuthorityMode: options?.serviceAuthorityMode,
          hasRemoteWorkspaceIdentity: Boolean(context?.workspaceIdentity?.trim()),
          hasInjectedResolver: Boolean(options?.cuaProductMcpServerResolver),
          hasBuiltInCuaPlugin: isCuaEnabledForContext(context),
        }),
      shouldRetainCurrent: shouldRetainDefaultCuaProductHelper,
      create: () => createManagedDefaultCuaProductHelper(context),
    });
    return managed?.helper;
  };
  const isDefaultCuaProductHelperCurrent = (helper: DefaultCuaProductHelper): boolean =>
    defaultCuaProductHelperLifecycle.peek()?.helper === helper;
  // Helper 懒启动：宿主启动时仅探测稳定 socket 上是否有一个
  // 自启动（SDK 首调拉起）的 Helper。只 ping，绝不拉起；300ms 预算。probe 结果仅用于
  // 状态展示 / PiP 凭据发现；权限详情与 onboarding 仍走显式 host 流。
  const probeStableCuaHelperSocket = async (): Promise<string | null> => {
    const socketPath = resolveBrokerSocketPath();
    try {
      const { createConnection } = await import("node:net");
      return await new Promise<string | null>((resolve) => {
        const socket = createConnection(socketPath);
        const finish = (value: string | null): void => {
          socket.destroy();
          resolve(value);
        };
        const timer = setTimeout(() => finish(null), 300);
        socket.on("connect", () => {
          clearTimeout(timer);
          socket.write(`{"id":0,"method":"ping","params":{}}\n`);
          let buffer = "";
          socket.on("data", (chunk: Buffer) => {
            buffer += chunk.toString("utf8");
            if (buffer.includes("\n")) {
              try {
                const nl = buffer.indexOf("\n");
                const reply = JSON.parse(buffer.slice(0, nl)) as { ok?: boolean };
                finish(reply.ok === true ? socketPath : null);
              } catch {
                finish(null);
              }
            }
          });
        });
        socket.on("error", () => {
          clearTimeout(timer);
          finish(null);
        });
      });
    } catch {
      return null;
    }
  };

  // 按需启动：拉起 standalone Helper（稳定 socket）。dev 场景（本 Helper 构建内嵌 dev
  // policy）成对带 unsigned-launcher/external-escape argv，让 ad-hoc 签名的本进程也能过
  // 签名门查询；产品 Helper 不嵌 dev policy，这对 argv 无效（产品签名天然过 Team 门）。
  // 拉起后轮询 ping（5s/100ms），就绪返回 socket 路径，否则 null。
  //
  // dev 判定直接用上游的 isCuaLocalDevelopmentRuntime（@zcode/zcode-cua/broker/server，
  // 即本文件已经用来 import buildHelperOpenArgs 的那个 subpath，可正常导入）。
  //
  // 行为等价性（别误读成安全加固）：上游是 `COMPILED_LOCAL_DEVELOPMENT_RUNTIME &&
  // ZCODE_RUNTIME_ENV!=="production"`，而那个编译期常量只有 scripts/build-cua-helper-app.mjs
  // 会用 define 折叠（Helper bundle）；desktop host bundle 没有该 define，于是回退成
  // `process.env.NODE_ENV !== "production"` —— 正是复制品写的那一项。所以在**当前**打包形态下
  // 两者逐字等价，关门靠的是 ZCODE_RUNTIME_ENV=production（打包态显式注入且不传 NODE_ENV）。
  //
  // 换成上游的收益是消除漂移面：折叠点、因子个数与 fail-closed 方向都由上游一处决定，
  // 哪天 host bundle 也补上 __ZCODE_LOCAL_DEVELOPMENT_RUNTIME__ define（Helper 侧已经有），
  // 编译期门自动生效，不需要再回来改这里。

  const launchStandaloneCuaHelperForStatus = async (): Promise<string | null> => {
    if (process.platform !== "darwin") return null;
    const { existsSync } = await import("node:fs");
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const socketPath = resolveBrokerSocketPath();
    // standaloneHelperCandidatePaths 未在上游 exports 白名单——此处按同一规则枚举安装候选
    //（dev-desktop → dev/ 前缀；app 名一律取 helperConstants，不写字面量）。
    const home = process.env.ZCODE_HOME?.trim() || join(homedir(), ".zcode");
    const baseRoot = join(home, "computer-use");
    // 安装布局见上游 helperLauncher.resolveCuaHelperInstallRoot：dev 是独立子根 `dev/` 且 app
    // 名换成 DEV_HELPER_APP_NAME；preview 是独立子根 `preview/` 但**沿用**稳定 app 名
    //（分根的理由是 build id 不同、共享根会互相覆盖安装，不是改名）。
    // 只枚举 HELPER_APP_NAME 导致 dev 下永远找不到候选，设置页拉起静默失败、
    // 权限显示未知。dev 的两种名字都留着：一键 dev bundle 也可能装成稳定名。
    const candidates = [
      join(baseRoot, "dev", DEV_HELPER_APP_NAME),
      join(baseRoot, "dev", HELPER_APP_NAME),
      join(baseRoot, HELPER_APP_NAME),
      join(baseRoot, "preview", HELPER_APP_NAME),
    ];
    const appPath = candidates.find((candidate) => existsSync(candidate));
    if (!appPath) return null;
    // Helper 启动参数统一由 buildHelperOpenArgs 构造，避免多处手写导致漏传或漂移。
    // 设置页只读权限探测不承载 PiP，不传 --launcher-pid 和 --pip-mode；
    // exit-log 使用 .settings.exit.log。新增参数应定义在 HelperLaunchSpec 中供调用方共用。
    const args = buildHelperOpenArgs({
      appPath,
      socketPath,
      exitLogPath: `${socketPath}.settings.exit.log`,
      ...(isCuaLocalDevelopmentRuntime(process.env)
        ? { allowUnsignedLauncherLocalDev: true, allowExternalBrokerClientLocalDev: true }
        : {}),
    });
    try {
      await promisify(execFile)("/usr/bin/open", args, { timeout: 5_000 });
    } catch {
      // LaunchServices 已接单也可能超时；继续等 ping。
    }
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const ready = await probeStableCuaHelperSocket();
      if (ready) return ready;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return null;
  };

  // enabled 与 onCuaPipSessionLifecycle 是否挂上，都由 serviceAuthorityMode 单点决定；
  // 提出来命名，避免下面的启动期诊断与真实取值漂移。
  const cuaPipSessionEnabled =
    process.platform === "darwin" && options?.serviceAuthorityMode === "desktop-local";
  const cuaPipSessionService = createCuaPipSessionService({
    enabled: cuaPipSessionEnabled,
    resolveCredentials: async () => {
      const host = defaultCuaProductHelperLifecycle.peek()?.helper.macPermissionHost;
      // PiP 客户端以 role=presentation 声明，资格由 Helper 按对端（ZCode 主进程）签名 identifier 裁决。
      if (host?.running && host.socketPath) {
        return {
          socketPath: host.socketPath,
        };
      }
      // 懒启动：无托管 host 时探测稳定 socket 上自启动的 Helper（probe-only，不拉起）。
      const stable = await probeStableCuaHelperSocket();
      return stable ? { socketPath: stable } : undefined;
    },
  });
  // 启动期就把 PiP 投递链的接线状态写出来。dev 实测 PiP 事件一条都没投，而
  // 「enabled=false」与「lifecycle 回调没挂（tracker 整体 undefined、accept 全程 no-op）」
  // 这两种成因在运行期都不产生任何日志，只能靠这行在启动时分辨——重启即可判定，
  // 不必先跑一轮 CUA。scope 沿用 cua-pip-session：已验证该 logger 的 info 会进宿主日志。
  createServiceLogger("cua-pip-session").info(undefined, "[cua-pip-session] wiring resolved", {
    enabled: cuaPipSessionEnabled,
    platform: process.platform,
    serviceAuthorityMode: options?.serviceAuthorityMode ?? null,
    lifecycleWired: options?.serviceAuthorityMode === "desktop-local",
  });
  // Computer Use Helper macOS 权限状态服务：renderer 经 host RPC 查询当前 Helper 的运行态与权限，并在
  // 用户授权后从明确入口精确重启一次 Helper。重启**必须走 resolver.restart()**（不是裸 host.restart），
  // 因为 resolver 优先复用既有 socket/token；裸 host.restart() 可能 fresh 新凭据，使已有 Agent
  // 继续持有旧 transport，无法连接新的 broker。
  const cuaPermissionService: ICuaPermissionService = {
    async getStatus(
      workspacePath: string,
      workspaceIdentity?: string,
      queryOptions?: CuaPermissionStatusQueryOptions,
    ): Promise<CuaPermissionStatusResult> {
      if (process.platform !== "darwin") {
        return {
          available: false,
          reason: "CUA permissions are only available on macOS.",
        };
      }
      const context = workspacePath ? { workspacePath, workspaceIdentity } : undefined;
      // 插件关闭只门控后续 Agent；权限页刷新不得进入 acquire，否则会把仍被已有 Agent 使用的 Helper 停掉。
      if (
        !shouldUseCuaPermissionService({
          cuaEnabled: isCuaEnabledForContext(context),
        })
      ) {
        return {
          available: false,
          reason: "ZCode Computer Use is not enabled (plugin off or not product mode).",
        };
      }
      // 懒启动：状态查询绝不拉起 Helper。托管 host 在（如刚完成授权流）→ 全量查询；
      // 否则探测稳定 socket 上自启动的 Helper（probe-only）；都没有 → 未运行（首次使用时自动启动）。
      const peeked = defaultCuaProductHelperLifecycle.peek()?.helper;
      const helper = peeked && isDefaultCuaProductHelperCurrent(peeked) ? peeked : undefined;
      const host = helper ? helper.macPermissionHost : undefined;
      if (!host || !host.running) {
        // Helper 按需启动：设置页查询 = 拉起 standalone Helper（稳定 socket、
        // 无 launcher-pid → 300s 无访问自动休眠，不进托管体系）。拉起后经稳定 socket 查真值。
        let stable = await probeStableCuaHelperSocket();
        if (!stable) {
          stable = await launchStandaloneCuaHelperForStatus();
        }
        if (!stable) {
          return {
            available: false,
            reason:
              "ZCode Computer Use is not running; it will start automatically on first Computer Use use.",
            idle: true,
          } satisfies { available: false; reason: string; idle: true };
        }
        // standalone Helper 上直接查权限真值（身份模式，无 token）。
        try {
          const { callBrokerMethod } = await import("@zcode/zcode-cua/broker/helperHealth");
          const report = await callBrokerMethod<{
            grant_owner: string;
            owner?: { display_name?: string };
            accessibility: CuaPermissionState;
            accessibility_probe_ok?: boolean;
            screen_recording: CuaPermissionState;
          }>({
            socketPath: stable,
            method: "permission_status",
            timeoutMs: 3000,
          });
          return {
            grantOwner: report.grant_owner,
            grantOwnerDisplayName: report.owner?.display_name ?? report.grant_owner,
            accessibility: report.accessibility,
            accessibilityProbeOk: report.accessibility_probe_ok === true,
            screenRecording: report.screen_recording,
            screenCaptureProbeOk: false,
          };
        } catch {
          return {
            available: false,
            reason: "ZCode Computer Use is starting up; retry in a moment.",
            idle: true,
          } satisfies { available: false; reason: string; idle: true };
        }
      }
      try {
        const report = await host.queryPermissionStatus();
        if (!helper || !isDefaultCuaProductHelperCurrent(helper)) {
          return {
            available: false,
            reason: "ZCode Computer Use lifecycle is disposed.",
          };
        }
        // Screen Recording 的真值必须来自一个新进程：撤销对已运行的常驻 Helper 不生效，
        // 它会一直报撤销前的 granted。拿不到真值时 fail-open 沿用 report 值。
        const screenRecording = await resolveCuaScreenRecordingState(host, report.screen_recording);
        if (!isDefaultCuaProductHelperCurrent(helper)) {
          return {
            available: false,
            reason: "ZCode Computer Use lifecycle is disposed.",
          };
        }
        // 真实 screen-capture 探针：TCC screen_recording === "granted" 只说明系统记录了授权，并不保证
        // WindowServer 已对本进程放行像素（wallpaper-frame / SR-not-live 背离）。只有真的抓到非空像素
        // 才算 screen 端到端可用——UI 的"就绪/自动关闭"据此判定。fail-closed：探测抛错/超时一律 false。
        // 用预检后的 state 做门控：预检已判 denied 时没有必要再花一次抓屏。
        const screenCaptureProbeOk = await runCuaScreenCaptureReadinessProbe(
          host,
          screenRecording,
          queryOptions,
        );
        if (!isDefaultCuaProductHelperCurrent(helper)) {
          return {
            available: false,
            reason: "ZCode Computer Use lifecycle is disposed.",
          };
        }
        const reportedOwnerDisplayName =
          typeof report.owner?.display_name === "string" ? report.owner.display_name : undefined;
        return {
          grantOwner: report.grant_owner,
          grantOwnerDisplayName: reportedOwnerDisplayName ?? report.grant_owner,
          accessibility: report.accessibility,
          accessibilityProbeOk:
            report.accessibility_probe?.ok === true &&
            report.accessibility_probe?.classification === "functional",
          screenRecording,
          screenCaptureProbeOk,
        };
      } catch (error) {
        return {
          available: false,
          reason: `Could not read Computer Use Helper permission status: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
    },
    async restartHelper(
      workspacePath: string,
      workspaceIdentity?: string,
      restartOptions?: CuaPermissionRestartOptions,
    ): Promise<CuaPermissionRestartResult> {
      if (process.platform !== "darwin") {
        return {
          ok: false,
          reason: "CUA permissions are only available on macOS.",
        };
      }
      const context = workspacePath ? { workspacePath, workspaceIdentity } : undefined;
      // 与 getStatus 一致：插件关闭时不触碰现有 Helper，避免设置页动作改变已有 Agent runtime。
      if (
        !shouldUseCuaPermissionService({
          cuaEnabled: isCuaEnabledForContext(context),
        })
      ) {
        return {
          ok: false,
          reason: "ZCode Computer Use is not enabled (plugin off or not product mode).",
        };
      }
      // 走 resolver.restart()，让 host 尽可能复用 transport；不得通过 disposeWorkspace
      // 重建正在运行的 Agent。
      const helper = await getOrCreateDefaultCuaProductHelper(context);
      const resolver =
        helper && helper.macPermissionHost && isDefaultCuaProductHelperCurrent(helper)
          ? helper.resolver
          : undefined;
      if (!resolver) {
        return {
          ok: false,
          reason: "ZCode Computer Use is not enabled (plugin off or not product mode).",
        };
      }
      try {
        if (restartOptions?.reason === "permission_granted") {
          await resolver.restartAfterPermissionGrant(restartOptions.onboardingSessionId);
        } else {
          await resolver.restart();
        }
        if (!helper || !isDefaultCuaProductHelperCurrent(helper)) {
          return {
            ok: false,
            reason: "ZCode Computer Use lifecycle is disposed.",
          };
        }
        return { ok: true };
      } catch (error) {
        return {
          ok: false,
          reason: `Failed to restart ZCode Computer Use: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
    },
  };
  const codingPlanSubscriptionService = createCodingPlanSubscriptionService({
    apiClient,
    credentialService,
    resolveOffPeakModelSelectionView: async () => {
      await providerRuntime.start();
      return buildOffPeakModelSelectionView(providerRuntime.registryService.getView());
    },
  });
  // OffPeakTaskService 单例在下方 DI register IIFE 中创建（晚于 agent service）；
  // 用前向引用 holder 惰性绑定——offPeak/create 协议请求只会发生在服务集合装配完成后。
  let offPeakTaskServiceForAgent: OffPeakTaskService | undefined;
  // desktop-attached-remote 装配不暴露 Off-Peak 工具面（远程不在支持范围）。
  const offPeakToolWiring =
    options?.serviceAuthorityMode === "desktop-attached-remote"
      ? {}
      : {
          resolveOffPeakClientConfig: () => codingPlanSubscriptionService.getOffPeakClientConfig(),
          resolveOffPeakTaskService: () => offPeakTaskServiceForAgent,
        };
  const zcodeAgentService = createZCodeAgentService({
    ...(agentAccountProviderConfigSource
      ? { accountProviderConfigSource: agentAccountProviderConfigSource }
      : {}),
    accountRequestAuthService,
    ...(modelSelectionReadinessSource ? { modelSelectionReadinessSource } : {}),
    authorizeLocalMediaPreviewPath: options?.authorizeLocalMediaPreviewPath,
    ...offPeakToolWiring,
    // 动态工作流灰度：与 Off-Peak 不同，
    // 这里不按 serviceAuthorityMode 裁剪——SSH/WSL/Docker 的 desktop-attached-remote Host
    // 是它自己那些 workspace 的唯一裁决者，灰度开启时远程 workspace 同样提供工作流。
    resolveDynamicWorkflowClientConfig: () =>
      codingPlanSubscriptionService.getDynamicWorkflowClientConfig(),
    commandResolver: options?.zcodeAgentCommandResolver,
    presentationSurface: resolveZCodeAgentPresentationSurface({
      runtimeSurface: options?.agentRuntimeContext?.runtimeSurface,
      serviceAuthorityMode: options?.serviceAuthorityMode,
      desktopContextPromptEnabled,
    }),
    onAutomationManualRunRequested: options?.onAutomationManualRunRequested,
    // createLocalServices 虽然暴露了 reporter 注入点，旧装配却没有继续传给
    // ZCodeAgentProcessManager，导致 host 永远不向 main 上报 Agent spawn/exit，进程监控器
    // 因而看不到实际运行的 Agent，也无法验证只读到可写升级是否复用同一进程。
    processLifecycleReporter: options?.processLifecycleReporter,
    spawnFallbackCwd: options?.zcodeAgentSpawnFallbackCwd,
    // browser-use：host→main 执行桥透传给 agent service 的 onRequest browserExecute 路由。
    browserControlExecutor: options?.browserControlExecutor,
    // 官方 Server MCP 身份头：host 是唯一身份权威，Agent 经反向请求索取。
    // Provider 存在性读取正式 Model Selection View；不恢复旧 Provider Snapshot。
    officialMcpAuthHeadersResolver: createOfficialMcpAuthHeadersResolver({
      accountRequestAuthService,
      credentialService,
      modelSelectionService: providerRuntime.modelSelection,
    }),
    // host 是身份权威边界：provenance/origin 必须在这里再校验一次，不能只依赖 agent
    // adapter 的 fetch wrapper。判定实现与 CLI 侧共用 @zcode/shared 的同一份，避免分叉。
    // origin 解析复用 resolveCurrentZCodeEndpointOrigin——与闲时任务同口径（含 settings
    // 覆盖），否则会出现"闲时任务能连、官方 MCP 连不上"。
    // dev 开关必须同样传入，否则本地自测会被 host 单方面拒绝。
    officialMcpTrustedOrigins: createOfficialMcpTrustedOriginRegistry({
      devTrustedOriginsRaw: process.env[OFFICIAL_MCP_DEV_TRUSTED_ORIGINS_ENV],
      resolveZCodeApiOrigin: resolveCurrentZCodeEndpointOrigin,
    }),
    cuaOperationStateReporter: shouldEnableCuaOperationStateReporter({
      serviceAuthorityMode: options?.serviceAuthorityMode,
      hasReporter: Boolean(options?.cuaOperationStateReporter),
    })
      ? options?.cuaOperationStateReporter
      : undefined,
    // ZCode 只发布 turn/session 事实；面板 terminal policy 由 producer coordinator 决定。
    ...(options?.serviceAuthorityMode === "desktop-local"
      ? {
          onCuaPipSessionLifecycle: (_workspace, event) => {
            void cuaPipSessionService.publishLifecycle(event);
          },
        }
      : {}),
    // 设置页的 HTTP 代理、No Proxy + 自定义 CA 按 spawn 时读取注入 agent 子进程 env，
    // 覆盖模型 API / MCP / Bash 出口流量并信任用户显式配置的证书；改动后下次启动 agent 生效。
    resolveSpawnEnv: async (context) => {
      const [settings] = await Promise.all([settingService.get(), providerRuntime.start()]);
      // 内置 Subagent 的旧覆盖必须在 CLI 独立读取之前导入，不能等待设置页操作。
      await subagentsService.prepareRuntimeState();
      const agentNetwork =
        isDesktopAttachedRemote && options?.remoteAgentNetwork
          ? options.remoteAgentNetwork
          : {
              httpProxy: settings.httpProxy,
              noProxy: settings.httpProxyNoProxy,
            };
      // 与 helper 创建同一个门控（isCuaEnabledForContext：dev/internal 特性 OR 官方插件 enablement），
      // 避免 dev mode 下 helper 建了但 resolveSpawnEnv 漏注入 broker env 的割裂。
      const cuaPluginEnabled = isCuaEnabledForContext(context);
      // 懒启动：darwin 上 spawn 绝不 acquire 拉起 Helper——已有 host（peek，比如刚走过
      // 授权流）则复用其 tuple；否则只注入稳定 socket，SDK 首次 CUA 调用自行拉起
      // （宿主启动/spawn 均不使 Helper 常驻）。win32 保留 acquire（token 模式）。
      const peekedHelper = defaultCuaProductHelperLifecycle.peek()?.helper;
      const helper = !cuaPluginEnabled
        ? undefined
        : peekedHelper && isDefaultCuaProductHelperCurrent(peekedHelper)
          ? peekedHelper
          : process.platform === "darwin"
            ? undefined
            : await getOrCreateDefaultCuaProductHelper(context);
      // setting.get / 生命周期队列都可能跨过 host dispose。仅凭调用前的 enabled 会让延迟恢复的
      // resolveSpawnEnv 在 terminal fence 后重新启动 Helper；必须在真正构造 env 前校验代际。
      const cuaProductHelperHost =
        helper && isDefaultCuaProductHelperCurrent(helper) ? helper.host : undefined;
      // 等待 Helper 启动前登记。Registry 只记录尝试过 admission 的 workspace，
      // 供后续配置/生命周期 bookkeeping 使用；recovery 只清理 marker，不回收已有 Agent。
      cuaProductHelperWorkspaceRegistry.setEnabled(context, Boolean(cuaProductHelperHost));
      let cuaProductHelperEnv: Record<string, string> = {};
      if (!helper && cuaPluginEnabled && process.platform === "darwin") {
        // 懒启动：无托管 host 时注入稳定 socket；无 token（身份模式）、无 pluginAuthority
        // （其校验方就是 host，host 缺席时无意义）。SDK ensureBrokerAvailable 负责拉起。
        // pluginAuthority 是 agent 进程内的 config-provenance 随机数（bootstrap 捕获后写进
        // node_repl 配置 env，core 比对两者证明该配置出自本 bootstrap 而非用户配置文件）；
        // 它不需要 host——托管态由 host 铸造，懒启动态在此按 spawn 铸造，语义与校验完全一致。
        cuaProductHelperEnv = {
          [BROKER_SOCKET_ENV]: resolveBrokerSocketPath(),
          [ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY]: randomBytes(16).toString("hex"),
        };
        cuaProductHelperWorkspaceRegistry.setEnabled(context, false);
      } else if (cuaProductHelperHost && helper) {
        const candidateEnv = await buildCuaProductHelperAgentEnv(
          cuaProductHelperHost,
          createServiceLogger("cua-product-helper"),
        );
        // host.start/checkHealth 也会 await；dispose 可能在这段等待中同步落 terminal fence。
        // 返回 spawn env 前二次核对代际，失效时显式标成 unavailable，绝不把已回收 tuple 交给晚到 Agent。
        if (isDefaultCuaProductHelperCurrent(helper)) {
          cuaProductHelperEnv = candidateEnv;
        } else {
          cuaProductHelperWorkspaceRegistry.setEnabled(context, false);
          cuaProductHelperEnv = {
            [BROKER_UNAVAILABLE_ENV]: "broker_unavailable: helper lifecycle is disposed",
          };
        }
      } else if (cuaPluginEnabled && defaultCuaProductHelperLifecycle.disposed) {
        cuaProductHelperEnv = {
          [BROKER_UNAVAILABLE_ENV]: "broker_unavailable: helper lifecycle is disposed",
        };
      }
      const telemetryEnv = getCapturedZCodeAgentTelemetryEnv();
      const telemetryConfigured = Boolean(
        telemetryEnv.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || telemetryEnv.OTEL_EXPORTER_OTLP_ENDPOINT,
      );
      const telemetryProfile = telemetryConfigured
        ? await oauthCredentialRepo.loadActiveUserProfile().catch(() => null)
        : null;
      const telemetryDeviceMid = telemetryConfigured
        ? options?.agentRuntimeContext?.getDeviceMid?.()?.trim()
        : undefined;
      // Host 是旧配置迁移的唯一写入者。Agent spawn 前等待初始化完成，避免 Worker
      // 先拿到尚不存在的 provider_config.json 并发布短暂空 Registry。
      await providerConfigRuntime.start();
      return {
        ...buildAgentRuntimeEnv({
          httpProxy: agentNetwork.httpProxy,
          noProxy: agentNetwork.noProxy,
          caCertPath: settings.httpProxyCaCertPath,
        }),
        // 把 host 解析出的权威 origin（含 settings 覆盖）下发给 agent，否则 agent 侧只按
        // env 推导，test env + 自定义端点时两侧信任判定的输入分叉、官方 MCP 整体 fail closed。
        ...buildAgentEndpointOriginEnv(await resolveCurrentZCodeEndpointOrigin()),
        // broker 凭据（socket/token）注入 agent spawn env，让内置 zcode-cua plugin 的
        // computer-use MCP server 经 __zcode-plugin-host 恢复 token 后连上 broker。
        // 上面 cuaProductHelperEnv 已完成代际校验与 unavailable 兜底，取代 staging 侧
        // 直接调用 buildCuaProductHelperAgentEnv 的旧路径。
        ...cuaProductHelperEnv,
        ...buildAgentTelemetrySpawnEnv({
          deviceMid: telemetryDeviceMid,
          runtimeSurface: options?.agentRuntimeContext?.runtimeSurface ?? "remote_workspace_host",
          telemetryEnv,
          userId: telemetryProfile?.id,
        }),
        ...createNodeProviderRuntimePathEnv({
          // Built-in Active 路径按当前 Endpoint 隔离，不能通过同步的固定路径
          // getter 读取；Agent spawn 必须等待本轮 Endpoint Source 完成解析和物化。
          zcodeBuiltinFilePath: await providerConfigRuntime.resolveZCodeBuiltinActiveFilePath(),
          personalFilePath: join(resolveAppConfigDir(), PERSONAL_PROVIDER_CONFIG_FILE_NAME),
        }),
      };
    },
    ...(isDesktopAttachedRemote
      ? { sessionRuntimePreferencesAuthority: "external" as const }
      : {
          sessionRuntimePreferencesAuthority: "local" as const,
          resolveSessionRuntimePreferences: async (scope) => {
            // 预算已统一，不能把可选远端配置作为本地/手机 shared-host 建会话的前置条件。
            const settings = await settingService.get();
            const modelContextBudgetStrategy = DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY;
            return {
              askUserQuestionAutoResolutionEnabled:
                settings.askUserQuestionAutoResolutionEnabled !== false,
              nativeSearchEnhancementsEnabled: settings.nativeSearchEnhancementsEnabled !== false,
              memoryEnabled: settings.memoryEnabled === true,
              modelContextBudgetStrategy,
              // user-execution 只消费 Shell；共享默认策略是统一 result schema 的兼容占位，
              // 不会覆盖 runtime-materialization 阶段已经固定的 strategy。
              ...(scope === "user-execution" && settings.integratedTerminalShell
                ? { integratedTerminalShell: settings.integratedTerminalShell }
                : {}),
            };
          },
        }),
  });
  providerConnectivityAgentService = zcodeAgentService;
  // Helper health probe 短暂超时不应在 Computer Use turn 中途回收 Agent。resolver 会把 restart
  // 推迟到下一个 request/turn 边界；若 broker 确实已失效，当前 turn 会自然失败并由下一次请求恢复。
  hasActiveTurnRef = () => zcodeAgentService.hasActiveCuaOperationTurn();
  // desktop-continuous UI 直接订阅 zcodeSessionService，绕开 ZCode task adapter 的
  // mapServiceEvent 路径，导致 task_complete 永远不会写回 sqlite，侧边栏 spinner 不停。
  // 在 services 层装配一个共享的 taskIndexRepo + syncer，session 任意入口都会唤醒
  // shadow 订阅，把 runtime 终态收敛进 sqlite。
  const zcodeTaskIndexSyncer = createZCodeTaskIndexSyncer({
    agentService: zcodeAgentService,
    taskIndexRepo,
  });
  // The plugin can be toggled at runtime. Do not let a previously created resolver continue
  // health-checking/restarting Helper after disable, and create it lazily after enable.
  // 动态 resolver：isPluginEnabled 与 helper 创建用同一个 isCuaEnabledForContext 门控（dev mode 一致），
  // 避免开发场景下 resolver pass-through 而 helper 已建的割裂。
  const defaultCuaProductMcpServerResolver = createDynamicCuaProductMcpServerResolver({
    isPluginEnabled: (context) => isCuaEnabledForContext(context),
    getResolver: async () => {
      // peek-only——resolver 属托管 host 体系，host 未建时返回 undefined（懒启动下
      // CUA 经 node_repl + 稳定 socket，不依赖此 resolver）；绝不在此 acquire。
      const helper = defaultCuaProductHelperLifecycle.peek()?.helper;
      return helper && isDefaultCuaProductHelperCurrent(helper) ? helper.resolver : undefined;
    },
    isResolverCurrent: (resolver) =>
      defaultCuaProductHelperLifecycle.peek()?.helper.resolver === resolver,
  });
  const cuaProductMcpServerResolver =
    options?.cuaProductMcpServerResolver ?? defaultCuaProductMcpServerResolver;
  const zcodeSessionService = createZCodeSessionService({
    agentService: zcodeAgentService,
    taskIndexSyncer: zcodeTaskIndexSyncer,
    cuaProductMcpServerResolver,
  });
  const gitCommitMessageGenerator = new GitCommitMessageGenerator({
    currentModelProvider: {
      async readCurrentModel() {
        // Git sidecar 属于目标 Environment；初始模型直接读取同一 Host View，
        // 不再通过临时 Agent workspace state 反推模型与 reasoning。
        return (await providerRuntime.modelSelection.getView()).preferredSelection ?? null;
      },
    },
    textGenerator: {
      async generateText(params) {
        return await zcodeAgentService.generateWorkspaceText({
          workspacePath: params.workspacePath,
          ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
          selection: params.selection,
          prompt: params.prompt,
          querySource: params.querySource,
        });
      },
    },
    logger: createServiceLogger("git-commit-message"),
  });
  const gitService = createGitService({
    commitMessageGenerator: gitCommitMessageGenerator,
  });
  // task wrapper 由 ZCode task service adapter 提供；核心 session 状态由 ZCode agent server 维护。
  const zcodeTaskService = createZCodeTaskServiceAdapter({
    zcodeAgentService,
    taskIndexRepo,
    taskIndexSyncer: zcodeTaskIndexSyncer,
    settingService,
    cuaProductMcpServerResolver,
  });
  const botRemoteWorkspaceService = createBotRemoteWorkspaceService({
    parentPort: options?.parentPort,
    settingService,
    credentialService,
  });
  const oauthService = createOAuthService(credentialService, {
    apiClient,
    onProviderLogout: handleOAuthProviderLogout,
  });
  const zcodeJwtLogoutLogger = createServiceLogger("zcode-jwt-logout");
  zcodeJwtLogoutHandlerRef.current = (input, headers) => {
    // 条件退出本身已串行去重；不能丢弃等待旧候选期间到来的新凭据 401。
    void oauthService
      .logoutIfCurrentCredentialRequest(input, headers)
      .then((invalidated) => {
        // 401 分类后可能已完成新登录；只有队列内真正清理的旧会话才广播过期。
        if (invalidated) {
          void broadcastService.send({
            channel: ZCODE_JWT_INVALID_BROADCAST_CHANNEL,
            payload: {},
          });
        }
      })
      .catch((error) => {
        zcodeJwtLogoutLogger.warn("ZCode JWT logout failed", { error });
      });
  };
  // Desktop Host 曾从 Settings View 再扫描一次 Account Provider，既绕开
  // Registry 的 entitlement/executable 事实，也在多个套餐同时可见时无法唯一选择。
  // 闲时服务与 Host 派发必须共享同一个 Registry-backed 凭据解析闭包。
  const offPeakCredentialResolverDeps = {
    credentialService,
    accountRequestAuthService,
    resolveAccountProvider: async () => {
      await providerRuntime.start();
      // start 缓存的是首次就绪；账号后到或切换后必须读 Registry 最近完成的快照。
      const snapshot = providerRuntime.registryService.getSnapshot()!;
      const providers = snapshot.resolution.registryProviders.filter(
        (candidate) =>
          candidate.config.access.type === "zhipu-account" &&
          (candidate.config.access.mode === "individual-coding-plan" ||
            candidate.config.access.mode === "team-coding-plan"),
      );
      if (providers.length !== 1) return null;
      const provider = providers[0]!;
      const config = provider.config;
      const staticAccess = zcodeProviderAccountAccessSchema.parse(config.access.toJSON());
      const access = await accountRequestAuthService.resolveAccessCurrent(staticAccess);
      if (!access) return null;
      return {
        providerId: provider.providerId,
        access: zcodeAccountAccessSchema.parse(access),
        ...(config.api?.baseUrl ? { baseURL: config.api.baseUrl } : {}),
      };
    },
  };
  const buildOffPeakRequestAuthForTicket: OffPeakRequestAuthBuilder = async (ticketId) =>
    buildOffPeakRequestAuth({
      credentials: await resolveOffPeakCredentials(offPeakCredentialResolverDeps),
      ticketId,
    });
  const fileService = createFileService({
    workspaceFileSearchFilter: options?.workspaceFileSearchFilter,
  });
  const mediaPreviewService = createMediaPreviewService({
    fileService,
    authorizeLocalMediaPreviewPath: options?.authorizeLocalMediaPreviewPath,
    createLocalMediaPreviewUrl: buildLocalMediaPreviewUrl,
  });
  const conversationShareClient = new ConversationShareHttpClient({
    // 分享运行时始终走真实 API；测试/Mock 场景应在 service 单测或 Web fixture 中显式注入，
    // 不能让开发环境默认生成仅存在于进程内存的 mock-share 链接。
    apiClient,
    baseUrl: buildRuntimeZCodeApiUrl(process.env, "/api/v1"),
    tokenProvider: async (): Promise<string | null> => {
      const activeProvider = await oauthCredentialRepo.getActiveProvider();
      if (!activeProvider) {
        return null;
      }
      const tokenSet = await oauthCredentialRepo.loadTokenSet(activeProvider);
      return tokenSet?.zcodeJwtToken ?? tokenSet?.accessToken ?? null;
    },
  });
  const conversationShareService: IConversationShareServiceType = isDesktopAttachedRemote
    ? createUnsupportedConversationShareService({
        message: "Conversation publishing is not available for remote workspaces",
      })
    : new ConversationShareService({
        zcodeAgentService,
        zcodeSessionService,
        client: conversationShareClient,
        artifactSource: createLocalConversationShareArtifactSource(),
      });
  // 注册链上的懒工厂（如 OffPeak）会各自创建 tasks-index sqlite repo；先收集到本数组，
  // services 集合建好后在 return 前统一登记进 sharedSqliteRepos 侧表
  const sqliteReposToClose: Array<{ close(): void }> = [];
  const services = new ServiceCollection()
    .register(IFileService, fileService)
    .register(IMediaPreviewService, mediaPreviewService)
    .register(IGitService, gitService)
    .register(IGitCheckpointService, gitCheckpointService)
    .register(ISystemService, systemService)
    .register(ITerminalService, createTerminalService({ settingService }))
    .register(ISettingService, settingService)
    .register(IOnboardingRecordService, onboardingRecordService)
    .register(ICredentialService, credentialService)
    .register(IBroadcastService, broadcastService)
    .register(IZCodeTaskService, zcodeTaskService)
    .register(IZCodeAgentService, zcodeAgentService)
    .register(IZCodeSessionService, zcodeSessionService)
    .register(ICuaPermissionService, cuaPermissionService)
    .register(ICuaPipSessionService, cuaPipSessionService)
    .register(IConversationShareService, conversationShareService)
    .register(
      IBotsService,
      createBotsService({
        credentialService,
        zcodeTaskService,
        broadcastService,
        settingService,
        modelSelectionService: providerRuntime.modelSelection,
        remoteWorkspaceService: botRemoteWorkspaceService,
        // 远端与本地 Bot 都读取所属 Environment 的 Model Selection View。
        // 远端启动期不再轮询旧 Preset，避免重新制造一套模型候选事实。
        runStartupBackgroundTasks: !isDesktopAttachedRemote,
      }),
    )
    .register(IFileWatcherService, createFileWatcherService())
    .register(IOAuthService, oauthService)
    .register(
      IUsageStatsService,
      createUsageStatsService({
        apiClient,
        accountRequestAuthService,
        credentialService,
        zcodeAgentService,
        officialMcpCredentialSource,
      }),
    )
    .register(ICodingPlanSubscriptionService, codingPlanSubscriptionService)
    .register(
      IClientConfigService,
      createClientConfigService({
        apiClient,
        resolveRequestContext: async () => ({
          endpointOrigin: await resolveCurrentZCodeEndpointOrigin(),
          appVersion: ZCODE_VERSION,
          platform: `${process.platform}-${process.arch}`,
        }),
      }),
    )
    .register(IClientScenesService, createClientScenesService({ apiClient }))
    .register(
      IOffPeakTaskService,
      (() => {
        // 闲时任务编排服务（与 automation 服务面独立）：
        // 单例属主在本集合，renderer 经 ProxyChannel 直连，host 派发经 getOptional 取同一实例。
        const offPeakLogger = createServiceLogger("off-peak");
        const resolveCredentials = () => resolveOffPeakCredentials(offPeakCredentialResolverDeps);
        const originResolver = createOffPeakOriginResolver({
          logger: offPeakLogger,
          resolveUpstream: () => resolveOffPeakMockUpstream(offPeakCredentialResolverDeps),
        });
        const offPeakTaskRepo = new OffPeakTaskRepo();
        // OffPeakTaskRepo 也持有 tasks-index.sqlite 连接；收集到链前数组，services 建好后统一登记
        // （工厂在注册链求值期执行，此时 services 常量尚未初始化，不能直接引用）
        sqliteReposToClose.push(offPeakTaskRepo);
        const offPeakTaskService = new OffPeakTaskService({
          repo: offPeakTaskRepo,
          client: createOffPeakServerClient({
            resolveOrigin: originResolver.resolveOrigin,
            resolveCredentials,
            logger: offPeakLogger,
          }),
          resolveCodingPlanSupport: () =>
            resolveOffPeakCodingPlanSupport(offPeakCredentialResolverDeps),
          resolveTelemetryProviderName: async () =>
            resolveSafeEndpointHostname(await originResolver.resolveOrigin()),
          resolveModelSelection: async (input) => {
            await providerRuntime.start();
            const support = await resolveOffPeakCodingPlanSupport(offPeakCredentialResolverDeps);
            const providerId = support.supported
              ? OFF_PEAK_PROVIDER_IDS[support.providerFamily]
              : undefined;
            const provider = providerId
              ? providerRuntime.registryService
                  .getView()
                  .providers.find((candidate) => candidate.providerId === providerId)
              : undefined;
            const modelId = input.modelId ?? provider?.models[0]?.modelId;
            if (!provider || !modelId) {
              return {
                ok: false as const,
                validation: {
                  ok: false as const,
                  code: "provider-not-found" as const,
                  providerId: OFF_PEAK_PROVIDER_IDS.zai,
                },
              };
            }
            // 旧行没有 Provider 身份；只能复用当前账号凭据链已裁定的 Account Family，
            // 不能靠 Registry/JSON 顺序在 Z.ai 与 BigModel 间猜测。
            const selection = {
              providerId: provider.providerId,
              modelId,
              ...(input.reasoningLevel
                ? { options: { reasoningLevel: input.reasoningLevel } }
                : {}),
            };
            const validation = providerRuntime.registryService.validateSelection(selection);
            return validation.ok
              ? { ok: true as const, selection }
              : { ok: false as const, validation };
          },
          logger: offPeakLogger,
          requestSchedulerWake: options?.onOffPeakSchedulerWakeRequested,
          stopRunningTask: async (params) => {
            await zcodeTaskService.stopGeneration({
              taskId: params.conversationId,
              workspacePath: params.workspacePath,
              ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
            });
          },
          onDispose: () => {
            void originResolver.close().catch(() => undefined);
          },
        });
        offPeakTaskService.startSync();
        // 回写前向引用，供 zcodeAgentService 的 offPeak/create、offPeak/list 协议 handler 调用。
        offPeakTaskServiceForAgent = offPeakTaskService;
        return offPeakTaskService;
      })(),
    )
    .register(ISkillsService, skillsService)
    .register(ISkillSyncService, createSkillSyncService())
    .register(IMcpSyncService, mcpSyncService)
    // 合并 MCP/Plugin Management 服务装配时误删了 plugin-sync 注册，
    // RemoteServiceAccess 仍会请求该频道，导致本地候选枚举超时、远端同步无法开始。
    .register(IPluginSyncService, pluginSyncService)
    .register(IPluginsService, createPluginsService({ isDesktopRuntime: true }))
    // 设置页插件管理薄服务——plugins/* 旧协议词的 host 侧唯一消费点。
    .register(IPluginManagementService, createPluginManagementService({ zcodeAgentService }))
    .register(ISubagentsService, subagentsService)
    .register(ICommandsService, createCommandsService({ isDesktopRuntime: true }))
    .register(
      IHooksService,
      createHooksService({
        grantWorkspaceHookTrust: (params) => zcodeAgentService.grantWorkspaceHookTrust(params),
      }),
    )
    .register(IMemoryService, createMemoryService())
    .register(ISettingsSyncService, createSettingsSyncService({ settingService }))
    .register(
      IFeedbackService,
      createFeedbackService({
        ...options?.feedback,
        apiClient,
        credentialService,
        oauthService,
      }),
    )
    .register(IPromptAttachmentTransferService, createLocalPromptAttachmentTransferService());

  // 即使初始配置关闭也必须登记 lifecycle disposer：terminal fence 需要早于任意延迟 setting/acquire
  // 恢复，不能把"当前还没有 Helper"误当成"不需要生命周期所有者"。dispose 时串行 stop host。
  registerManagedCuaHelperHostForDispose(services, {
    stop: async () => {
      await defaultCuaProductHelperLifecycle.dispose();
    },
  });
  registerHostApiNetworkTransportForDispose(services, hostApiNetworkTransport);
  // disposer 注册完成后才排预热。若 createLocalServices 中途抛错，不能留下一个无人持有、却会在当前
  // 调用栈结束后才创建的高权限 Helper；若返回后立即 dispose，terminal fence 会先于 acquire 生效。
  // Helper 懒启动：不预热——Helper 由 SDK 首次 CUA 调用拉起（spawn env 注入
  // 稳定 socket），或用户显式授权流（restartHelper）拉起。启动即零 Helper 常驻。

  accountRequestAuthServices.set(services, accountRequestAuthService);
  offPeakRequestAuthBuilders.set(services, buildOffPeakRequestAuthForTicket);

  providerRuntimes.set(services, providerRuntime);
  providerProvisioningSources.set(services, providerProvisioningSource);
  providerProvisioningTriggerDisposers.set(services, providerProvisioningDisposers);
  services
    .register(IProviderSettingsService, providerRuntime.providerSettings)
    .register(IModelSelectionService, providerRuntime.modelSelection);
  if (isDesktopAttachedRemote || options.providerProvisioningTargetEnabled === true) {
    services.register(
      IProviderProvisioningTargetService,
      createProviderProvisioningTarget({
        providerRuntime,
        personalRepository: providerConfigRuntime.personalRepository,
        accountProviderSource: accountProviderConfigSource,
        credentialService,
        settingService,
        personalConfigFilePath: join(resolveAppConfigDir(), PERSONAL_PROVIDER_CONFIG_FILE_NAME),
        stateFilePath: join(resolveAppConfigDir(), "runtime", "provider", "provisioning.json"),
        listProvisioningCredentialKeys: () =>
          listProviderProvisioningCredentialKeys(resolveCredentialFilePath(resolveAppConfigDir())),
      }),
    );
  }
  const log = createServiceLogger("provider-runtime");
  void providerRuntime.start().then(
    () => {
      const snapshot = providerRuntime.registryService.getSnapshot()!;
      log.info("Provider Registry 已就绪", {
        configRevision: snapshot.sourceRevisions.config,
        providerCount: snapshot.registry.providers.length,
      });
    },
    (error: unknown) => {
      log.error("Provider 配置事实初始化失败", error);
    },
  );

  // 见 sharedSqliteRepos 声明处注释：登记全部 tasks-index sqlite 句柄，dispose 链统一关闭
  sqliteReposToClose.push(taskIndexRepo);
  sharedSqliteRepos.set(services, sqliteReposToClose);
  return services;
}

export function createTelemetryUserIdLoader(
  credentialService: Pick<ICredentialService, "load">,
): () => Promise<string> {
  const log = createServiceLogger("telemetry-user-id");
  return async () => {
    try {
      const activeProvider = (await credentialService.load("oauth:active_provider"))?.trim() ?? "";
      if (!activeProvider) {
        return "";
      }

      const rawUserInfo = await credentialService.load(`oauth:${activeProvider}:user_info`);
      return readTelemetryOAuthUserId(rawUserInfo);
    } catch (error) {
      if (!isCredentialDecryptError(error)) {
        throw error;
      }

      // Bugfix: telemetry 只是只读 userId 上报入口，不能抢在 host OAuthService 前
      // 对损坏凭据做半套清理；否则会漏掉派生模型 provider key 的 logout 收口。
      log.warn(undefined, "skip telemetry user id: OAuth credential decrypt failed", error);
      return "";
    }
  };
}

/** 仅给同一事件账号返回当前 ZCode JWT；不缓存、不修改登录凭据。 */
export function createTelemetryAuthorizationLoader(
  credentialService: Pick<ICredentialService, "load">,
): (userId: string) => Promise<string | null> {
  return async (userId) => {
    if (!userId) return null;
    try {
      const provider = (await credentialService.load("oauth:active_provider"))?.trim();
      if (provider !== "zai" && provider !== "bigmodel") return null;
      const readUserId = async () =>
        readTelemetryOAuthUserId(await credentialService.load(`oauth:${provider}:user_info`));
      if ((await readUserId()) !== userId) return null;
      const jwt = (await credentialService.load("zcodejwttoken"))?.trim();
      // 退出/切账号可能发生在异步读取期间；禁止将旧身份的 token 附到其他账号事件上。
      if (
        (await credentialService.load("oauth:active_provider"))?.trim() !== provider ||
        (await readUserId()) !== userId
      )
        return null;
      return jwt && /^[\x21-\x7e]+$/.test(jwt) ? `Bearer ${jwt}` : null;
    } catch {
      return null;
    }
  };
}

export function createTelemetryMarketingParamsLoader(
  credentialService: ICredentialService,
): () => Promise<import("@zcode/shared").OAuthLoginAttribution | null> {
  // 恢复原因：固定返回 null 会丢掉已保存的渠道归因，数仓应读取 OAuth 的同一份事实。
  const repo = new OAuthCredentialRepo(credentialService);
  return () => repo.loadLoginAttribution();
}

function readTelemetryOAuthUserId(rawUserInfo: string | null): string {
  if (!rawUserInfo) {
    return "";
  }

  try {
    const parsed = JSON.parse(rawUserInfo) as {
      id?: unknown;
      user_id?: unknown;
    };
    const id = typeof parsed.id === "string" ? parsed.id : "";
    const userId = typeof parsed.user_id === "string" ? parsed.user_id : "";
    return id.trim() || userId.trim();
  } catch {
    return "";
  }
}

export function disposeServiceResources(services: ServiceCollection): void {
  // host process 退出前以前没有统一遍历本地服务做资源回收，
  // terminal/task wrapper 这类会拉起子进程的服务只能等宿主进程自己结束，时序上可能留下短暂残留。
  // 这里集中调用各服务的本地 disposeAll 钩子，把“退出 app = 回收所有托管资源”落成机械动作。
  const disposableServices = [
    services.getOptional(ITerminalService),
    services.getOptional(IZCodeTaskService),
    services.getOptional(IZCodeAgentService),
    services.getOptional(IZCodeSessionService),
    services.getOptional(IBotsService),
    services.getOptional(IFileWatcherService),
    services.getOptional(IOffPeakTaskService),
  ].filter((service) => service !== undefined);

  for (const service of disposableServices) {
    if (hasDisposeAll(service)) {
      service.disposeAll();
    }
  }

  // 同步 best-effort：终止托管的 Computer Use Helper（不 await，避免阻断同步 dispose 路径）。
  const managedCuaHelperHost = managedCuaHelperHosts.get(services);
  if (managedCuaHelperHost) {
    void managedCuaHelperHost.stop().catch(() => {});
  }
  // 关闭共享 tasks-index sqlite 句柄（Windows 上悬着句柄会让后续目录清理撞 EBUSY）
  for (const repo of sharedSqliteRepos.get(services) ?? []) repo.close();
  sharedSqliteRepos.delete(services);
  providerRuntimes.get(services)?.dispose();
  for (const dispose of providerProvisioningTriggerDisposers.get(services) ?? []) dispose();
  providerProvisioningTriggerDisposers.delete(services);
  providerProvisioningSources.delete(services);
  managedHostApiNetworkTransports.get(services)?.dispose();
}

export async function disposeServiceResourcesAndWait(services: ServiceCollection): Promise<void> {
  // app 关闭时 host 需要等 agent 进程树完成 graceful + force 清理。
  // 旧的同步 dispose 会在 host 退出时丢掉强杀 timer，导致 zcode-cli/app-server 变成孤儿进程。
  const disposableServices = [
    services.getOptional(ITerminalService),
    services.getOptional(IZCodeTaskService),
    services.getOptional(IZCodeAgentService),
    services.getOptional(IZCodeSessionService),
    services.getOptional(IBotsService),
    services.getOptional(IFileWatcherService),
    services.getOptional(IOffPeakTaskService),
  ].filter((service) => service !== undefined);

  for (const service of disposableServices) {
    if (hasDisposeAllAndWait(service)) {
      await service.disposeAllAndWait();
    } else if (hasDisposeAll(service)) {
      service.disposeAll();
    }
  }

  // 等待托管的 Computer Use Helper 终止（best-effort）：Helper 是长生命周期高权限进程，服务释放语义必须显式
  // 收口它，不能只靠 launcher-pid watchdog / 进程退出兜底。
  const managedCuaHelperHost = managedCuaHelperHosts.get(services);
  if (managedCuaHelperHost) {
    await managedCuaHelperHost.stop().catch(() => {});
  }
  // 关闭共享 tasks-index sqlite 句柄（同 disposeServiceResources，异步收口路径也要释放）
  for (const repo of sharedSqliteRepos.get(services) ?? []) repo.close();
  sharedSqliteRepos.delete(services);
  providerRuntimes.get(services)?.dispose();
  for (const dispose of providerProvisioningTriggerDisposers.get(services) ?? []) dispose();
  providerProvisioningTriggerDisposers.delete(services);
  providerProvisioningSources.delete(services);
  await managedHostApiNetworkTransports
    .get(services)
    ?.disposeAndWait()
    .catch(() => {});
}
