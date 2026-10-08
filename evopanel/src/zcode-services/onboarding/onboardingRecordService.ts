import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  onboardingDecisionSchema,
  onboardingRecordEntrySchema,
  onboardingRecordFileSchema,
} from "@zcode/shared";
import { appSettingsOccupationEnum } from "@zcode/shared";
import type {
  OnboardingRecordEntry,
  OnboardingRecordEntryInput,
  OnboardingRecordFile,
} from "@zcode/shared";
import { atomicWriteText } from "../fs/atomicFileUtils.js";
import { getAppConfigDir } from "../paths.js";
import { createServiceLogger } from "../logger/serviceLogger.js";
import type {
  CreateOnboardingRecordServiceOptions,
  IOnboardingRecordService,
  OnboardingSettingsSyncPatch,
} from "./onboardingRecord.js";

const logger = createServiceLogger("onboardingRecordService");

function getRecordFile(): string {
  // 记录是设备级数据，必须跟随 dataBaseDir（用户自定义数据目录时落在其 .zcode/v2 下，
  // 与 telemetry-state.json 一致），不能学 setting.json 固定写 home——setting.json 留在 home
  // 只是启动引导需要固定位置读取 dataBaseDir，不代表其他设备数据的落点。
  return join(getAppConfigDir(), "onboarding-record.json");
}

/**
 * 读取记录文件；文件不存在返回 null，内容损坏（手改/写坏）时同样返回 null 并 warn——
 * 损坏文件等价于"从未记录"，重新触发引导后在下次 append 时重建。
 */
async function readRecordFile(filePath: string): Promise<OnboardingRecordFile | null> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return null;
    logger.warn(undefined, "read onboarding record failed:", err);
    return null;
  }
  try {
    return onboardingRecordFileSchema.parse(JSON.parse(raw));
  } catch (cause) {
    logger.warn(undefined, "invalid onboarding record json, treating as missing. error:", cause);
    return null;
  }
}

