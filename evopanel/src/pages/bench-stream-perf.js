/** Hash route: #/bench/stream-perf — real DOM stream bench, no Gateway. */
export async function render() {
  const { mountBenchStreamPerf } = await import('../react/bench-stream-perf.tsx')
  const host = document.createElement('div')
  host.style.height = '100%'
  host.style.width = '100%'
  mountBenchStreamPerf(host)
  return host
}
