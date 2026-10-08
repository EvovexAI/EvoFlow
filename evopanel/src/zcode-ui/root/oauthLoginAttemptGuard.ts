/** 同一轮登录已经成功或正在完成成功回调时，忽略另一条路径的迟到失败。 */
export function shouldApplyOAuthPollingFailure(
  loginSucceeded: boolean,
  loginSuccessInFlight = false,
): boolean {
  return !loginSucceeded && !loginSuccessInFlight;
}
