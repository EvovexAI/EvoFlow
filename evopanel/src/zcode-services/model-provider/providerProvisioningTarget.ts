/* eslint-disable max-lines -- Provisioning target keeps transaction and rollback invariants together. */
import { readFile } from "node:fs/promises";
import { atomicWritePrivateTextFile, withFileLock } from "@zcode/shared/node";
import {
  type PersonalProviderConfigRepository,
  type ProviderConfigLayerUpdate,
} from "@zcode/provider";
import { decodeProviderConfigFile, encodeProviderConfigFile } from "@zcode/provider-node";
import {
  providerProvisioningEnvelopeSchema,
  providerProvisioningResultSchema,
  isProviderProvisioningAccountCredentialKey,
  type ProviderProvisioningEnvelope,
  type ProviderProvisioningResult,
} from "@zcode/shared";
import type { ICredentialService } from "../credential/credential.js";
import type { ISettingService } from "../setting/setting.js";
import type { ProviderRuntime } from "./providerRuntime.js";
import type { AccountProviderService } from "@zcode/provider";
import type { IProviderProvisioningTargetService } from "./providerProvisioning.js";
import {
  PROVIDER_PROVISIONING_OAUTH_CREDENTIAL_KEYS,
  readProvisionablePersonalConfig,
} from "./providerProvisioningSource.js";

const PROVISIONING_SCHEMA_VERSION = 1 as const;

const OAUTH_CREDENTIAL_KEYS = new Set<string>(PROVIDER_PROVISIONING_OAUTH_CREDENTIAL_KEYS);

export interface ProviderProvisioningTargetOptions {
  readonly providerRuntime: ProviderRuntime;
  readonly personalRepository: PersonalProviderConfigRepository;
  readonly accountProviderSource: AccountProviderService;
  readonly credentialService: ICredentialService;
  readonly settingService: ISettingService;
  readonly personalConfigFilePath: string;
  readonly stateFilePath: string;
  readonly listProvisioningCredentialKeys?: () => Promise<readonly string[]>;
}

interface ProvisioningStateRecord {
  readonly syncId: string;
  readonly result: ProviderProvisioningResult;
}

interface ProvisioningStateFile {
  readonly schemaVersion: typeof PROVISIONING_SCHEMA_VERSION;
  readonly records: readonly ProvisioningStateRecord[];
}

/** 运行在目标 Environment 内的 Provisioning target；负责写正式 Store 并在失败时回滚。 */
export function createProviderProvisioningTarget(
  options: ProviderProvisioningTargetOptions,
): IProviderProvisioningTargetService {
  return {
    async apply(input: ProviderProvisioningEnvelope): Promise<ProviderProvisioningResult> {
      const envelope = providerProvisioningEnvelopeSchema.parse(input);
      return withFileLock(options.stateFilePath, async () => {
        const previousState = await readStateFile(options.stateFilePath);
        const previousResult = previousState?.records.find(
          (record) => record.syncId === envelope.syncId,
        );
        if (previousResult) {
          return {
            ...previousResult.result,
            status: "already-applied",
          } satisfies ProviderProvisioningResult;
        }

        validateCredentialEntries(envelope);
        await options.providerRuntime.start();
        const before = await captureBeforeState(envelope, options);
        const personalUpdate = parsePersonalConfig(envelope);
        const applied: AppliedProvisioningState = {
          settings: false,
          settingsExpected: envelope.accountSettings,
          credentials: [],
          personalConfig: false,
          personalConfigExpected: personalUpdate,
        };

        try {
          // 先登记再写入：底层原子写即使在替换完成后才抛错，也必须进入回滚集合。
          applied.settings = true;
          await options.settingService.update({
            providerFamilyDomain: envelope.accountSettings.providerFamilyDomain ?? undefined,
            providerFamilyConnectionSelections:
              envelope.accountSettings.providerFamilyConnectionSelections,
          });

          const incomingCredentials = new Map(
            envelope.credentials.map((credential) => [credential.key, credential.value]),
          );
          for (const key of before.credentials.keys()) {
            const value = incomingCredentials.get(key);
            applied.credentials.push({ key, value: value ?? null });
            if (value === undefined) await options.credentialService.delete(key);
            else await options.credentialService.save(key, value);
          }

          applied.personalConfig = true;
          await options.personalRepository.update((current) => {
            // 其他域写入期间 Personal 可能已被编辑；检查与替换必须在同一个文件锁内。
            if (!samePersonalConfig(current, before.personal)) {
              throw new Error("Personal Provider Config 在同步期间被其它操作修改");
            }
            return personalUpdate;
          });

          await options.accountProviderSource.refresh("provider-provisioning");
          const snapshot =
            await options.providerRuntime.registryService.refresh("provider-provisioning");
          if (
            personalUpdate.defaultModelSelection &&
            !options.providerRuntime.registryService.validateSelection(
              personalUpdate.defaultModelSelection,
            ).ok
          ) {
            throw new Error("同步后的远端 Registry 不支持本地默认模型");
          }

          const result = {
            syncId: envelope.syncId,
            status: "applied" as const,
            personalProviderCount: personalUpdate.providers.keys().length,
            credentialCount: envelope.credentials.length,
            configRevision: snapshot.sourceRevisions.config,
            rolledBack: false,
          } satisfies ProviderProvisioningResult;
          await writeStateFile(options.stateFilePath, appendStateRecord(previousState, result));
          return result;
        } catch (error) {
          // 回滚前对每个 domain 做 CAS 式校验；若期间已有其它写入，宁可报告
          // rollback_failed，也不能用过期快照覆盖或删除用户的新配置。
          const rollbackError = await rollback(before, applied, options);
          if (rollbackError) {
            return {
              syncId: envelope.syncId,
              status: "rollback_failed",
              personalProviderCount: before.personal.providers.keys().length,
              credentialCount: envelope.credentials.length,
              errorMessage: `${formatError(error)}；回滚失败：${formatError(rollbackError)}`,
              rolledBack: false,
            } satisfies ProviderProvisioningResult;
          }
          return {
            syncId: envelope.syncId,
            status: "failed",
            personalProviderCount: before.personal.providers.keys().length,
            credentialCount: envelope.credentials.length,
            errorMessage: formatError(error),
            rolledBack: true,
          } satisfies ProviderProvisioningResult;
        }
      });
    },
  };
}

