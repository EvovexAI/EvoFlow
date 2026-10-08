import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ZCodeStdioTapDevState } from "@zcode/shared";
import { getAppConfigDir } from "#src/paths.js";
import { isEffectiveDevelopmentNodeEnv } from "#src/runtime-tools/nodeEnv.js";

interface ZCodeStdioTapStateFile {
  enabled?: boolean;
}

function isZCodeStdioTapDevVisible(): boolean {
  return isEffectiveDevelopmentNodeEnv();
}

function getZCodeStdioTapDevDir(): string {
  return join(getAppConfigDir(), "dev");
}

export function getZCodeStdioTapDevLogDir(): string {
  return join(getZCodeStdioTapDevDir(), "stdio-traffic");
}

function getZCodeStdioTapDevStatePath(): string {
  return join(getZCodeStdioTapDevDir(), "zcode-stdio-tap.json");
}

function readStateFile(path: string): ZCodeStdioTapStateFile {
  if (!existsSync(path)) {
    return {};
  }

  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as ZCodeStdioTapStateFile) : {};
  } catch {
    return {};
  }
}

export function readZCodeStdioTapDevState(): ZCodeStdioTapDevState {
  const visible = isZCodeStdioTapDevVisible();
  const statePath = getZCodeStdioTapDevStatePath();
  const fileState = readStateFile(statePath);
  return {
    enabled: visible && fileState.enabled === true,
    visible,
    logDir: getZCodeStdioTapDevLogDir(),
    statePath,
  };
}

export function setZCodeStdioTapDevEnabled(enabled: boolean): ZCodeStdioTapDevState {
  const visible = isZCodeStdioTapDevVisible();
  const statePath = getZCodeStdioTapDevStatePath();
  mkdirSync(getZCodeStdioTapDevDir(), { recursive: true });
  writeFileSync(
    statePath,
    `${JSON.stringify(
      {
        // 开发态 stdio 抓包是高频原始协议帧，只能通过显式开关写旁路文件，避免误进生产日志。
        enabled: visible && enabled,
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
  return readZCodeStdioTapDevState();
}
