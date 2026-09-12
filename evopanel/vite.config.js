import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { devApiPlugin } from './scripts/dev-api.js'
import fs from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const reactSrcDir = path.resolve(__dirname, 'src/react')
const sanitizeUrlShim = path.resolve(__dirname, 'src/lib/shims/sanitize-url.mjs')

/** pnpm folder prefix: `@scope/pkg` → `@scope+pkg@` */
function pnpmFolderPrefix(pkgName) {
  return `${String(pkgName).replace('/', '+')}@`
}

/** Resolve a package entry under pnpm (flat node_modules/ pkg may be absent). */
function resolvePnpmPackage(pkgName, entry = 'package.json') {
  const flat = path.resolve(__dirname, 'node_modules', pkgName, entry)
  if (fs.existsSync(flat)) return flat

  const pnpmRoot = path.resolve(__dirname, 'node_modules/.pnpm')
  if (!fs.existsSync(pnpmRoot)) {
    throw new Error(`[vite] node_modules/.pnpm missing; run pnpm install in evopanel`)
  }
  const prefix = pnpmFolderPrefix(pkgName)
  const matches = fs.readdirSync(pnpmRoot).filter((name) => name.startsWith(prefix))
  if (!matches.length) {
    throw new Error(`[vite] Cannot resolve ${pkgName}; not found in .pnpm store`)
  }
  matches.sort()
  const folder = matches[matches.length - 1]
  const resolved = path.resolve(pnpmRoot, folder, 'node_modules', pkgName, entry)
  if (!fs.existsSync(resolved)) {
    throw new Error(`[vite] ${pkgName} entry missing: ${resolved}`)
  }
  return resolved
}

const braintreeSanitizeUrlDist = resolvePnpmPackage('@braintree/sanitize-url', 'dist/index.js')
const dayjsEsmIndex = resolvePnpmPackage('dayjs', 'esm/index.js')
const dayjsEsmDir = path.dirname(dayjsEsmIndex).replace(/\\/g, '/')
// Read package.json version for build injection
const pkg = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8'))

function normalizeGatewayUrl(raw) {
  const value = String(raw || '').trim().replace(/\/+$/, '')
  return value || null
}

function resolveGatewayProxyTarget(env) {
  const explicit = normalizeGatewayUrl(env.EVOFLOW_GATEWAY_URL || process.env.EVOFLOW_GATEWAY_URL)
  if (explicit) return explicit
  const port = parseInt(
    String(env.EVOFLOW_GATEWAY_PORT || process.env.EVOFLOW_GATEWAY_PORT || '').trim(),
    10,
  )
  if (Number.isFinite(port) && port > 0 && port < 65536) {
    return `http://127.0.0.1:${port}`
  }
  // Packaged / default sidecar range starts at 8012. Isolated stack sets EVOFLOW_GATEWAY_* (or .env) to 8070.
  return 'http://127.0.0.1:8012'
}

