export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const proxy =
      process.env.https_proxy ||
      process.env.HTTPS_PROXY ||
      process.env.http_proxy ||
      process.env.HTTP_PROXY;

    if (proxy) {
      const { setGlobalDispatcher, ProxyAgent } = await import("undici");
      setGlobalDispatcher(new ProxyAgent(proxy));
      console.log(`[proxy] Global fetch dispatcher set → ${proxy}`);
    }
  }
}
