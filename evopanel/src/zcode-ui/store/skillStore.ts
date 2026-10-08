import { create } from "zustand";
import {
  normalizeAgentProviderToZCodeAgent,
  ZCODE_AGENT_PROVIDER,
  type ZCodeProvider,
  type SkillSummary,
  type SkillsCapability,
} from "@zcode/shared";
import type { ISkillsService } from "@zcode/services";
import { shouldExposeE2EStoreBridge } from "@/lib/e2eStoreBridge.js";
import { logger } from "@/logger.js";

interface SkillStoreState {
  workspacePath: string | null;
  workspaceIdentity: string | null;
  loadedWorkspacePath: string | null;
  loadedWorkspaceIdentity: string | null;
  provider: ZCodeProvider;
  loadedProvider: ZCodeProvider | null;
  skills: SkillSummary[];
  capability: SkillsCapability | null;
  loading: boolean;
  error: string | null;
  initialize: (
    workspacePath: string,
    providerOrSkillsService: ZCodeProvider | ISkillsService,
    maybeSkillsService?: ISkillsService,
    workspaceIdentity?: string,
  ) => Promise<void>;
  refresh: (skillsService: ISkillsService, workspaceIdentity?: string) => Promise<void>;
  setEnabled: (
    skillId: string,
    providerOrEnabled: ZCodeProvider | boolean,
    scopeOrSkillsService: SkillSummary["scope"] | ISkillsService,
    enabledOrSkillsService?: boolean | ISkillsService,
    maybeSkillsService?: ISkillsService,
    workspaceIdentity?: string,
  ) => Promise<void>;
}

const inFlightSkillLoads = new Map<string, ReturnType<ISkillsService["list"]>>();

function getSkillLoadKey(
  workspacePath: string,
  provider: ZCodeProvider,
  workspaceIdentity?: string,
): string {
  return `${workspaceIdentity?.trim() || workspacePath}::${provider}`;
}

function loadSkillsOnce(
  workspacePath: string,
  provider: ZCodeProvider,
  skillsService: ISkillsService,
  workspaceIdentity?: string,
  options: { bypassCache?: boolean } = {},
): ReturnType<ISkillsService["list"]> {
  const key = getSkillLoadKey(workspacePath, provider, workspaceIdentity);
  if (!options.bypassCache) {
    const current = inFlightSkillLoads.get(key);
    if (current) {
      return current;
    }
  }
  // 复制/移除技能到通用目录后 refresh 必须拿到最新结果。
  // 若复用 in-flight Promise 会返回旧扫描结果，导致 chat mention 看不到新加的技能。
  const request = skillsService.list({ workspacePath, workspaceIdentity, provider }).finally(() => {
    // 仅在自己是当前活跃 in-flight 时清理，避免覆盖其他并发请求。
    if (inFlightSkillLoads.get(key) === request) {
      inFlightSkillLoads.delete(key);
    }
  });
  inFlightSkillLoads.set(key, request);
  return request;
}

