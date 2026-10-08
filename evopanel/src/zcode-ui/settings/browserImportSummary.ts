import type { ChromeBrowserDataImportResult } from "@zcode/shared";
import type { useZCodeIntl } from "@/i18n/IntlProvider.js";

export function formatImportSummary(
  result: ChromeBrowserDataImportResult,
  formatMessage: ReturnType<typeof useZCodeIntl>["intl"]["formatMessage"],
): string {
  if (!result.success) {
    const errorMessageId =
      result.error === "chrome_profile_not_found" ||
      result.error === "chrome_default_profile_not_found"
        ? "settings.browser.import.notFound"
        : result.error === "chrome_profile_ambiguous"
          ? "settings.browser.import.ambiguous"
          : result.error === "chrome_executable_not_found"
            ? "settings.browser.import.executableNotFound"
            : result.error === "chrome_cookie_access_denied"
              ? "settings.browser.import.accessDenied"
              : result.error === "chrome_cookie_elevation_required"
                ? "settings.browser.import.elevationRequired"
                : result.error === "chrome_cookie_elevation_cancelled"
                  ? "settings.browser.import.elevationCancelled"
                  : result.error === "chrome_cookie_helper_verification_failed"
                    ? "settings.browser.import.helperVerificationFailed"
                    : result.error === "chrome_cookie_app_bound_decryption_failed"
                      ? "settings.browser.import.appBoundFailed"
                      : result.error === "chrome_cookie_protection_unsupported"
                        ? "settings.browser.import.cookieProtected"
                        : result.error === "chrome_profile_locked"
                          ? "settings.browser.import.profileLocked"
                          : result.error === "chrome_local_storage_import_failed"
                            ? "settings.browser.import.localStorageFailed"
                            : "settings.browser.import.failed";
    return formatMessage({ id: errorMessageId });
  }
  const values = {
    cookies: String(result.cookies.imported),
    origins: String(result.localStorage.originsImported),
    entries: String(result.localStorage.entriesImported),
    skipped: String(result.cookies.skipped),
  };
  if (
    result.issues?.some((issue) =>
      [
        "chrome_cookie_elevation_required",
        "chrome_cookie_elevation_cancelled",
        "chrome_cookie_helper_verification_failed",
        "chrome_cookie_app_bound_decryption_failed",
      ].includes(issue),
    )
  ) {
    return formatMessage({ id: "settings.browser.import.partialAppBound" }, values);
  }
  // Rebase 后的产品语义要求成功态只展示实际导入数量；普通 skipped/failed 详情留在安全日志。
  // App-Bound 授权/校验失败是用户刚刚显式确认的动作，单独保留部分成功提示，避免误以为 Cookie 已导入。
  return formatMessage({ id: "settings.browser.import.success" }, values);
}
