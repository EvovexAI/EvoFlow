import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWritePrivateTextFile, withFileLock } from "@zcode/shared/node";
import {
  botsConfigFileSchema,
  botsStateFileSchema,
  type BotsConfigFile,
  type BotsStateFile,
} from "@zcode/shared";
import { getAppConfigDir } from "../paths.js";
import {
  BOTS_CONFIG_FILE,
  BOTS_LEGACY_CONFIG_FILE,
  BOTS_LEGACY_STATE_FILE,
  BOTS_V2_STATE_FILE,
  BOTS_STATE_FILE,
  createDefaultBotsConfig,
} from "./config.js";
import { importLegacyBotConfig, importLegacyBotState } from "./storageMigration.js";

async function readOptionalJson(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await atomicWritePrivateTextFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

export class BotsRepo {
  async readConfig(): Promise<BotsConfigFile> {
    const path = join(getAppConfigDir(), BOTS_CONFIG_FILE);
    return withFileLock(path, async () => {
      const current = await readOptionalJson(path);
      // 回滚兼容：v3 已存在就只认 v3；损坏时暴露错误，绝不能恢复旧 Bot 或覆盖用户新修改。
      if (current !== undefined) return botsConfigFileSchema.parse(current);
      const legacy = await readOptionalJson(join(getAppConfigDir(), BOTS_LEGACY_CONFIG_FILE));
      const config = botsConfigFileSchema.parse(
        legacy === undefined ? createDefaultBotsConfig() : importLegacyBotConfig(legacy),
      );
      await writeJson(path, config);
      return config;
    });
  }

  async writeConfig(config: BotsConfigFile): Promise<BotsConfigFile> {
    const parsed = botsConfigFileSchema.parse(config);
    const path = join(getAppConfigDir(), BOTS_CONFIG_FILE);
    await withFileLock(path, () => writeJson(path, parsed));
    return parsed;
  }

  async readState(): Promise<BotsStateFile> {
    const path = join(getAppConfigDir(), BOTS_STATE_FILE);
    return withFileLock(path, async () => {
      const current = await readOptionalJson(path);
      if (current !== undefined) return botsStateFileSchema.parse(current);
      const v2 = await readOptionalJson(join(getAppConfigDir(), BOTS_V2_STATE_FILE));
      const legacy =
        v2 === undefined
          ? await readOptionalJson(join(getAppConfigDir(), BOTS_LEGACY_STATE_FILE))
          : v2;
      const state = botsStateFileSchema.parse(
        legacy === undefined ? { version: 3, bots: {} } : importLegacyBotState(legacy),
      );
      // 在同一文件锁内固定迁移结果；后续登录/套餐变化不再重新解释旧身份。
      await writeJson(path, state);
      return state;
    });
  }

  async writeState(state: BotsStateFile): Promise<BotsStateFile> {
    const parsed = botsStateFileSchema.parse(state);
    const path = join(getAppConfigDir(), BOTS_STATE_FILE);
    await withFileLock(path, () => writeJson(path, parsed));
    return parsed;
  }
}
