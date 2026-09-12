/** Hash route: #/bench/dual-session-perf — dual-session switch DOM bench, no Gateway. */
export async function render() {
  const { mountBenchDualSessionPerf } = await import('../react/bench-dual-session-perf.tsx')
  const host = document.createElement('div')
  host.style.height = '100%'
  host.style.width = '100%'
  mountBenchDualSessionPerf(host)
  return host
}
