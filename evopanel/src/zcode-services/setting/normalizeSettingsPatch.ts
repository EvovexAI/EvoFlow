import type { AppSettings } from "@zcode/shared";

export function normalizeSettingsPatch(patch: Partial<AppSettings>): Partial<AppSettings> {
  const normalizedPatch = { ...patch };

  if (
    "locale" in normalizedPatch &&
    !("localePreference" in normalizedPatch) &&
    typeof normalizedPatch.locale === "string"
  ) {
    // locale 现在只表示已解析后的实际语言，localePreference 才表示用户偏好。
    // 兼容旧调用只写 locale 的路径，把它视为用户显式选择固定语言，避免下一次启动又回到 system。
    normalizedPatch.localePreference = normalizedPatch.locale;
  }

  if (
    "terminalFontFamily" in normalizedPatch &&
    typeof normalizedPatch.terminalFontFamily === "string"
  ) {
    // 终端字体覆盖需要支持清空后回到系统 profile 自动探测。
    // RPC 传输会吞掉 undefined，这里把空串归一成 undefined，避免旧字体一直残留。
    const trimmedTerminalFontFamily = normalizedPatch.terminalFontFamily.trim();
    normalizedPatch.terminalFontFamily =
      trimmedTerminalFontFamily.length > 0 ? trimmedTerminalFontFamily : undefined;
  }

  if ("integratedTerminalShell" in normalizedPatch) {
    const selection = normalizedPatch.integratedTerminalShell;
    if (selection?.mode === "auto") {
      // 设置页的“自动选择”表示移除用户覆盖，让 Bash 执行层继续使用当前平台的自动探测。
      normalizedPatch.integratedTerminalShell = undefined;
    } else if (selection?.mode === "shell") {
      normalizedPatch.integratedTerminalShell = {
        ...selection,
        id: selection.id.trim(),
        label: selection.label.trim(),
        path: selection.path.trim(),
      };
    }
  }

  if ("httpProxy" in normalizedPatch && typeof normalizedPatch.httpProxy === "string") {
    // 清空代理现在表示显式直连，不再回退用户 shell 环境变量。
    // RPC 会吞掉 undefined，这里把空串归一成 undefined，避免旧代理继续留在 setting.json。
    const trimmedHttpProxy = normalizedPatch.httpProxy.trim();
    normalizedPatch.httpProxy = trimmedHttpProxy.length > 0 ? trimmedHttpProxy : undefined;
  }

  if (
    "httpProxyNoProxy" in normalizedPatch &&
    typeof normalizedPatch.httpProxyNoProxy === "string"
  ) {
    // No Proxy 是代理策略的一部分，清空时必须删除旧值，
    // 否则下次启动 agent/renderer 仍会绕过显式代理。
    const trimmedHttpProxyNoProxy = normalizedPatch.httpProxyNoProxy.trim();
    normalizedPatch.httpProxyNoProxy =
      trimmedHttpProxyNoProxy.length > 0 ? trimmedHttpProxyNoProxy : undefined;
  }

  if (
    "httpProxyCaCertPath" in normalizedPatch &&
    typeof normalizedPatch.httpProxyCaCertPath === "string"
  ) {
    // 自定义 CA 必须来自设置页显式路径；清空输入时要删除旧值，
    // 否则重启后 agent 还会继续注入 NODE_EXTRA_CA_CERTS。
    const trimmedHttpProxyCaCertPath = normalizedPatch.httpProxyCaCertPath.trim();
    normalizedPatch.httpProxyCaCertPath =
      trimmedHttpProxyCaCertPath.length > 0 ? trimmedHttpProxyCaCertPath : undefined;
  }

  if (
    "zcodeEndpointOrigin" in normalizedPatch &&
    typeof normalizedPatch.zcodeEndpointOrigin === "string"
  ) {
    // 非生产 endpoint override 需要支持 Reset 清空；RPC/JSON 对 undefined 不稳定时，用空串也能回到默认生产域。
    const trimmedZCodeEndpointOrigin = normalizedPatch.zcodeEndpointOrigin.trim();
    normalizedPatch.zcodeEndpointOrigin =
      trimmedZCodeEndpointOrigin.length > 0 ? trimmedZCodeEndpointOrigin : undefined;
  }

  if (
    "providerFamilyDomain" in normalizedPatch &&
    typeof normalizedPatch.providerFamilyDomain === "string"
  ) {
    // 退出/解绑当前 provider family 时需要清空运行域。
    // RPC 传输会吞掉 undefined，这里把空串归一成 undefined，避免旧选择继续影响 registry 过滤。
    const trimmedProviderFamilyDomain = normalizedPatch.providerFamilyDomain.trim();
    normalizedPatch.providerFamilyDomain =
      trimmedProviderFamilyDomain.length > 0 ? normalizedPatch.providerFamilyDomain : undefined;
  }

  return normalizedPatch;
}
