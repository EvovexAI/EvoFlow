import { normalizeUnknownError } from "./errors.js";

export const DATA_BASE_DIR_FORBIDDEN_WINDOWS_INSTALL_DIR_ERROR_CODE =
  "DATA_BASE_DIR_FORBIDDEN_WINDOWS_INSTALL_DIR";

export function isDataBaseDirForbiddenWindowsInstallDirError(error: unknown): boolean {
  const normalized = normalizeUnknownError(error);
  return (
    normalized.code === DATA_BASE_DIR_FORBIDDEN_WINDOWS_INSTALL_DIR_ERROR_CODE ||
    normalized.message.includes(DATA_BASE_DIR_FORBIDDEN_WINDOWS_INSTALL_DIR_ERROR_CODE)
  );
}