interface BeforeState {
  readonly personal: ProviderConfigLayerUpdate;
  readonly settings: Awaited<ReturnType<ISettingService["get"]>>;
  readonly credentials: ReadonlyMap<string, string | null>;
}

interface AppliedProvisioningState {
  settings: boolean;
  settingsExpected: ProviderProvisioningEnvelope["accountSettings"];
  credentials: Array<{ key: string; value: string | null }>;
  personalConfig: boolean;
  personalConfigExpected: ProviderConfigLayerUpdate;
}

function parsePersonalConfig(envelope: ProviderProvisioningEnvelope): ProviderConfigLayerUpdate {
  // 信封与本地保存复用正式 Personal codec，不在接收端另建字段清单或模式判断。
  return decodeProviderConfigFile({ schemaVersion: 1, config: envelope.personalConfig });
}

async function captureBeforeState(
  envelope: ProviderProvisioningEnvelope,
  options: ProviderProvisioningTargetOptions,
): Promise<BeforeState> {
  const [personal, settings] = await Promise.all([
    readProvisionablePersonalConfig(options.personalRepository, options.personalConfigFilePath),
    options.settingService.get(),
  ]);
  const credentials = new Map<string, string | null>();
  const credentialKeys = new Set<string>([
    ...OAUTH_CREDENTIAL_KEYS,
    ...((await options.listProvisioningCredentialKeys?.()) ?? []),
    ...envelope.credentials.map((entry) => entry.key),
  ]);
  for (const key of credentialKeys) {
    if (!OAUTH_CREDENTIAL_KEYS.has(key) && !isProviderProvisioningAccountCredentialKey(key)) {
      continue;
    }
    credentials.set(key, await options.credentialService.load(key));
  }
  return {
    personal,
    settings,
    credentials,
  };
}