export default defineConfig(({ mode }) => {
  // Load all env keys (not only VITE_*) so EVOFLOW_GATEWAY_* in .env drives the /api proxy.
  const fileEnv = loadEnv(mode, __dirname, '')
  const gatewayProxyTarget = resolveGatewayProxyTarget(fileEnv)
  const gatewayProxyTimeoutMs = 15000

  const _evoVitePort = parseInt(
    String(fileEnv.EVOFLOW_VITE_PORT || process.env.EVOFLOW_VITE_PORT || '').trim(),
    10,
  )
  const viteDevPort = Number.isFinite(_evoVitePort) && _evoVitePort > 0 ? _evoVitePort : 1421
  const viteStrictPort = Number.isFinite(_evoVitePort) && _evoVitePort > 0
  // Tauri dev health-check on Windows: bind/check 127.0.0.1 (localhost may resolve to ::1).
  const _evoViteHost = String(fileEnv.EVOFLOW_VITE_HOST || process.env.EVOFLOW_VITE_HOST || '').trim()
  const viteDevHost = _evoViteHost || (viteStrictPort ? '0.0.0.0' : true)

  // Auto-follow redirects in proxy to avoid CORS from backend 301/302; surface clear errors when Gateway is down
  function configureGatewayProxy(proxy) {
    proxy.on('proxyRes', (proxyRes, req, res) => {
      if ([301, 302, 303, 307, 308].includes(proxyRes.statusCode)) {
        const location = proxyRes.headers.location
        if (location && location.startsWith('http')) {
          try {
            const urlObj = new URL(location)
            // Rewrite absolute URL to relative path so browser stays on proxy
            proxyRes.headers.location = urlObj.pathname + urlObj.search
          } catch { /* ignore */ }
        }
      }
    })
    proxy.on('error', (err, req, res) => {
      const code = err && (err.code || err.message || String(err))
      // During desktop cold start Gateway may take a few seconds; don't spam the
      // console with ECONNREFUSED on every /api probe (Tauri still uses invoke).
      const now = Date.now()
      if (!configureGatewayProxy._lastLogAt) configureGatewayProxy._lastLogAt = 0
      if (!configureGatewayProxy._suppressed) configureGatewayProxy._suppressed = 0
      if (now - configureGatewayProxy._lastLogAt > 5000) {
        const extra =
          configureGatewayProxy._suppressed > 0
            ? ` (+${configureGatewayProxy._suppressed} similar)`
            : ''
        console.warn(
          `[vite] /api proxy → ${gatewayProxyTarget} warming/unreachable: ${code}${extra}` +
            ' (HTTP :8070 still required for Gateway; stdio is only the app-server RPC pipe)',
        )
        configureGatewayProxy._lastLogAt = now
        configureGatewayProxy._suppressed = 0
      } else {
        configureGatewayProxy._suppressed += 1
      }
      if (res && typeof res.writeHead === 'function' && !res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(
          JSON.stringify({
            detail: `Gateway warming at ${gatewayProxyTarget} (${code})`,
            retry_after_ms: 500,
          }),
        )
      }
    })
  }

  return {
    // Keep Vite cache outside node_modules: on Windows, concurrent Tauri cargo build +
    // beforeDevCommand can lock node_modules/.vite/deps_temp_* (Access denied on *.map).
    cacheDir: path.resolve(__dirname, '.vite-cache'),
    plugins: [react(), tailwindcss(), devApiPlugin()],
    worker: {
      format: 'es',
    },
    resolve: {
      alias: [
        { find: '@', replacement: reactSrcDir },
        // `@braintree/sanitize-url` ships CJS only; shim re-exports named ESM for Mermaid.
        { find: /^@braintree\/sanitize-url$/, replacement: sanitizeUrlShim },
        { find: 'braintree-sanitize-url-dist', replacement: braintreeSanitizeUrlDist },
        // @mermaid-js/parser has broken package.json exports field.
        // Force direct path to avoid resolver failure.
        {
          find: /^@mermaid-js\/parser$/,
          replacement: resolvePnpmPackage('@mermaid-js/parser', 'dist/mermaid-parser.core.mjs'),
        },
        // Mermaid → d3: pnpm does not hoist these; resolve from .pnpm store (see resolvePnpmPackage).
        { find: /^d3-sankey$/, replacement: resolvePnpmPackage('d3-sankey', 'dist/d3-sankey.js') },
        { find: /^d3-shape$/, replacement: resolvePnpmPackage('d3-shape', 'src/index.js') },
        // Mermaid → dayjs: default import must use ESM build (dayjs.min.js has no default export in Vite).
        { find: /^dayjs$/, replacement: dayjsEsmIndex },
        { find: /^dayjs\/plugin\/(.+?)(?:\.js)?$/, replacement: `${dayjsEsmDir}/plugin/$1/index.js` },
      ],
    },
    optimizeDeps: {
      include: [
        'react',
        'react-dom',
        'react-dom/client',
        'react/jsx-runtime',
        '@tanstack/react-virtual',
        'dayjs',
      ],
      // Mermaid brings ESM-only deps (e.g. @mermaid-js/parser) that can break esbuild pre-bundle
      // in some environments (Tauri beforeDevCommand on Windows). Exclude from optimizeDeps and
      // let Vite handle native ESM in dev.
      exclude: ['mermaid', '@mermaid-js/parser', 'dompurify'],
      esbuildOptions: {
        // Avoid writing react-dom.js.map etc. into deps_temp_* (common Windows EACCES).
        sourcemap: false,
      },
    },
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
    },
    clearScreen: false,
    server: {
      port: viteDevPort,
      strictPort: viteStrictPort,
      host: viteDevHost,
      allowedHosts: true,
      // Tauri runs `cargo build` into src-tauri/target while beforeDevCommand starts Vite.
      // On Windows, watching evopanel_lib.dll during link throws EBUSY and kills dev.
      watch: {
        ignored: ['**/src-tauri/**', '**/target/**'],
      },
      proxy: {
        '/api/langgraph': {
          target: gatewayProxyTarget,
          changeOrigin: true,
          // SSE /runs/stream can run many minutes; 15s proxy timeout would cut the connection.
          timeout: 0,
          proxyTimeout: 0,
          configure: configureGatewayProxy,
        },
        // SSE events endpoint needs longer timeout (or no timeout) for long-lived connections
        '/api/events': {
          target: gatewayProxyTarget,
          changeOrigin: true,
          // Disable timeout for SSE connections (0 = no timeout)
          timeout: 0,
          proxyTimeout: 0,
          ws: true,
          configure: configureGatewayProxy,
        },
        '/api/speech': {
          target: gatewayProxyTarget,
          changeOrigin: true,
          timeout: 0,
          proxyTimeout: 0,
          ws: true,
          configure: configureGatewayProxy,
        },
        '/api': {
          target: gatewayProxyTarget,
          changeOrigin: true,
          timeout: gatewayProxyTimeoutMs,
          proxyTimeout: gatewayProxyTimeoutMs,
          ws: true,
          configure: configureGatewayProxy,
        },
      },
      warmup: {
        clientFiles: ['./src/react/ChatApp.tsx', './src/react/obs/ObsDashboardApp.tsx'],
      },
    },
    envPrefix: ['VITE_', 'TAURI_'],
    build: {
      target: ['es2021', 'chrome100', 'safari13'],
      minify: !process.env.TAURI_DEBUG ? 'esbuild' : false,
      sourcemap: !!process.env.TAURI_DEBUG,
      // Ensure orphaned public/ copies (e.g. old kws models) do not linger across builds.
      emptyOutDir: true,
      commonjsOptions: {
        // @mermaid-js/parser is ESM-only, skip CommonJS transform
        exclude: ['@mermaid-js/parser'],
      },
      rollupOptions: {
        input: {
          main: path.resolve(__dirname, 'index.html'),
          agentTrace: path.resolve(__dirname, 'agent-trace.html'),
          voiceOverlay: path.resolve(__dirname, 'voice-overlay.html'),
        },
      },
    },
  }
})