export const useSkillStore = create<SkillStoreState>((set, get) => ({
  workspacePath: null,
  workspaceIdentity: null,
  loadedWorkspacePath: null,
  loadedWorkspaceIdentity: null,
  provider: ZCODE_AGENT_PROVIDER,
  loadedProvider: null,
  skills: [],
  capability: null,
  loading: false,
  error: null,
  async initialize(
    workspacePath: string,
    providerOrSkillsService: ZCodeProvider | ISkillsService,
    maybeSkillsService?: ISkillsService,
    workspaceIdentity?: string,
  ) {
    const currentState = get();
    const hasProvider = typeof providerOrSkillsService === "string";
    const provider = normalizeAgentProviderToZCodeAgent(
      hasProvider ? providerOrSkillsService : ZCODE_AGENT_PROVIDER,
    );
    const skillsService = hasProvider ? maybeSkillsService : providerOrSkillsService;
    const normalizedWorkspaceIdentity = workspaceIdentity?.trim() || null;
    if (!skillsService) {
      set({
        workspacePath,
        workspaceIdentity: normalizedWorkspaceIdentity,
        provider,
        loading: false,
        error: "skillsService is required",
        loadedWorkspacePath: workspacePath,
        loadedWorkspaceIdentity: normalizedWorkspaceIdentity,
        loadedProvider: provider,
      });
      return;
    }
    const hasCachedSkills =
      currentState.skills.length > 0 &&
      currentState.loadedWorkspacePath === workspacePath &&
      currentState.loadedWorkspaceIdentity === normalizedWorkspaceIdentity &&
      currentState.loadedProvider === provider;
    // 切换 agent 筛选时会触发 initialize。
    // 之前总是 loading=true，会先清空成“加载中”再渲染结果，导致列表闪烁。
    // 这里改成“只有同一 workspace+provider 的缓存才允许复用”，避免上一套技能误显示到当前会话里。
    set({
      workspacePath,
      workspaceIdentity: normalizedWorkspaceIdentity,
      provider,
      skills: hasCachedSkills ? currentState.skills : [],
      capability: hasCachedSkills ? currentState.capability : null,
      loading: !hasCachedSkills,
      error: null,
    });
    try {
      // 聊天输入区会同时挂载多个技能消费者（例如 $ mention 与 / 面板）。
      // 之前它们首屏会并发触发相同的 list 请求，进而把服务层镜像同步竞争放大成用户可见报错。
      // 这里先按 workspace+provider 去重，同一轮只复用一个请求结果。
      const result = await loadSkillsOnce(
        workspacePath,
        provider,
        skillsService,
        normalizedWorkspaceIdentity ?? undefined,
      );
      set({
        skills: result.skills,
        capability: result.capability,
        loading: false,
        loadedWorkspacePath: workspacePath,
        loadedWorkspaceIdentity: normalizedWorkspaceIdentity,
        loadedProvider: provider,
      });
    } catch (error) {
      logger.error("[skills] initialize failed", {
        workspacePath,
        provider,
        error: error instanceof Error ? error.message : String(error),
      });
      set({
        loading: false,
        error: error instanceof Error ? error.message : String(error),
        loadedWorkspacePath: workspacePath,
        loadedWorkspaceIdentity: normalizedWorkspaceIdentity,
        loadedProvider: provider,
      });
    }
  },
  async refresh(skillsService: ISkillsService, workspaceIdentity?: string) {
    const workspacePath = get().workspacePath;
    if (!workspacePath) {
      return;
    }
    const workspaceIdentityFromState =
      workspaceIdentity?.trim() || get().workspaceIdentity || undefined;
    const provider = normalizeAgentProviderToZCodeAgent(get().provider);
    const hasCachedSkills = get().skills.length > 0;
    // 开关技能后会触发 refresh，之前每次都把 loading 置 true，
    // Settings 列表会先切到“加载中”再切回数据，用户看到整列表闪烁。
    // 这里改成“仅首次无缓存时显示阻塞 loading”，有缓存时后台刷新并保留当前列表。
    set({ loading: !hasCachedSkills, error: null });
    // refresh 必须保证拿到「最新一次」的服务端结果。
    // 直接调 loadSkillsOnce 会复用 in-flight 的旧请求，
    // 导致复制 skill 到通用目录后 chat mention 仍看到旧列表。
    // 这里在 refresh 时显式跳过 in-flight 缓存，强制发起一次新请求。
    inFlightSkillLoads.delete(getSkillLoadKey(workspacePath, provider, workspaceIdentityFromState));
    try {
      const result = await loadSkillsOnce(
        workspacePath,
        provider,
        skillsService,
        workspaceIdentityFromState,
      );
      set({
        skills: result.skills,
        capability: result.capability,
        loading: false,
        loadedWorkspacePath: workspacePath,
        loadedWorkspaceIdentity: workspaceIdentityFromState ?? null,
        loadedProvider: provider,
      });
    } catch (error) {
      logger.error("[skills] refresh failed", {
        workspacePath,
        provider,
        error: error instanceof Error ? error.message : String(error),
      });
      set({
        loading: false,
        error: error instanceof Error ? error.message : String(error),
        loadedWorkspacePath: workspacePath,
        loadedWorkspaceIdentity: workspaceIdentityFromState ?? null,
        loadedProvider: provider,
      });
    }
  },
  async setEnabled(
    skillId: string,
    providerOrEnabled: ZCodeProvider | boolean,
    scopeOrSkillsService: SkillSummary["scope"] | ISkillsService,
    enabledOrSkillsService?: boolean | ISkillsService,
    maybeSkillsService?: ISkillsService,
    workspaceIdentity?: string,
  ) {
    const workspacePath = get().workspacePath;
    if (!workspacePath) {
      return;
    }
    const workspaceIdentityFromState =
      workspaceIdentity?.trim() || get().workspaceIdentity || undefined;
    const legacyCall = typeof providerOrEnabled === "boolean";
    const provider = normalizeAgentProviderToZCodeAgent(
      legacyCall ? get().provider : providerOrEnabled,
    );
    const scope = legacyCall ? undefined : (scopeOrSkillsService as SkillSummary["scope"]);
    const enabled = legacyCall ? providerOrEnabled : (enabledOrSkillsService as boolean);
    const skillsService = legacyCall
      ? (scopeOrSkillsService as ISkillsService)
      : maybeSkillsService;
    if (!skillsService) {
      set({ error: "skillsService is required" });
      return;
    }
    try {
      await skillsService.setEnabled({
        workspacePath,
        workspaceIdentity: workspaceIdentityFromState,
        provider,
        ...(scope ? { scope } : {}),
        skillId,
        enabled,
      });
      await get().refresh(skillsService, workspaceIdentityFromState);
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
}));

type SkillStoreE2EBridge = typeof useSkillStore;

declare global {
  interface Window {
    __skillStoreE2E?: SkillStoreE2EBridge;
  }
}

if (shouldExposeE2EStoreBridge()) {
  // E2E 诊断入口必须由 WDIO 显式打开，不能复用 ZCODE_ENV=test，避免产品测试环境暴露可变全局 store。
  window.__skillStoreE2E = useSkillStore;
}
