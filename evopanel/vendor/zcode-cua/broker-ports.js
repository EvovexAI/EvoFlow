export function isCuaPermissionStatusAvailable(result) {
  return Boolean(result) && typeof result === "object" && result.available === true;
}

export function shouldRunCuaScreenCaptureProbe(_state, _options) {
  return false;
}
