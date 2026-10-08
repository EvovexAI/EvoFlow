export function useRemoteConnectionEntryVisibility(): boolean {
  // SSH 入口之前复用了 internal-only gate，生产态外网环境会被一并隐藏。
  // 但 SSH 是否可用取决于目标机器、网络链路和凭据，不应该依赖“当前客户端是否在内网”。
  // 远程连接是通用 SSH 能力，不应被已退役产品的内网策略门禁。
  return true;
}