export function createOnboardingRecordService(
  options: CreateOnboardingRecordServiceOptions,
): IOnboardingRecordService {
  // 串行化写：引导保存与并发触发判定同时发生时不丢条目。
  let writeQueue: Promise<unknown> = Promise.resolve();
  const enqueueWrite = <T>(task: () => Promise<T>): Promise<T> => {
    const queued = writeQueue.then(task, task) as Promise<T>;
    writeQueue = queued.catch(() => {});
    return queued;
  };
  const createFile = (deviceMid: string): OnboardingRecordFile => ({
    version: 2,
    deviceMid,
    entries: [],
    decisions: [],
  });
  const hasIdentityRecord = (file: OnboardingRecordFile, userId: string | null): boolean =>
    file.entries.some((entry) => entry.userId === userId) ||
    file.decisions.some((decision) => decision.userId === userId);

  return {
    async appendRecord(deviceMid: string, entry: OnboardingRecordEntryInput): Promise<void> {
      const userId = await options.loadUserId();
      await enqueueWrite(async () => {
        const filePath = getRecordFile();
        const existing = await readRecordFile(filePath);
        // deviceMid 以文件内已有值为权威：本地文件不变是设备关联的前提，
        // 调用方传入不同值只说明异常（如 getDeviceId 行为变化），记录并沿用旧值。
        let file: OnboardingRecordFile;
        if (existing) {
          if (existing.deviceMid !== deviceMid) {
            logger.warn(
              undefined,
              "deviceMid mismatch, keep existing:",
              existing.deviceMid,
              "incoming:",
              deviceMid,
            );
          }
          file = existing;
        } else {
          file = createFile(deviceMid);
        }
        const record: OnboardingRecordEntry = {
          userId,
          ...entry,
          uploadState: "pending",
        };
        // 每 userId（含 null）至多一条：同一用户重复完成引导（debug 重置后再答等）覆盖旧条目，
        // 而不是追加——覆盖后的新答案重新置 pending，等待上传。
        const previousIndex = file.entries.findIndex((item) => item.userId === userId);
        const validated = onboardingRecordEntrySchema.parse(record);
        if (previousIndex >= 0) file.entries[previousIndex] = validated;
        else file.entries.push(validated);
        file.decisions = file.decisions.filter((decision) => decision.userId !== userId);
        await mkdir(join(filePath, ".."), { recursive: true });
        await atomicWriteText(filePath, JSON.stringify(file, null, 2));
      });
    },

    async claimAnonymousRecord(): Promise<void> {
      const userId = await options.loadUserId();
      if (!userId) return;
      await enqueueWrite(async () => {
        const filePath = getRecordFile();
        const file = await readRecordFile(filePath);
        if (!file) return;
        if (hasIdentityRecord(file, userId)) return;
        // 兼容旧版重复文件取最后一条 null；移交是改写，不保留匿名副本。
        for (let i = file.entries.length - 1; i >= 0; i -= 1) {
          if (file.entries[i]!.userId === null) {
            file.entries[i] = onboardingRecordEntrySchema.parse({
              ...file.entries[i]!,
              userId,
            });
            await atomicWriteText(filePath, JSON.stringify(file, null, 2));
            return;
          }
        }
        for (let i = file.decisions.length - 1; i >= 0; i -= 1) {
          if (file.decisions[i]!.userId !== null) continue;
          file.decisions[i] = onboardingDecisionSchema.parse({ ...file.decisions[i]!, userId });
          await atomicWriteText(filePath, JSON.stringify(file, null, 2));
          return;
        }
      });
    },

    async shouldOnboard(deviceMid: string): Promise<boolean> {
      const userId = await options.loadUserId();
      const file = await readRecordFile(getRecordFile());
      if (file && hasIdentityRecord(file, userId)) return false;
      if (!(await options.hasExistingLocalTask())) return true;
      await enqueueWrite(async () => {
        const filePath = getRecordFile();
        const current = (await readRecordFile(filePath)) ?? createFile(deviceMid);
        if (hasIdentityRecord(current, userId)) return;
        current.decisions.push(
          onboardingDecisionSchema.parse({
            userId,
            status: "existing_local_user",
            reason: "existing_local_task",
            decidedAt: new Date().toISOString(),
          }),
        );
        await mkdir(join(filePath, ".."), { recursive: true });
        await atomicWriteText(filePath, JSON.stringify(current, null, 2));
      });
      return false;
    },

    async dismissOnboarding(deviceMid: string): Promise<void> {
      const userId = await options.loadUserId();
      await enqueueWrite(async () => {
        const filePath = getRecordFile();
        const file = (await readRecordFile(filePath)) ?? createFile(deviceMid);
        if (file.entries.some((entry) => entry.userId === userId)) return;
        const decision = onboardingDecisionSchema.parse({
          userId,
          status: "dismissed",
          reason: "user_closed",
          decidedAt: new Date().toISOString(),
        });
        const index = file.decisions.findIndex((item) => item.userId === userId);
        if (index >= 0) file.decisions[index] = decision;
        else file.decisions.push(decision);
        await mkdir(join(filePath, ".."), { recursive: true });
        await atomicWriteText(filePath, JSON.stringify(file, null, 2));
      });
    },

    async getLatestEntry(): Promise<OnboardingRecordEntry | null> {
      const userId = await options.loadUserId();
      const file = await readRecordFile(getRecordFile());
      if (!file) return null;
      let latest: OnboardingRecordEntry | undefined;
      for (const entry of file.entries) {
        if (entry.userId === userId) latest = entry;
      }
      return latest ?? null;
    },

    async syncSettingsFromRecord(): Promise<OnboardingSettingsSyncPatch | null> {
      const userId = await options.loadUserId();
      const file = await readRecordFile(getRecordFile());
      if (!file) return null;
      // append 是覆盖语义，正常每 userId 至多一条；兼容旧版本的重复追加文件时取最后一条。
      let latest: OnboardingRecordEntry | undefined;
      for (const entry of file.entries) {
        if (entry.userId === userId) latest = entry;
      }
      if (!latest) return null;
      // 跳过页记 null：回填保守默认，与引导跳过写 settings 的行为一致（职业 other、偏好关）。
      // record 的 occupation 是非枚举字符串（职业列表会演进），窄化到 settings 的枚举；
      // 旧版本可能落过已收窄/未知的职业值，未知值回填 other，与推荐池的兜底一致。
      const occupation = appSettingsOccupationEnum.safeParse(latest.occupation);
      return {
        onboardingOccupation: (occupation.success ? occupation.data : null) ?? "other",
        proactiveSuggestionsEnabled: latest.proactiveSuggestionsEnabled ?? false,
        memoryEnabled: latest.memoryEnabled ?? false,
      };
    },

    async updateRecordPreferences(
      patch: Partial<
        Pick<OnboardingRecordEntryInput, "memoryEnabled" | "proactiveSuggestionsEnabled">
      >,
    ): Promise<void> {
      const userId = await options.loadUserId();
      await enqueueWrite(async () => {
        const filePath = getRecordFile();
        const file = await readRecordFile(filePath);
        if (!file) return;
        const index = file.entries.findLastIndex((entry) => entry.userId === userId);
        if (index < 0) return;
        file.entries[index] = onboardingRecordEntrySchema.parse({
          ...file.entries[index],
          ...patch,
        });
        await atomicWriteText(filePath, JSON.stringify(file, null, 2));
      });
    },

    async getRecords(): Promise<OnboardingRecordFile | null> {
      return readRecordFile(getRecordFile());
    },

    async clearRecords(): Promise<void> {
      await enqueueWrite(async () => {
        await rm(getRecordFile(), { force: true });
      });
    },
  };
}
