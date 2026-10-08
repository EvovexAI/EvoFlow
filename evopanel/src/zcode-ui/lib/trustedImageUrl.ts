/** UI 远端图片只允许 HTTPS；失败时由各展示组件回退到本地图标。 */
export function isTrustedImageUrl(url: string | undefined): url is string {
  return typeof url === "string" && url.startsWith("https://");
}