async function rollback(
  before: BeforeState,
  applied: AppliedProvisioningState,
  options: ProviderProvisioningTargetOptions,
): Promise<Error | undefined> {
  const errors: unknown[] = [];
  if (applied.personalConfig) {
    try {
      await options.personalRepository.update((current) => {
        if (samePersonalConfig(current, before.personal)) return current;
        if (!samePersonalConfig(current, applied.personalConfigExpected)) {
          throw new Error("Personal Provider Config 在同步期间被其它操作修改，跳过回滚");
        }
        // 默认选择与 Provider/Model 共用一份 CAS；不能分别回滚制造混合状态或覆盖新选择。
        return before.personal;
      });
    } catch (error) {
      errors.push(error);
    }
  }
  for (const { key, value } of applied.credentials) {
    try {
      const previous = before.credentials.get(key) ?? null;
      const current = await options.credentialService.load(key);
      if (current === previous) {
        continue;
      }
      if (current !== value) {
        errors.push(new Error(`Credential ${key} 在同步期间被其它操作修改，跳过回滚`));
        continue;
      }
      if (previous === null) {
        await options.credentialService.delete(key);
      } else {
        await options.credentialService.save(key, previous);
      }
    } catch (error) {
      errors.push(error);
    }
  }
  if (applied.settings) {
    try {
      const current = await options.settingService.get();
      const previousSettings = toProvisioningAccountSettings(before.settings);
      if (sameAccountSettings(current, previousSettings)) {
        // 写入失败发生在落盘前，目标已经处于回滚前的状态。
      } else if (!sameAccountSettings(current, applied.settingsExpected)) {
        errors.push(new Error("Account Settings 在同步期间被其它操作修改，跳过回滚"));
      } else {
        await options.settingService.update({
          providerFamilyDomain: before.settings.providerFamilyDomain,
          providerFamilyConnectionSelections: before.settings.providerFamilyConnectionSelections,
        });
      }
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    return new Error(errors.map(formatError).join("；"));
  }
  try {
    await options.accountProviderSource.refresh("provider-provisioning-rollback");
    await options.providerRuntime.registryService.refresh("provider-provisioning-rollback");
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  return undefined;
}

function samePersonalConfig(
  left: ProviderConfigLayerUpdate,
  right: ProviderConfigLayerUpdate,
): boolean {
  return (
    JSON.stringify(encodeProviderConfigFile(left)) ===
    JSON.stringify(encodeProviderConfigFile(right))
  );
}

function toProvisioningAccountSettings(
  settings: Awaited<ReturnType<ISettingService["get"]>>,
): ProviderProvisioningEnvelope["accountSettings"] {
  return {
    providerFamilyDomain: settings.providerFamilyDomain ?? null,
    providerFamilyConnectionSelections: settings.providerFamilyConnectionSelections ?? {},
  };
}

function sameAccountSettings(
  current: Awaited<ReturnType<ISettingService["get"]>>,
  expected: ProviderProvisioningEnvelope["accountSettings"],
): boolean {
  return JSON.stringify(toProvisioningAccountSettings(current)) === JSON.stringify(expected);
}

function validateCredentialEntries(envelope: ProviderProvisioningEnvelope): void {
  const seen = new Set<string>();
  for (const entry of envelope.credentials) {
    if (seen.has(entry.key)) throw new Error(`重复 Provisioning Credential key: ${entry.key}`);
    seen.add(entry.key);
    const allowed =
      (entry.scope === "oauth-session" && OAUTH_CREDENTIAL_KEYS.has(entry.key)) ||
      (entry.scope === "account-provider" && isProviderProvisioningAccountCredentialKey(entry.key));
    if (!allowed) throw new Error(`不允许同步的 Credential key: ${entry.key}`);
  }
}

async function readStateFile(filePath: string): Promise<ProvisioningStateFile | null> {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
    if (parsed.schemaVersion !== PROVISIONING_SCHEMA_VERSION) {
      return null;
    }
    const rawRecords = Array.isArray(parsed.records)
      ? parsed.records
      : parsed.syncId && parsed.result
        ? [{ syncId: parsed.syncId, result: parsed.result }]
        : [];
    const records = rawRecords.flatMap((record) => {
      if (typeof record !== "object" || record === null) return [];
      const candidate = record as Record<string, unknown>;
      if (typeof candidate.syncId !== "string" || !candidate.syncId.trim()) return [];
      const result = providerProvisioningResultSchema.safeParse(candidate.result);
      return result.success ? [{ syncId: candidate.syncId, result: result.data }] : [];
    });
    return { schemaVersion: PROVISIONING_SCHEMA_VERSION, records };
  } catch (error) {
    if (isFileNotFound(error)) return null;
    return null;
  }
}

function appendStateRecord(
  previousState: ProvisioningStateFile | null,
  result: ProviderProvisioningResult,
): ProvisioningStateFile {
  const records = [
    ...(previousState?.records ?? []).filter((record) => record.syncId !== result.syncId),
    { syncId: result.syncId, result },
  ];
  return {
    schemaVersion: PROVISIONING_SCHEMA_VERSION,
    records,
  };
}

function writeStateFile(filePath: string, state: ProvisioningStateFile): Promise<void> {
  return atomicWritePrivateTextFile(filePath, `${JSON.stringify(state, null, 2)}\n`);
}

function isFileNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
